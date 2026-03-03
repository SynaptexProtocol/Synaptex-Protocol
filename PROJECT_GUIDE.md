# Arena Protocol — 项目全景说明

> 本文档面向接手此代码库的工程师（包括 Codex）。
> 目标：读完本文后，你能够独立理解每个文件在做什么、为什么这样设计、如何修改和扩展。

---

## 第一章：这个项目在做什么

### 一句话描述

Arena Protocol 是一个 **AI Agent 模拟交易竞技场**：多个 AI Agent 同时用相同的真实行情做模拟交易，赛季结束后按各自的模拟收益率，用 Softmax 算法重新分配用户押注的代币。

### 为什么要做这个

这是一个部署在 Base Chain（以太坊 L2）上的协议。用户把 ARENA 代币押注给自己看好的 Agent，就像押注一支球队。赛季结束时：

- 押注赢家的用户 → 多拿代币
- 押注输家的用户 → 少拿代币
- 总量不变（零和）

团队的盈利方式：持有大量初始 ARENA 代币，协议越热门，代币越值钱。没有平台抽成，没有手续费。

### 关键设计原则

1. **Agent 只做模拟交易**，不碰真实资金。真实资金（ARENA 代币）只在合约里。
2. **行情数据公平共享**：所有 Agent 在同一时刻收到完全相同的 MarketSnapshot，不允许信息差。
3. **开放接入**：任何人都可以通过 Webhook 接入自己的 Agent，接口固定，向后兼容。
4. **链上可验证**：每个 Agent 的每条交易信号都会生成 SHA-256 哈希，汇聚成 Merkle Root 上链，不可篡改。

---

## 第二章：整体架构

### 两个进程，一个协议

系统由两个独立进程组成，通过 TCP JSON-RPC 通信：

```
┌─────────────────────────────────────────────┐
│  Node.js 进程（TypeScript）                  │
│                                             │
│  CLI → ArenaEngine                          │
│         ↓ 每15分钟                          │
│  MarketPoller → MarketSnapshot              │
│         ↓ 并行分发给所有 Agent              │
│  InternalAgent → IpcClient ──────────────── │──→  Python进程
│  InternalAgent → IpcClient ──────────────── │──→  （共享，同一端口）
│  WebhookAgent  → HTTP POST ──────────────── │──→  外部服务器
│         ↓                                   │
│  VirtualPortfolio 更新                      │
│  Leaderboard 更新                           │
│  API Server 广播 WebSocket 事件             │
└─────────────────────────────────────────────┘
                   ↕ TCP 127.0.0.1:7890
┌─────────────────────────────────────────────┐
│  Python 进程                                │
│                                             │
│  IPCServer → StrategyEngine.process()       │
│    → 串行执行各策略 generate_signals()      │
│    → RiskManager.check_pre_trade() 逐条过滤 │
│    → 返回 SignalBatch                       │
└─────────────────────────────────────────────┘
```

### 为什么拆成两个进程

- TypeScript 负责：调度、IPC 通信、AI 审批（LLM 调用）、状态管理、API 服务
- Python 负责：技术指标计算（NumPy/pandas 生态）、策略信号生成、风险过滤

两个进程可以独立重启。Python 引擎崩溃不影响 Node.js 继续运行（IPC 报错时该 Agent 本轮跳过）。

---

## 第三章：数据流 — 一次完整的 Arena 周期

以下是每 15 分钟触发一次的完整执行链路：

### Step 1：拉取行情

```
ArenaEngine.runCycleWithSnapshot(snapshot)
  ← snapshot 由外部（CLI）通过 MarketPoller.poll() 生成
```

`MarketSnapshot` 的结构（定义在 `packages/core/src/types/market.ts`）：

```typescript
{
  timestamp: "2026-02-24T10:00:00Z",
  cycleId: "uuid",
  tokens: {
    "ETH":   { price: 2450, change24h: 0.02, candles1h: [...50根], candles15m: [...50根], ... },
    "cbBTC": { price: 95000, ... },
    "USDC":  { price: 1.0, ... }
  },
  portfolio: { ... },      // Arena 模式下是空的占位符
  activeStrategies: []     // InternalAgent 会按自己的 strategyWeights 覆盖这个字段
}
```

**关键约束**：所有 Agent 收到的是同一个 snapshot 对象，不可修改，确保公平。

### Step 2：并行分发给所有 Agent

```typescript
// arena-engine.ts
const results = await Promise.allSettled(
  [...this.agents.entries()].map(([id, state]) =>
    this.runAgentCycle(id, state, snapshot, currentPrices)
  )
);
```

`Promise.allSettled` 的意义：**任何一个 Agent 报错，不影响其他 Agent 继续执行**。这是错误隔离的核心机制。

### Step 3a：InternalAgent 的执行路径

```
InternalAgent.decide(snapshot, portfolio)
  ↓
  注入 strategyWeights 到 snapshot.activeStrategies
  （例如 thunder agent: ["trend_swap", "momentum"]）
  ↓
  IpcClient.processSnapshot(agentSnapshot)
  ↓ TCP JSON-RPC → Python
  ↓
  StrategyEngine.process(snapshot):
    for strategy in strategies:
      if strategy.id not in snapshot.activeStrategies: skip
      signals = strategy.generate_signals(snapshot, portfolio)
    for signal in all_signals:
      ok = RiskManager.check_pre_trade(signal, portfolio)
      if ok: approved.append(signal)
    return SignalBatch
  ↓ 返回 TypeScript
  ↓
  DecisionGate.processSignals(batch, snapshot, memory)
    for signal in batch.signals:
      if needsAiApproval:  # amount > 阈值 or confidence < 阈值
        aiDecision = llm.evaluateSignal(signal, snapshot, memory)
        if not approved: skip
      → ApprovedDecision[]
  ↓
  转换为 ArenaSignal[] 返回
```

**关键细节**：
- 每个 InternalAgent 有自己的 `strategyWeights`（如 `{ trend_swap: 0.7, momentum: 0.3 }`）
- 这个权重通过 `activeStrategies` 字段传给 Python，Python 只运行列表里的策略
- `WeightedStrategyMixer` 是**工具类**，不在默认流程里；当前 StrategyEngine 简单串行执行，不加权合并

### Step 3b：WebhookAgent 的执行路径

```
WebhookAgent.decide(snapshot, portfolio)
  ↓
  构建 WebhookRequest（含 snapshot 精简版 + portfolio）
  ↓
  HMAC-SHA256 签名（body + secret）
  ↓
  HTTP POST webhookUrl，超时 5 秒
  ↓
  解析响应 { signals: [...] }
  ↓
  归一化为 ArenaSignal[] 返回
```

**失败处理**：连续 3 次超时或报错 → `consecutiveFailures >= 3` → `isDisqualified() = true` → 后续周期直接返回空数组，不再调用。

### Step 4：更新虚拟持仓

```typescript
// arena-engine.ts → runAgentCycle()
for (const sig of signals) {
  state.signals.push(sig);               // 记录信号（用于 Merkle）
  const trade = state.portfolio.applySignal(sig, currentPrices);  // 执行虚拟交易
  if (trade) executed.push(trade);
}
state.portfolio.updatePrices(currentPrices);  // 用最新价格刷新 ROI
```

`VirtualPortfolioManager.applySignal()` 的逻辑（`virtual-portfolio.ts`）：
- BUY：从 `cash_usd` 扣款，增加对应 token 的持仓量，更新 `avg_cost_usd`
- SELL：减少持仓，增加 `cash_usd`；持仓不足时按实际持仓量成交（不做空）
- HOLD / amount_usd=null：跳过

ROI 计算：`(cash + Σ position_value) / starting_value - 1`

### Step 5：更新排行榜和广播

```typescript
this.saveLeaderboard();       // → state/arena/leaderboard.json
this.seasonManager.incrementCycle();
this.fireHook(h => h.onCycleComplete?.(event));
// API Server 收到 hook → WsBroadcaster.broadcast('cycle_complete', ...)
//                       WsBroadcaster.broadcast('leaderboard', ...)
```

---

## 第四章：赛季结算

### 触发时机

`SeasonManager.isExpired()` 在每次 `runCycleWithSnapshot()` 开头检查：当前时间 >= `season.end_time`。

### 结算步骤

```
ArenaEngine.settle()
  ↓
  1. SeasonManager.transitionTo('settling')

  2. 遍历所有 Agent，计算 AgentSeasonResult：
     { agent_id, roi, signal_count, trade_count, status }

  3. 有效性判定：
     isValid = signal_count >= 3 && trade_count >= 1 && status != 'disqualified'

  4. 只对有效 Agent 运行 Softmax：
     w_i = exp(ROI_i × T) / Σ exp(ROI_j × T)     T = 2.0 (默认)
     无效 Agent: weight = 0（链上合约按 weight=0 全额退还押注）

  5. buildLeaderboard() → entries 按 ROI 降序排列 → leaderboard_hash (SHA-256)

  6. buildMerkleRoot(所有信号的 SHA-256 叶子节点) → merkle_root
     这个 root 会上链，用于验证任何一条信号的真实性

  7. SeasonManager.transitionTo('settled', { leaderboard_hash })
     归档到 state/arena/seasons/season-{id}.json

  8. 触发 onSeasonEnd 钩子（链上合约调用 → Phase 2 未实现）
```

### Softmax 温度参数的意义

`T = 2.0` 是默认值，可在 `config/arena.yaml` 的 `settlement.temperature` 调整：
- T = 0.5：收益率差距很小也能赢，温和分配
- T = 2.0：收益率高的 Agent 得到显著更多份额（默认）
- T = 5.0：接近赢家通吃

---

## 第五章：Python 策略引擎详解

### 进程启动

```python
# python/main.py
strategies = build_strategies(agent_cfg, base_dir)
# 从 agent.yaml 读取 enabled=true 的策略，每个策略有自己的 yaml 配置文件
# 实例化: TrendDCAStrategy(cfg), TrendSwapStrategy(cfg), ...

risk = build_risk(agent_cfg)
engine = StrategyEngine(strategies, risk)
server = IPCServer(engine, host, port)
await server.start()  # 监听 7890
```

### 请求处理

```python
# python/ipc/server.py
# 收到 process_snapshot 请求:
snapshot = MarketSnapshot.model_validate(request["params"]["snapshot"])
batch = engine.process(snapshot)
# engine.process() 返回 SignalBatch
```

### StrategyEngine.process() 的完整逻辑

```python
def process(self, snapshot: MarketSnapshot) -> SignalBatch:
    all_signals = []
    for strategy in self.strategies:
        if not strategy.enabled: continue
        if strategy.id not in snapshot.activeStrategies: continue
        # 只运行 TypeScript 侧 InternalAgent 指定的策略
        signals = strategy.generate_signals(snapshot, snapshot.portfolio)
        all_signals.extend(signals)

    approved = []
    for signal in all_signals:
        ok, reason = self.risk.check_pre_trade(signal, snapshot.portfolio)
        if ok:
            approved.append(signal)
        # 不 ok 的信号被丢弃（记录 veto_reason）

    return SignalBatch(
        cycle_id=snapshot.cycleId,
        signals=approved,
        risk_vetoed=(len(approved) < len(all_signals)),
        veto_reason=...
    )
```

**重要**：`WeightedStrategyMixer` 是独立的工具类（`strategies/mixer.py`），`StrategyEngine` 默认**不**使用它。如果你想让某个 Agent 用混合策略模式，需要改 `StrategyEngine.process()` 或在各策略内部调用 mixer。

### 各策略的信号生成逻辑概要

| 策略 | 触发条件 | 信号 |
|------|---------|------|
| `TrendDCAStrategy` | EMA20 > EMA50（上升趋势）+ RSI 不超买 + 成交量放大 | BUY（定额分批） |
| `TrendSwapStrategy` | EMA12/26 金叉 → BUY；死叉 → SELL | BUY/SELL |
| `MeanReversionStrategy` | %B ≤ 0.05（价格触下轨）+ RSI ≤ 35 + ATR 过滤 | BUY；%B ≥ 0.95 → SELL |
| `MomentumStrategy` | MACD 金叉 + 柱状图 > 0 + ROC ≥ 2% + 成交量确认 | BUY；死叉 → SELL |
| `RSIDivergenceStrategy` | 价格创新低但 RSI 不创新低（底背离）→ BUY；顶背离 → SELL | BUY/SELL |
| `RebalanceStrategy` | 持仓比例偏离目标 > 阈值 | BUY/SELL（调仓） |
| `LimitOrderStrategy` | 当前价格穿越设定的限价单触发价 | BUY/SELL |

### 技术指标库（`signals/technical.py`）

所有策略共用的底层指标函数，接受 `np.ndarray` 输入：

```python
ema(values, period)              → ndarray
sma(values, period)              → ndarray
rsi(values, period=14)           → ndarray  (0-100)
bollinger_bands(values, period=20, std_dev=2.0)  → (upper, middle, lower)
macd(values, fast=12, slow=26, signal=9)         → (macd_line, signal_line, histogram)
atr(candles, period=14)          → ndarray  (绝对波动幅度)
percent_b(values, ...)           → ndarray  (0=下轨, 1=上轨)
rsi_divergence(candles, rsi_vals, lookback=14)   → (bullish: bool, bearish: bool)
volume_above_avg(candles, period=20, multiplier=1.5) → bool
```

### 风险管理（`risk/manager.py`）

`RiskManager.check_pre_trade(signal, portfolio)` 返回 `(bool, reason)`：

| 检查项 | 配置参数 | 默认值 |
|--------|---------|--------|
| 单笔最大金额 | `max_position_size_usd` | $500 |
| 总持仓敞口 | `max_total_exposure_usd` | $3000 |
| 日亏损上限 | `max_daily_loss_usd` | $150 |
| 最大回撤 | `max_drawdown_pct` | 15% |
| 同代币冷却期 | `cooldown_minutes` | 5分钟 |

---

## 第六章：TypeScript 层各包详解

### @base-agent/core — 共享类型

这个包**只有类型定义和工具函数**，没有任何业务逻辑。所有包都依赖它。

**最关键的类型**（字段名不可修改，IPC 和链上都依赖）：

```typescript
// market.ts
interface MarketSnapshot {
  timestamp: string;
  tokens: Record<string, TokenMarketData>;  // key = "ETH" / "cbBTC" / "USDC"
  portfolio: PortfolioState;
  activeStrategies: string[];   // 注入给 Python，控制运行哪些策略
  cycleId: string;
}

// strategy.ts
interface StrategySignal {
  strategyId: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'REBALANCE';
  token: string;
  amountUsd?: number;
  confidence: number;        // 0.0-1.0
  rationale: string;
  requiresAiApproval: boolean;
}

interface SignalBatch {
  cycleId: string;
  timestamp: string;
  signals: StrategySignal[];
  riskVetoed: boolean;
  vetoReason?: string;
}
```

Python 侧的字段名是 snake_case（`strategy_id`, `amount_usd`），`ipc-client.ts` 里的 `normalizeSignalBatch()` 函数负责转换。

### @base-agent/ai-brain — 多 LLM 统一接口

核心是 `DecisionGate`，它决定一条信号是"自动通过"还是"需要 LLM 审核"：

```typescript
// decision-gate.ts
private needsAi(signal):
  return signal.requiresAiApproval
      || signal.amountUsd > approvalThresholdUsd    // 默认 $200
      || signal.confidence < confidenceThreshold     // 默认 0.65
```

如果需要 AI 审核：
1. 发给 primary LLM（`evaluateSignal(signal, snapshot, memory)`）
2. 如果 primary 失败 → 发给 fallback LLM
3. 如果全部失败 → **拒绝信号**（安全优先，宁可不交易）

切换 LLM：只改 `config/agent.yaml` 的 `ai.provider`，不改代码。

### @base-agent/ipc-bridge — IPC 客户端

```typescript
// ipc-client.ts
// 协议：每行一个 JSON，\n 分隔（newline-delimited JSON）
// 发送:
{ "jsonrpc": "2.0", "method": "process_snapshot", "id": "cycle-xxx", "params": { snapshot } }
// 接收:
{ "jsonrpc": "2.0", "id": "cycle-xxx", "result": { ...SignalBatch... } }
```

`IpcClient` 维护一个 `pendingRequests: Map<id, callback>` 处理并发请求。每个请求有独立 timeout（默认 5000ms）。

### @base-agent/market-data — 行情拉取

```typescript
// market-poller.ts
MarketPoller.poll() → Record<string, TokenMarketData>
// 内部调用 CryptoCom API:
//   getTicker(symbol) → 价格、涨跌幅、24h 高低
//   getCandlesticks(symbol, '1h', 50) → 50根小时线
//   getCandlesticks(symbol, '15m', 50) → 50根15分钟线
```

Arena 模式下，这个 `poll()` 在 `cli/src/commands/arena.ts` 里被调用，结果包装成 `MarketSnapshot` 传给 `ArenaEngine.runCycleWithSnapshot()`。

### @base-agent/scheduler — 单 Agent 调度（非 Arena 模式）

`CronEngine` 是**单 Agent 模式**（`base-agent start`）使用的。Arena 模式不用它，Arena 有自己的 `setInterval` 循环。

```typescript
// cron-engine.ts 核心流程:
// 1. MarketPoller.poll() 拉取行情
// 2. IpcClient.processSnapshot() → Python
// 3. DecisionGate.processSignals() → AI 审批
// 4. SwapExecutor.execute() → MoonPay 执行（paper/live）
```

### @base-agent/moonpay-client — 交易执行

在 Arena 模式下**不使用**这个包（Arena 只做虚拟交易）。只有单 Agent 模式（`base-agent start`）才会通过 MoonPay 执行真实或 paper 交易。

```typescript
// swap-executor.ts
// paper 模式: 生成 paper-{uuid} 假 txHash，写日志，不调用 MoonPay
// live 模式: 先 simulate → 通过后 executeSwap → 记录 Trade
// chain 固定为 'base'（Base Chain）
```

### @base-agent/arena-coordinator — Arena 核心

这是整个项目最重要的包，上面第三、四章已有详细描述。补充几个细节：

**ArenaEngine 的 `getSnapshot` 注入模式**

`ArenaEngine` 自己不知道如何拉取行情，需要外部注入 `getSnapshot` 函数：

```typescript
// arena-engine.ts 构造函数接受:
getSnapshot: () => Promise<MarketSnapshot>
// 调用时机: 每个 setInterval 周期，由内部 runCycle() 调用
```

这样设计的好处：测试时可以注入假数据；未来可以换数据源，不改 engine 代码。

**状态持久化**

所有状态都写到磁盘（`state/arena/`），进程重启后可以恢复：

```
state/arena/
  season_current.json     ← SeasonManager 读写，记录赛季状态和结束时间
  leaderboard.json        ← 每个周期更新
  agent-thunder.json      ← 每个周期更新（虚拟持仓快照）
  agent-frost.json
  agent-aurora.json
  seasons/
    season-abc123.json    ← 赛季结束后归档，永久保留
```

### @base-agent/api-server — REST + WebSocket

```typescript
// server.ts
// createApiServer(engine, config) 返回 { start, stop, broadcaster }
// 关键：在 createApiServer 内部给 engine 注册 hook：
engine.addHook({
  onCycleComplete(event) { broadcaster.broadcast('cycle_complete', event); },
  onSeasonStart(season)  { broadcaster.broadcast('season_start', season); },
  onSeasonEnd(season, lb){ broadcaster.broadcast('season_end', { season, lb }); },
});
// ArenaEngine 在 fireHook() 时调用这些 hook，API Server 自动广播
```

WebSocket 客户端连接 `ws://host:port/ws` 后立即收到 `{ type: 'connected' }` 确认，之后被动接收事件推送。

---

## 第七章：配置系统

### 两个核心配置文件

**`config/agent.yaml`** — 单 Agent 模式 + 共享参数：
- `agent.mode`: `paper` 或 `live`（paper 模式下 MoonPay 不真实执行）
- `ai.provider`: 主 LLM（anthropic/openai/gemini/deepseek/ollama）
- `ai.approval_threshold_usd`: 超过此金额的信号需 AI 审批（默认 $200）
- `ai.confidence_threshold`: 低于此置信度的信号需 AI 审批（默认 0.65）
- `risk.*`: 风险限制参数
- `ipc.*`: Python 引擎连接配置
- `strategies.*`: 各策略的 enabled 状态和调度 cron 表达式

**`config/arena.yaml`** — Arena 专用：
- `arena.*`: 赛季参数（时长、虚拟资金、周期间隔）
- `settlement.*`: 结算算法和温度参数
- `agents[]`: Agent 列表，每个包含 id/name/type/llm/strategy_weights

### 添加新 Agent（只改配置，不改代码）

在 `config/arena.yaml` 的 `agents` 数组追加：

```yaml
# Internal Agent（复用现有 Python 引擎）
- id: "viper"
  name: "Viper"
  enabled: true
  owner: "arena-internal"
  type: "internal"
  llm:
    provider: "deepseek"
    model: "deepseek-chat"
  strategy_weights:
    mean_reversion: 0.5
    rsi_divergence: 0.5

# Webhook Agent（外部服务器）
- id: "external-alpha"
  name: "Alpha"
  enabled: true
  owner: "0xYourWalletAddress"
  type: "webhook"
  webhook_url: "https://your-server.com/arena/decide"
  webhook_secret: "your-32-char-hmac-secret"
```

重启 `base-agent arena start` 即可生效。

### 添加新策略（只加文件，不改现有代码）

1. 在 `python/strategies/` 新建 `my_strategy.py`，继承 `BaseStrategy`
2. 在 `config/strategies/my_strategy.yaml` 写参数
3. 在 `python/strategies/__init__.py` 导出
4. 在 `python/main.py` 的 `strategy_classes` 字典里注册
5. 在 `config/agent.yaml` 的 `strategies` 里启用

---

## 第八章：不可修改的契约

以下接口和类型一旦确定不可修改字段名，否则：
- IPC 通信会因字段名不匹配而失败（Python ↔ TypeScript）
- 链上 Merkle 验证会因哈希不一致而失败

### ArenaSignal（链上 Merkle 叶子节点，字段名固定）

```typescript
interface ArenaSignal {
  agent_id: string        // 不可改
  token: 'ETH' | 'cbBTC' | 'USDC'   // 不可改
  action: 'BUY' | 'SELL' | 'HOLD'   // 不可改
  amount_usd: number | null          // HOLD 时为 null
  confidence: number      // 0.0-1.0
  reason: string
  timestamp: string       // ISO8601
  cycle_id: string
}
```

`signalToLeaf()` 用确定性的字段顺序 JSON 序列化后做 SHA-256，字段顺序改变会导致哈希变化。

### IArenaAgent 接口（所有 Agent 必须实现，签名固定）

```typescript
interface IArenaAgent {
  readonly id: string
  readonly name: string
  readonly owner: string
  readonly type: 'internal' | 'webhook'
  decide(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): Promise<ArenaSignal[]>
  onCycleResult?(signals: ArenaSignal[], executed: VirtualTrade[]): Promise<void>
}
```

### Webhook 请求/响应格式（外部开发者依赖，不可破坏兼容性）

```json
// 请求（Arena → 外部服务器）
{
  "version": "1.0",
  "cycle_id": "uuid",
  "timestamp": "ISO8601",
  "snapshot": { "tokens": { "ETH": { "price": ..., "change24h": ..., "candles1h": [...] } } },
  "portfolio": { "cash_usd": ..., "positions": [...], "total_value_usd": ..., "roi": ... }
}

// 响应（外部服务器 → Arena，5秒内）
{
  "signals": [
    { "token": "ETH", "action": "BUY", "amount_usd": 100, "confidence": 0.8, "reason": "..." }
  ]
}
```

### IPC 协议（TypeScript ↔ Python，字段名固定）

```
发送: { "jsonrpc": "2.0", "method": "process_snapshot", "id": "...", "params": { "snapshot": {...} } }
接收: { "jsonrpc": "2.0", "id": "...", "result": {
  "cycle_id": "...",
  "timestamp": "...",
  "signals": [{ "strategy_id": "...", "action": "...", "token": "...", "amount_usd": ...,
                "confidence": ..., "rationale": "...", "requires_ai_approval": ... }],
  "risk_vetoed": false,
  "veto_reason": null
}}
```

注意 Python 侧用 snake_case，TypeScript 侧 `normalizeSignalBatch()` 转换为 camelCase。

---

## 第九章：下一步工作（Phase 2）

以下功能**已预留接口但未实现**：

### 1. 链上同步（最高优先级）

`arena-engine.ts` 的 `settle()` 方法末尾触发 `onSeasonEnd` hook，这里应该调用智能合约：

```typescript
// 伪代码，需要实现
onSeasonEnd: async (season, leaderboard) => {
  await arenaContract.submitSeasonResult({
    seasonId: season.id,
    merkleRoot: merkle_root,
    leaderboardHash: season.leaderboard_hash,
    weights: allWeights,  // agent_id → weight
  });
}
```

需要部署的合约：
- `ArenaToken.sol` — ERC-20 ARENA 代币
- `ArenaVault.sol` — 用户押注/结算合约（UUPS 可升级）
- `SeasonSettler.sol` — 接收 merkleRoot + weights，执行代币分配

### 2. 独立 MarketPoller（Arena 引擎应自己管理行情拉取）

当前 `ArenaEngine` 通过 `getSnapshot` 注入函数获取行情（由 CLI 提供）。理想情况下 `ArenaEngine` 应该内置 MarketPoller，不依赖外部注入。

### 3. Leaderboard 历史接口

`GET /api/v1/leaderboard/history` 路由已规划但未实现。数据在 `state/arena/seasons/*.json`，读取并返回即可。

### 4. WebSocket 认证

当前 `ws/broadcaster.ts` 没有认证，任何人连接 `/ws` 都能收到事件。生产环境需要加 token 验证。

### 5. `WeightedStrategyMixer` 集成

`mixer.py` 的加权混合逻辑目前是独立工具类，可以考虑：
- 让 `StrategyEngine` 在同一 Agent 的多个策略之间调用 mixer
- 将 `strategy_weights` 从 TypeScript 传到 Python，Python 用 mixer 合并信号

---

## 第十章：快速上手

### 环境要求

- Node.js v20（推荐用 nvm）
- Python 3.11
- pnpm v9

### 启动步骤

```bash
# 1. 安装依赖
pnpm install
pip install -r python/requirements.txt  # numpy, pydantic, PyYAML

# 2. 配置环境变量
cp .env.example .env
# 填写: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY（按需）
# BASE_RPC_URL（单Agent模式需要，Arena模式不需要）

# 3. 构建 TypeScript
pnpm build

# 4. 启动 Python 引擎（终端1）
cd python
python main.py --config ../config/agent.yaml

# 5. 启动 Arena 引擎（终端2）
node cli/dist/index.js arena start --config config/arena.yaml

# 6. 查看状态
node cli/dist/index.js arena leaderboard

# REST API
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/v1/leaderboard

# WebSocket
wscat -c ws://127.0.0.1:3000/ws
```

### Windows 特别说明（Git Bash）

```bash
# Node.js 路径（nvm v20.20.0）
export PATH="/c/Users/yhxu4/AppData/Local/nvm/v20.20.0:/c/Users/yhxu4/AppData/Roaming/npm:/usr/bin:$PATH"

# PowerShell 等价
$env:PATH = "C:\Users\yhxu4\AppData\Local\nvm\v20.20.0;C:\Users\yhxu4\AppData\Roaming\npm;" + $env:PATH
```

---

## 附录：文件索引

### 从"我想修改 X"出发

| 我想修改 | 去哪个文件 |
|---------|-----------|
| Agent 的 LLM 配置 | `config/arena.yaml` → agents[].llm |
| Agent 用哪些策略 | `config/arena.yaml` → agents[].strategy_weights |
| 添加新 Agent | `config/arena.yaml` 追加一项 |
| 赛季时长 | `config/arena.yaml` → arena.season_duration_days |
| Softmax 温度 | `config/arena.yaml` → settlement.temperature |
| 风险限制 | `config/agent.yaml` → risk.* |
| LLM 审批阈值 | `config/agent.yaml` → ai.approval_threshold_usd |
| 新增技术指标 | `python/signals/technical.py` |
| 新增策略 | `python/strategies/新文件.py` + 注册 main.py |
| 修改策略参数 | `config/strategies/策略名.yaml` |
| 修改 Softmax 算法 | `packages/arena-coordinator/src/settlement/softmax.ts` |
| 修改结算有效性条件 | `packages/arena-coordinator/src/leaderboard.ts` → `isValidAgent()` |
| 新增 API 路由 | `packages/api-server/src/routes/arena.ts` |
| 新增 WebSocket 事件 | `packages/api-server/src/ws/broadcaster.ts` |
| 修改虚拟交易逻辑 | `packages/arena-coordinator/src/virtual-portfolio.ts` |
| 链上同步逻辑 | `packages/arena-coordinator/src/arena-engine.ts` → `settle()` 末尾 |

---

## Phase 2 Status Update (2026-02-24)

按第九章顺序，以下项已落地：

1. 链上同步前置层（`onSeasonEnd` 提交器）  
   已实现可配置 HTTP 提交、重试、超时、HMAC、DLQ；仍未包含 Solidity 合约与链上交易签名发送。
2. Arena 引擎独立行情拉取  
   `ArenaEngine` 现在可在未注入 `getSnapshot` 时内部拉取行情（`market_symbols` 可配置）。
3. Leaderboard 历史接口  
   已实现 `GET /api/v1/leaderboard/history?limit=...`，读取 `state/arena/seasons/*.json`。
4. WebSocket 认证  
   已实现可选 token 认证（配置 `ARENA_WS_AUTH_TOKEN` 后使用 `/ws?token=...`）。
5. `WeightedStrategyMixer` 集成  
   已接入 Python IPC 主流程：当存在至少 2 个有效权重策略时自动启用，否则回退串行。

剩余未完成（Phase 2）：
- 智能合约开发与部署（`contracts/` 目录及 `ArenaToken/ArenaVault/SeasonSettler`）
- 将结算结果从“HTTP 提交器”升级为“真实链上交易执行与确认回执持久化”

### 从"我遇到了 Bug X"出发

| 症状 | 排查位置 |
|------|---------|
| Python 引擎不响应 | `python/ipc/server.py` → IPCServer；检查端口 7890 是否占用 |
| 策略没有产生信号 | `python/strategies/` 对应策略；检查 `snapshot.activeStrategies` 是否包含该策略 id |
| 信号被风险模块拦截 | `python/risk/manager.py` → `check_pre_trade()` |
| LLM 审批一直失败 | `packages/ai-brain/src/decision-gate.ts`；检查 API Key 环境变量 |
| IPC 超时 | `config/agent.yaml` → `ipc.timeout_ms`；或 Python 侧计算太慢 |
| Webhook Agent 失联 | `packages/arena-coordinator/src/agents/webhook-agent.ts` → `consecutiveFailures` |
| 排行榜不更新 | `packages/arena-coordinator/src/arena-engine.ts` → `saveLeaderboard()` |
| 赛季不结算 | `packages/arena-coordinator/src/season-manager.ts` → `isExpired()`；检查 `season.end_time` |

## Phase 2 Final Update (2026-02-24)

Completed additions:
- `contracts/` now exists with deployable Arena contract set (`ArenaToken`, `ArenaVault`, `SeasonSettler`).
- CLI season settlement supports on-chain execution mode via Foundry `cast send`.
- On-chain tx receipts can be persisted to jsonl for audit trails.

Runtime env keys for on-chain mode:
- `ARENA_SETTLEMENT_MODE=onchain`
- `ARENA_SETTLER_CONTRACT`
- `ARENA_SETTLER_PRIVATE_KEY`
- `ARENA_CHAIN_RPC_URL` (or `BASE_RPC_URL`)
- `ARENA_SETTLEMENT_RECEIPTS_PATH`

## Phase 2 Hardening Update (2026-02-24)

Completed in this pass:
- Added emergency pause controls to `ArenaVault` and `SeasonSettler` (owner can pause/unpause critical flows).
- Added cycle-level decision commitment persistence in Arena engine:
  - file: `state/arena/cycle_commitments.jsonl`
  - row fields: `cycle_id`, `timestamp`, `signal_count`, `cycle_root`
- Extended contract test suites:
  - ArenaVault: 8 tests
  - SeasonSettler: 8 tests
  - Total: 16 passing tests

## Web4 MVP Update (2026-02-24)

Added contract-level MVP components:
- Agent identity layer: `AgentNFA.sol` (ERC-721 style)
- Agent account layer: `AgentAccount.sol` + `AgentAccountRegistry.sol` (ERC-6551-style deterministic TBA)
- Learning commitment layer: `LearningRootOracle.sol` (cycle root commits)

Status:
- All new contracts compiled and tested (`forge test`: 27 passed).
- Deployment script now deploys these new components alongside settlement contracts.

## Runtime Web4 Hook-up Update (2026-02-24)

Arena startup now supports optional on-chain identity bootstrap:
- For each enabled agent, CLI can ensure:
  - NFA identity exists (`mintAgent` if absent)
  - deterministic token-bound account exists (`createAccount`)
- Controlled by env flag: `ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION=1`

Cycle commitment path now supports automatic on-chain submit per cycle via `LearningRootOracle`.

## Ops Commands Update (2026-02-24)

New arena commands:
- `arena bootstrap-onchain`
  - Batch ensures enabled agents are registered on-chain (NFA + TBA) without starting engine.
- `arena sync-learning --limit N [--reset-cursor]`
  - Replays `cycle_commitments.jsonl` to `LearningRootOracle`.
  - Supports idempotent skip of already-submitted cycles.
  - Supports resume cursor persistence (default path: `state/arena/sync_learning_cursor.json`).
