# Arena Protocol — 完整代码审计文档

> 提交给 Codex 审计使用
> 项目路径: `d:/TradingBots/claude/moonpay/bnb-trading-agent/`
> 链: Base Chain (chain_id: 8453)
> 语言: TypeScript (monorepo) + Python (策略引擎)

---

## 一、项目概述

Arena Protocol 是一个开放的 AI Agent 交易竞技协议。
多个 AI Agent 基于相同的真实市场数据独立决策，进行模拟交易竞技，结果公开透明可验证，用户通过押注代币参与零和分配。

**核心原则：**
- Agent 不持有任何真实资产，只做模拟交易
- 用户押注的代币锁在合约里，赛季结束按 Agent ROI 的 Softmax 权重重新分配
- 所有决策过程公开，链上可验证（learningRoot / Merkle Proof）
- 任何人可以通过 Webhook 接入自己的 Agent

---

## 二、目录结构

```
bnb-trading-agent/
├── packages/                    # TypeScript monorepo (pnpm workspace)
│   ├── core/                    # 共享类型定义 + 工具函数
│   ├── market-data/             # Crypto.com 行情客户端
│   ├── ai-brain/                # 多LLM决策层
│   ├── scheduler/               # Cron调度引擎
│   ├── ipc-bridge/              # TypeScript ↔ Python TCP通信
│   ├── moonpay-client/          # MoonPay交易执行层
│   └── arena-coordinator/       # (待实现) Arena多Agent编排
├── cli/                         # CLI入口
├── python/                      # Python策略引擎
│   ├── strategies/              # 7个策略 + 混合器
│   ├── signals/                 # 技术指标库
│   ├── models/                  # Pydantic数据模型
│   ├── risk/                    # 风险管理
│   ├── ipc/                     # TCP JSON-RPC服务端
│   └── backtesting/             # 回测框架
├── config/
│   ├── agent.yaml               # 主配置文件
│   ├── tokens.yaml              # 代币配置
│   └── strategies/              # 7个策略的YAML配置
└── state/                       # 运行时状态JSON文件
```

---

## 三、TypeScript 包

### 3.1 @base-agent/core

**路径:** `packages/core/src/`

#### types/market.ts
```typescript
// 核心数据结构，所有包共享

export interface Candle {
  timestamp: string;
  open: number; high: number; low: number; close: number; volume: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: string;
}

export interface TokenMarketData {
  symbol: string;
  price: number;
  change24h: number; volume24h: number; high24h: number; low24h: number;
  candles1h: Candle[];
  candles15m: Candle[];
  orderBook?: OrderBook;
  timestamp: string;
}

export interface MarketSnapshot {
  timestamp: string;
  tokens: Record<string, TokenMarketData>;  // { ETH: ..., cbBTC: ..., USDC: ... }
  portfolio: PortfolioState;
  activeStrategies: string[];
  cycleId: string;
}

export interface PortfolioState {
  walletAddress: string;
  nativeBalance: number;   // ETH
  stableBalance: number;   // USDC
  positions: PortfolioPosition[];
  totalValueUsd: number;
  dailyPnlUsd: number;
  timestamp: string;
}
```

**审计关注点:**
- `MarketSnapshot` 是 TypeScript → Python IPC 的核心数据结构，字段名不可随意更改
- `PortfolioState.nativeBalance` 与 `stableBalance` 注释已修订为 ETH / USDC（Base链）

---

#### types/order.ts
```typescript
export interface SwapRequest {
  walletName: string;
  chain: 'base';           // 固定 base，不可改
  fromToken: string;
  toToken: string;
  fromAmountUsd: number;
  maxSlippageBps: number;
}

export interface Trade {
  id: string;
  strategyId: string;
  action: 'BUY' | 'SELL';
  token: string;
  amountUsd: number;
  priceUsd: number;
  txHash?: string;
  chain: 'base';
  approvedBy: 'auto' | 'ai' | 'user';
  timestamp: string;
  isPaper: boolean;
}
```

**审计关注点:**
- `SwapRequest` 与 `Trade` 的 `chain` 在 Base 迁移后必须保持 `'base'`

---

#### types/strategy.ts
```typescript
export interface StrategySignal {
  strategyId: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'REBALANCE';
  token: string;
  amountUsd?: number;
  targetPrice?: number;
  confidence: number;           // 0.0 - 1.0
  rationale: string;
  requiresAiApproval: boolean;
}

export interface SignalBatch {
  cycleId: string;
  timestamp: string;
  signals: StrategySignal[];
  riskVetoed: boolean;
  vetoReason?: string;
}

export interface ApprovedDecision {
  signal: StrategySignal;
  approvedBy: 'auto' | 'ai';
  finalAmountUsd: number;
  aiDecision?: AiDecision;
}
```

---

#### utils/retry.ts
```typescript
// 指数退避重试，最多3次，初始延迟1000ms
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000,
): Promise<T>
```

---

### 3.2 @base-agent/market-data

**路径:** `packages/market-data/src/`

#### crypto-com-client.ts

**数据源策略:**
- 优先使用 MCP server（在 Claude Code 环境内）
- 降级到 Crypto.com REST API v1

**支持的代币映射:**
```
ETH   → ETHUSD
BTC   → BTCUSD
cbBTC → BTCUSD  (cbBTC 1:1 跟踪 BTC)
USDC  → USDCUSD
```

**方法:**
- `getTicker(token)` → `{ price, change24h, volume24h, high24h, low24h }`
- `getCandlesticks(token, '1h'|'15m')` → `Candle[]`
- `getOrderBook(token, depth)` → `OrderBook`

**审计关注点:**
- MCP 检测逻辑依赖 `globalThis.__mcp__`，在非 Claude Code 环境自动降级 REST
- REST endpoint: `https://api.crypto.com/exchange/v1/public/`

---

#### market-poller.ts

```typescript
// 并行拉取所有 token 的行情，失败时用缓存兜底
async poll(): Promise<Record<string, TokenMarketData>>
```

#### market-cache.ts
- TTL: 60秒
- 防止同周期内重复请求

---

### 3.3 @base-agent/ai-brain

**路径:** `packages/ai-brain/src/`

#### provider-interface.ts

```typescript
// 所有 LLM Provider 必须实现的统一接口
interface ILlmProvider {
  readonly provider: LlmProvider;
  readonly model: string;
  evaluateSignal(
    signal: StrategySignal,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<AiDecision>;
}
```

**支持的 Provider:**
| Provider | 环境变量 | 默认模型 |
|---|---|---|
| anthropic | ANTHROPIC_API_KEY | claude-sonnet-4-6 |
| openai | OPENAI_API_KEY | gpt-4o |
| gemini | GEMINI_API_KEY | gemini-1.5-pro |
| deepseek | DEEPSEEK_API_KEY | deepseek-chat |
| ollama | 无需 | llama3.2 |

---

#### decision-gate.ts

**信号路由逻辑:**
```
信号进入 → 判断是否需要 AI 审批
  需要 AI 的条件（满足任一）:
    ① signal.requiresAiApproval === true
    ② amountUsd > approvalThresholdUsd (默认 $200)
    ③ confidence < confidenceThreshold (默认 0.65)

  不需要 AI → 直接 auto-approve
  需要 AI   → 发给 primary provider
           → 失败时发给 fallback provider
           → 全部失败 → 拒绝信号（安全优先）
```

---

#### prompt-builder.ts

**系统 Prompt 关键内容:**
- 角色定位: "Base Chain 自主交易 Agent 决策引擎"
- 输出格式: 严格 JSON `{ approved, adjustedAmountUsd, reasoning, confidence }`
- 包含当前持仓、近期记忆、市场快照

---

### 3.4 @base-agent/scheduler

#### cron-engine.ts

**完整交易周期:**
```
1. MarketPoller.poll()          → 拉取行情
2. IpcClient.processSnapshot()  → 发给 Python，获取信号批次
3. DecisionGate.processSignals() → AI 审批
4. SwapExecutor.execute()        → 执行（paper/live）
```

**审计关注点:**
- 按 cron 表达式分组触发；每次 cycle 仅执行该表达式对应的策略集合
- 同一个时间点触发多个策略（同 cron）会共享同一份 `MarketSnapshot`（行情只拉一次）

---

### 3.5 @base-agent/ipc-bridge

#### ipc-client.ts

**协议:** TCP JSON-RPC over `127.0.0.1:7890`

**方法:**
```typescript
processSnapshot(snapshot: MarketSnapshot): Promise<SignalBatch>
getHealth(): Promise<{ status: string, strategies: string[] }>
```

**数据转换:** Python snake_case ↔ TypeScript camelCase 自动互转

---

### 3.6 @base-agent/moonpay-client

#### swap-executor.ts

**执行流程:**
```
1. 构建 SwapRequest
2. Paper模式: 跳过模拟，直接生成 paper-{uuid} 的虚拟 txHash
3. Live模式:  先 simulate → 通过后 executeSwap
4. 记录 Trade 到 logs/trades.log
```

**历史 bug（已修复）:**
```typescript
// 第83行 - 应为 'base'
chain: 'bnb',  // ← BUG

// 第106行 - 应为 'base'
chain: 'bnb',  // ← BUG
```

---

## 四、Python 策略引擎

**路径:** `python/`
**通信:** TCP JSON-RPC server on `127.0.0.1:7890`
**依赖:** numpy, pydantic, pyyaml, requests, aiohttp

---

### 4.1 技术指标库

**路径:** `python/signals/technical.py`

| 函数 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `ema(values, period)` | ndarray, int | ndarray | 指数移动平均 |
| `sma(values, period)` | ndarray, int | ndarray | 简单移动平均 |
| `rsi(values, period=14)` | ndarray | ndarray | 相对强弱指数 |
| `ema_crossover(fast, slow)` | ndarray, ndarray | (bool, bool) | 金叉/死叉检测 |
| `bollinger_bands(values, period=20, std=2.0)` | ndarray | (upper, middle, lower) | 布林带 |
| `macd(values, fast=12, slow=26, signal=9)` | ndarray | (macd, signal, hist) | MACD |
| `atr(candles, period=14)` | list[Candle] | ndarray | 平均真实波幅 |
| `percent_b(values, period=20, std=2.0)` | ndarray | ndarray | 布林 %B 位置 |
| `rsi_divergence(candles, rsi_vals, lookback=14)` | list, ndarray | (bool, bool) | RSI 背离检测 |
| `volume_above_avg(candles, lookback, multiplier)` | list, int, float | bool | 成交量过滤 |

**审计关注点:**
- 所有指标为纯 numpy 实现，无外部 TA 库依赖
- `rsi_divergence` 使用简化检测逻辑（argmin/argmax），可能存在误报

---

### 4.2 策略一览

#### Strategy 1: TrendDCAStrategy (`strategies/dca.py`)
```
触发条件:
  价格 > EMA(period)
  连续 min_trend_bars 根 K 线都在 EMA 上方
  RSI 在 [min_rsi, max_rsi] 范围内
  可选：成交量 > 20日均量 × 1.1

信号方向: 只产生 BUY
置信度范围: 0.60 - 0.90
金额范围: base_amount_usd - max_amount_usd（按趋势强度线性插值）
配置文件: config/strategies/dca.yaml
```

#### Strategy 2: TrendSwapStrategy (`strategies/trend_swap.py`)
```
触发条件:
  EMA(fast_p) 和 EMA(slow_p) 发生交叉
  金叉 → BUY
  死叉 → SELL
  可选：成交量确认

信号方向: BUY 或 SELL
置信度范围: 0.70 - 0.95（按 EMA 分离程度）
配置文件: config/strategies/trend_swap.yaml
```

#### Strategy 3: RebalanceStrategy (`strategies/rebalance.py`)
```
触发条件:
  当前仓位 vs 目标配比 偏差 > drift_threshold_pct (默认5%)
  交易金额 > min_trade_usd (默认$20)

信号方向: BUY（欠配）或 SELL（超配）
置信度: 固定 0.75
配置文件: config/strategies/rebalance.yaml
目标配比: ETH 50%, cbBTC 20%, USDC 30%
```

#### Strategy 4: LimitOrderStrategy (`strategies/limit_order.py`)
```
触发条件:
  当前价格进入目标价格 ±tolerance_pct 范围内
  BUY: 价格 <= target_price
  SELL: 价格 >= target_price
  未过期（expires_at 字段）

信号方向: BUY 或 SELL
置信度: 固定 0.90（最高）
配置文件: config/strategies/limit_orders.yaml
```

#### Strategy 5: MeanReversionStrategy (`strategies/mean_reversion.py`)
```
触发条件 BUY:
  %B <= buy_percent_b (默认0.05，即接近下轨)
  RSI <= rsi_oversold (默认35)
  ATR/price >= min_atr_pct (默认0.5%，过滤无波动市场)

触发条件 SELL:
  %B >= sell_percent_b (默认0.95，即接近上轨)
  RSI >= rsi_overbought (默认65)
  且持有该 token 仓位

信号方向: BUY 或 SELL
置信度范围: 0.60 - 0.95
配置文件: config/strategies/mean_reversion.yaml
```

#### Strategy 6: MomentumStrategy (`strategies/momentum.py`)
```
触发条件 BUY:
  MACD line 从下向上穿越 signal line（金叉）
  histogram > 0 且 hist/price >= min_histogram_pct
  ROC(period) >= min_roc_pct (默认2%)
  RSI 在 [rsi_min, rsi_max] = [40, 75]
  可选：成交量 > 均量 × 1.2

触发条件 SELL:
  MACD line 从上向下穿越 signal line（死叉）
  histogram < 0
  ROC(period) <= -min_roc_pct

信号方向: BUY 或 SELL
置信度范围: 0.60 - 0.95
配置文件: config/strategies/momentum.yaml
```

#### Strategy 7: RSIDivergenceStrategy (`strategies/rsi_divergence.py`)
```
触发条件 BUY (bullish divergence):
  价格在近 lookback 根 K 线内创新低
  但 RSI 在同期高于前低点 > 3pts
  RSI 当前值 <= rsi_oversold_threshold (默认45)

触发条件 SELL (bearish divergence):
  价格在近 lookback 根 K 线内创新高
  但 RSI 在同期低于前高点 > 3pts
  RSI 当前值 >= rsi_overbought_threshold (默认55)

信号方向: BUY 或 SELL
置信度范围: 0.68 - 0.92
配置文件: config/strategies/rsi_divergence.yaml
```

---

### 4.3 WeightedStrategyMixer (`strategies/mixer.py`)

**用途:** Arena 中每个 Agent 同时运行多个策略，信号需要合并

**合并逻辑:**
```
1. 收集所有策略的信号，记录来源权重
2. 检测冲突（同 token，方向相反）
   → 计算双方加权置信度总分
   → 高分方获胜，低分方丢弃
3. 合并同方向信号
   → 置信度: 加权平均
   → 金额: 加权平均 × 协同因子(协同越多金额越大，上限 1.5x)
4. requires_ai_approval: 任一策略要求 → 合并信号也要求
5. 权重自动归一化（支持任意权重值）
```

---

### 4.4 RiskManager (`risk/manager.py`)

**前置检查（按顺序）:**
```
1. 单笔金额 > max_position_size_usd (默认$500) → 拒绝
2. 总敞口 > max_total_exposure_usd (默认$3000) → 拒绝
3. 今日亏损 > max_daily_loss_usd (默认$150) → 拒绝
4. 同 token 上次交易距今 < cooldown_minutes (默认5分钟) → 拒绝
5. 全部通过 → 允许
```

---

### 4.5 IPC Server (`ipc/server.py`)

**协议:** JSON-RPC over TCP `127.0.0.1:7890`

**方法:**
```python
process_snapshot(snapshot: dict) → SignalBatch
  1. 反序列化 MarketSnapshot
  2. 串行运行所有启用且被 activeStrategies 命中的策略
  3. 汇总信号，经过 RiskManager 过滤
  4. 返回 SignalBatch（含 risk_vetoed 标志）

get_health() → { status: "ok", strategies: [...] }
```

---

## 五、配置文件

### config/agent.yaml（主配置）

```yaml
agent:
  id: "base-trading-agent-v1"
  mode: "paper"              # paper | live

chain:
  chain_id: 8453             # Base Mainnet
  rpc_url: "${BASE_RPC_URL}"

strategies:                  # 7个策略全部已配置
  dca:           enabled: true,  schedule: "*/30 * * * *"
  limit_orders:  enabled: true,  schedule: "*/1 * * * *"
  rebalance:     enabled: false, schedule: "0 */6 * * *"
  trend_swap:    enabled: true,  schedule: "*/15 * * * *"
  mean_reversion: enabled: true, schedule: "*/15 * * * *"
  momentum:      enabled: true,  schedule: "*/15 * * * *"
  rsi_divergence: enabled: true, schedule: "*/30 * * * *"

ai:
  provider: openai / gpt-4o   # 默认
  approval_threshold_usd: 200
  confidence_threshold: 0.65

risk:
  max_position_size_usd: 500
  max_total_exposure_usd: 3000
  max_daily_loss_usd: 150
  max_drawdown_pct: 15.0
  cooldown_minutes: 5
```

### config/tokens.yaml

```yaml
tokens:
  ETH:
    chain: base
    is_native: true
    decimals: 18
    crypto_com_instrument: ETHUSD
  USDC:
    chain: base
    contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    decimals: 6
  cbBTC:
    chain: base
    contract: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"
    decimals: 8
    crypto_com_instrument: BTCUSD
```

---

## 六、数据流

```
TypeScript CLI (start)
  │
  ├── 读取 config/agent.yaml + config/tokens.yaml
  ├── 初始化 MemoryManager, MoonpayMcpClient, SwapExecutor, DecisionGate
  ├── 连接 Python IPC (127.0.0.1:7890)
  └── 启动 CronEngine

CronEngine (每次触发)
  │
  ├── 1. MarketPoller.poll()
  │      └── CryptoComClient (MCP优先 / REST降级)
  │          → 获取 ETH/cbBTC/USDC 的 ticker + candles + orderbook
  │
  ├── 2. IpcClient.processSnapshot(snapshot)
  │      └── Python IPC Server
  │          ├── 按 activeStrategies 串行生成信号
  │          ├── RiskManager 过滤
  │          └── 返回 SignalBatch
  │
  ├── 3. DecisionGate.processSignals(batch)
  │      ├── 低风险信号 → auto-approve
  │      └── 高风险信号 → LLM审批 (primary → fallback → reject)
  │
  └── 4. SwapExecutor.execute(decisions)
         ├── Paper模式: 记录日志，生成虚拟 txHash
         └── Live模式:  MoonPay MCP 执行真实交易
```

---

## 七、已知问题（需修复）

| 编号 | 文件 | 行号 | 问题 | 严重程度 |
|---|---|---|---|---|
| 1 | `python/strategies/rsi_divergence.py` | 全文 | 背离检测使用 argmin/argmax，在横盘市场可能产生假信号 | 低 |
| 2 | `packages/arena-coordinator/` | — | 尚未实现（Arena 核心模块缺失） | 高 |
| 3 | `packages/api-server/` | — | 路由未实现 | 高 |

### 已在 2026-02-24 修复
- `packages/moonpay-client/src/swap-executor.ts`：`chain: 'bnb'` 已统一修复为 `'base'`
- `packages/core/src/types/market.ts`：`nativeBalance` / `stableBalance` 注释已修订为 ETH / USDC
- `packages/scheduler/src/cron-engine.ts`：按 cron 分组后仅触发对应策略，避免每个计划任务都跑全部策略

---

## 八、安全注意事项

1. **私钥管理**: 项目本身不管理私钥，所有链上操作通过 MoonPay MCP 代理执行
2. **Paper模式**: 默认 `mode: paper`，不执行真实交易，需明确改为 `live` 才会动真钱
3. **AI审批门槛**: 超过 $200 或置信度低于 0.65 的信号必须经过 LLM 二次确认
4. **风险管理**: Python 层有独立的风险管理器，TypeScript 层的 AI 审批是第二道防线
5. **IPC安全**: IPC 只监听 `127.0.0.1`（本地回环），不对外暴露
6. **环境变量**: API Key 通过环境变量注入，不写入代码

---

## 九、Arena 模块设计（待实现）

### 需要新增的文件

```
packages/arena-coordinator/src/
  interfaces/
    i-arena-agent.ts          Agent接口（固定，不可随意修改）
    i-settlement.ts           结算算法接口（可插拔）
    i-arena-hook.ts           生命周期钩子接口
  types/
    arena-signal.ts           Arena信号类型
    virtual-portfolio.ts      虚拟持仓类型
    season.ts                 赛季类型
  agents/
    internal-agent.ts         内置Agent（复用现有策略引擎）
    webhook-agent.ts          Webhook外部Agent适配器
  settlement/
    softmax.ts                默认Softmax结算算法
  arena-engine.ts             主编排引擎
  virtual-portfolio.ts        虚拟持仓管理

config/arena.yaml             Arena主配置（Agent列表可动态扩展）
```

### 核心接口（固定，审计重点）

```typescript
// 任何 Agent 都必须实现，内部和外部统一
interface IArenaAgent {
  readonly id: string
  readonly name: string
  readonly owner: string
  decide(
    snapshot: MarketSnapshot,
    portfolio: VirtualPortfolio,
  ): Promise<ArenaSignal[]>
  onCycleResult?(signals: ArenaSignal[], executed: VirtualTrade[]): Promise<void>
}

// 结算算法接口，可插拔替换
interface ISettlementAlgorithm {
  readonly algorithm_id: string
  calculate_weights(
    results: AgentSeasonResult[],  // 只传有效完成赛季的Agent
    params: SettlementParams,
  ): Record<string, number>        // agent_id → 权重(0-1，总和=1)
}

// 生命周期钩子
interface IArenaHook {
  on_season_start?(season: Season): Promise<void>
  on_cycle_complete?(cycle: CycleResult): Promise<void>
  on_season_end?(result: SeasonResult): Promise<void>
  on_agent_join?(agent: IArenaAgent): Promise<void>
}
```

### 结算逻辑（零和）

```
赛季结束时:
  1. 判定有效Agent（信号数 >= 3 且执行过 >= 1 笔虚拟交易）
  2. 无效Agent的押注 → 全额退还（不参与分配）
  3. 有效Agent用Softmax计算权重:
       w_i = exp(ROI_i × T) / Σ exp(ROI_j × T)
       T = temperature（默认2.0，可配置）
  4. 总有效池子按权重重新分配
  5. 验证: Σ分配额 = 有效池子总量（零和）
```

---

## 十、智能合约设计（待实现，Phase 2）

### 合约列表

| 合约 | 功能 | 标准 |
|---|---|---|
| `ArenaToken.sol` | 竞技代币，1%交易税 | ERC-20 |
| `ArenaVault.sol` | 资金托管，零和分配 | UUPS Upgradeable |
| `ArenaRegistry.sol` | 赛季结果上链 | AccessControl + Timelock |
| `ArenaAgent.sol` | Agent NFA身份 | ERC-721 + BAP-578 |
| `SoftmaxSettlement.sol` | 默认结算算法 | ISettlementLogic |
| `SeasonSettler.sol` | 自动触发结算 | Gelato IAutomate |

### 关键设计点

```
1. ArenaVault 只管钱，不管算法
   → settlementLogic 是可替换的外部合约地址
   → 修改需要经过 TimelockController (48小时延迟)

2. 赛季结算流程:
   链下: 计算ROI → Softmax权重 → 构建leaderboardHash
   链上: ArenaRegistry.settleSeason(hash) → ArenaVault.settle(weights)

3. Agent NFA (BAP-578):
   → learningRoot = keccak256(所有交易决策的Merkle树根)
   → 每N个赛季更新一次
   → vaultURI 指向 IPFS 上的完整历史数据
   → 任何人可用 Merkle Proof 验证任意一笔决策

4. ERC-6551 TBA:
   → 每个 Agent NFA 有自己的链上钱包
   → 接收赛季荣誉奖励（不是竞技押注资金）
   → 竞技押注资金永远在 ArenaVault 里

5. Gelato 自动化:
   → checker(): season.endTime <= now && !season.settled
   → 自动调用 ArenaVault.settle()
   → 无需人工操作

6. Chainlink Price Feed:
   → ETH/USD: 0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70
   → BTC/USD: 0xCCADC697c55bbB68dc5bCdf8d3CBe83CdD4E071E
   → 验证 Arena 内价格数据是否偏离链上预言机（防作弊）
```

---

## 十一、Webhook 外部接入规范（固定接口）

```
POST {外部服务器URL}
Headers:
  Content-Type: application/json
  X-Arena-Version: 1.0
  X-Arena-Signature: HMAC-SHA256(body, secret)

请求体（每15分钟发送一次）:
{
  "version": "1.0",          // 版本号，向后兼容
  "cycle_id": "uuid",
  "timestamp": "ISO8601",
  "snapshot": {
    "tokens": {
      "ETH":   { "price": 2450.5, "change24h": 0.023, ... "candles1h": [...] },
      "cbBTC": { ... },
      "USDC":  { ... }
    }
  },
  "portfolio": {
    "cash_usd": 8200,
    "positions": [{ "token": "ETH", "amount": 0.5, "current_value_usd": 1225 }],
    "total_value_usd": 9425,
    "roi": -0.0575
  }
}

响应体（5秒内返回，否则视为超时）:
{
  "signals": [
    {
      "token": "ETH",           // 必填
      "action": "BUY",          // 必填: BUY | SELL | HOLD
      "amount_usd": 100,        // HOLD时为null
      "confidence": 0.8,        // 必填: 0.0-1.0
      "reason": "说明理由"       // 必填，公开展示
    }
  ]
}
```

---

## 十二、路线图

```
Phase 1（当前）— 单Agent完整运行
  ✅ 7个策略 + 技术指标库
  ✅ 多策略权重混合器
  ✅ 多LLM决策层（5个Provider）
  ✅ Paper/Live双模式执行
  ✅ Base Chain迁移
  ⬜ Arena引擎（多Agent并行）
  ⬜ API Server + WebSocket
  ⬜ arena.yaml配置

Phase 2 — Arena + 链上化
  ⬜ ArenaToken + ArenaVault合约
  ⬜ ArenaRegistry + NFA合约
  ⬜ Gelato自动结算
  ⬜ Webhook自助注册
  ⬜ 实时排行榜前端

Phase 3 — 生态开放
  ⬜ ERC-6551 TBA
  ⬜ IPFS历史存储
  ⬜ Chainlink价格验证
  ⬜ 链上自治注册（质押即参赛）
  ⬜ 跟单功能
```

---

*文档生成时间: 2026-02-24*
*代码版本: Base Chain Migration Complete, Strategy Engine v2 (7 strategies)*
