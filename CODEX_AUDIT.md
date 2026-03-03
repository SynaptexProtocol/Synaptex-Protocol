# Arena Protocol — Codex 完整审核文档

> 请完整阅读本文档，理解项目的每个文件、模块功能和架构关系，然后进行全面代码审核。

---

## 一、项目是什么

**Arena Protocol** 是部署在 **Base Chain（chain_id: 8453）** 上的开放 AI Agent 交易竞技协议。

### 核心机制

1. 多个 AI Agent 基于**相同的真实市场行情**（Crypto.com API）各自独立做模拟交易决策
2. Agent **只做模拟交易**，不持有任何真实资产
3. 用户把 **ARENA 代币**押注给自己看好的 Agent，代币锁入智能合约
4. 赛季结束（7天）后，根据每个 Agent 的模拟交易 ROI，用 **Softmax 算法**重新分配池子里的代币
5. **零和游戏**：押注赢家多拿，押注输家少拿，总量不变
6. 所有决策通过 **Merkle Proof + learningRoot** 链上可验证
7. **任何人可以接入自己的 Agent**（Webhook 方式），不需要审核

### 盈利模式

- 团队持有初始 ARENA 代币（fair launch 发射平台获得）
- 协议越繁荣 → 代币需求越大 → 代币升值
- 没有平台抽成，没有手续费

---

## 二、技术栈

```
语言:     TypeScript (Node.js 20) + Python 3.11
包管理:   pnpm workspace monorepo (pnpm@9.0.0)
链:       Base Chain (EVM, chain_id: 8453)
行情数据: Crypto.com Exchange API (REST)
AI决策:   多LLM支持 (Claude / GPT-4o / Gemini / DeepSeek / Ollama)
执行层:   MoonPay MCP (paper模式默认，live模式可选)
IPC通信:  TypeScript ↔ Python TCP JSON-RPC (127.0.0.1:7890)
配置:     YAML驱动
```

---

## 三、完整文件清单与说明

### 根目录（10个文件，不含 pnpm-lock.yaml）

| 文件 | 说明 |
|------|------|
| `pnpm-workspace.yaml` | pnpm monorepo 配置，包含 `packages/*` 和 `cli` |
| `package.json` | 根工作区，脚本: build / dev / start / lint / typecheck |
| `tsconfig.base.json` | TypeScript 基础配置，所有子包继承 |
| `.env` | 本地环境变量（不入版本控制） |
| `.env.example` | 环境变量模板 |
| `.gitignore` | Git 忽略规则 |
| `AUDIT.md` | 原始审计文档 |
| `AUDIT_FIXLOG.md` | 审计修复记录 |
| `CODEX_PROMPT.md` | 给 Codex 的任务说明文档 |
| `CODEX_AUDIT.md` | 本文件 — 完整审核文档 |

---

### CLI 包 (`cli/`)

入口程序，用 Commander 暴露所有命令。

| 文件 | 说明 |
|------|------|
| `cli/src/index.ts` | 主入口：注册 `start`、`status` 命令，并注册 Arena 子命令 |
| `cli/src/commands/arena.ts` | Arena 子命令：`arena start` / `arena status` / `arena leaderboard` |
| `cli/package.json` | 依赖所有 workspace 包；binary: `base-agent` |
| `cli/tsconfig.json` | 继承 tsconfig.base.json |

**命令说明：**
- `base-agent start` — 启动单Agent模式（原有功能）
- `base-agent status` — 查看单Agent持仓状态
- `base-agent arena start` — 启动 Arena 引擎（多Agent竞技 + API服务器）
- `base-agent arena status` — 查看当前赛季状态
- `base-agent arena leaderboard` — 打印排行榜

---

### packages/@base-agent/core

共享类型定义，所有包都依赖它，不含业务逻辑。

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 公开导出所有类型 |
| `src/types/market.ts` | `MarketSnapshot`、`Candle`、`TokenMarketData`、`PortfolioState`、`PortfolioPosition` |
| `src/types/strategy.ts` | `StrategySignal`、`SignalBatch`、`AiDecision`、`ApprovedDecision`、`AgentMemoryEntry` |
| `src/types/ipc.ts` | `IpcRequest`、`IpcResponse`、`IpcMethod`（JSON-RPC 2.0 协议类型） |
| `src/types/order.ts` | `SwapRequest`、`SwapReceipt`、`Trade`、`LimitOrder`、`SimulationResult` |
| `src/utils/logger.ts` | 日志工具 |
| `src/utils/file-state.ts` | JSON 文件读写工具（`readJsonOrDefault`、`appendJsonLine`） |
| `src/utils/retry.ts` | 指数退避重试工具 |

**重要约束：以下类型字段名不可修改（链上和IPC依赖）**
- `MarketSnapshot`
- `StrategySignal` / `SignalBatch`
- `SwapRequest`（`chain: 'base'` 已固定）

---

### packages/@base-agent/market-data

从 Crypto.com REST API 拉取行情数据。

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 公开导出 |
| `src/crypto-com-client.ts` | Crypto.com API 客户端（getTicker、getCandlesticks、getOrderBook） |
| `src/market-cache.ts` | 带 TTL 的内存缓存 |
| `src/market-poller.ts` | 轮询循环，按配置间隔拉取所有代币行情 |

---

### packages/@base-agent/ai-brain

多 LLM 统一接口，所有 provider 实现相同的 `ILlmProvider` 接口。

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 公开导出 |
| `src/provider-interface.ts` | `ILlmProvider` 接口定义（`evaluateSignal` 方法） |
| `src/provider-factory.ts` | 工厂函数 `createProvider(config)` — 按 yaml 配置实例化对应 provider |
| `src/decision-gate.ts` | `DecisionGate` — 信号审批（自动通过 or 发给 LLM 审批，支持 fallback） |
| `src/memory-manager.ts` | `MemoryManager` — Agent 滚动记忆（持久化到 state/agent_memory.json） |
| `src/prompt-builder.ts` | 统一提示词构建器 |
| `src/providers/anthropic.ts` | Claude 适配器（@anthropic-ai/sdk） |
| `src/providers/openai.ts` | GPT 适配器（openai SDK） |
| `src/providers/gemini.ts` | Gemini 适配器（@google/generative-ai） |
| `src/providers/deepseek.ts` | DeepSeek 适配器 |
| `src/providers/ollama.ts` | Ollama 本地模型适配器 |

**切换 LLM：只改 `config/agent.yaml` 的 `ai.provider` 字段，不改代码。**

---

### packages/@base-agent/ipc-bridge

TypeScript 侧的 JSON-RPC 客户端，与 Python 引擎通信。

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 公开导出 `IpcClient`、`IpcConfig` |
| `src/ipc-client.ts` | TCP JSON-RPC 客户端：`connect()`、`processSnapshot()`、`getHealth()`、`disconnect()` |

**协议：** JSON-RPC 2.0，每行一个 JSON 对象（newline-delimited）
**端口：** 127.0.0.1:7890（可在 agent.yaml 中配置）

---

### packages/@base-agent/scheduler

基于 cron 表达式的任务调度引擎。

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 公开导出 `CronEngine` |
| `src/cron-engine.ts` | 按策略 schedule 触发：拉行情 → IPC → AI 审批 → 执行 |

**调度示例：** `*/15 * * * *` = 每 15 分钟

---

### packages/@base-agent/moonpay-client

MoonPay 交易执行层，支持 paper/live 双模式。

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 公开导出 |
| `src/moonpay-mcp.ts` | `MoonpayMcpClient` — MCP 协议封装（wallet/swap/balance） |
| `src/swap-executor.ts` | `SwapExecutor` — 完整执行流程（模拟 → 验证 → 执行 → 日志），chain 已固定为 `'base'` |
| `src/swap-simulator.ts` | `SwapSimulator` — 模拟报价（paper 模式用） |

---

### packages/@base-agent/arena-coordinator

**Arena 核心引擎**，负责多 Agent 并行编排、虚拟持仓、赛季结算。

#### 接口层（一旦定义不可修改）

| 文件 | 说明 |
|------|------|
| `src/interfaces/i-arena-agent.ts` | `IArenaAgent` 接口：`id`、`name`、`owner`、`type`、`decide(snapshot, portfolio)`、`onCycleResult?` |
| `src/interfaces/i-settlement.ts` | `ISettlementAlgorithm` 接口：`algorithm_id`、`calculate_weights(results, params)` |
| `src/interfaces/i-arena-hook.ts` | `IArenaHook` 接口：`onCycleComplete`、`onSeasonStart`、`onSeasonEnd`、`onAgentError` |

#### 类型层

| 文件 | 说明 |
|------|------|
| `src/types/arena-signal.ts` | `ArenaSignal`（链上验证用，字段名固定）；`signalToLeaf()`；`buildMerkleRoot()` |
| `src/types/virtual-portfolio.ts` | `VirtualPortfolio`、`VirtualPosition` 类型 |
| `src/types/season.ts` | `Season` 类型，`SeasonStatus` 状态机：`pending→active→settling→settled` |

#### 实现层

| 文件 | 说明 |
|------|------|
| `src/agents/internal-agent.ts` | `InternalAgent` — 复用 IPC + DecisionGate 流程，strategy_weights 注入 activeStrategies |
| `src/agents/webhook-agent.ts` | `WebhookAgent` — HTTP POST（HMAC-SHA256 签名），5s 超时，连续3次失败标记失联 |
| `src/settlement/softmax.ts` | `SoftmaxSettlement` — `w_i = exp(ROI_i × T) / Σexp(ROI_j × T)`，algorithm_id = "softmax_v1" |
| `src/virtual-portfolio.ts` | `VirtualPortfolioManager` — 虚拟买卖执行、ROI 计算、价格更新 |
| `src/leaderboard.ts` | `buildLeaderboard()`、`isValidAgent()`、leaderboard_hash（SHA-256） |
| `src/season-manager.ts` | `SeasonManager` — 赛季生命周期，持久化到 `state/arena/season_current.json` |
| `src/arena-engine.ts` | `ArenaEngine` — 主引擎：`start()`、`runCycleWithSnapshot()`、`settle()`、各种 query 方法 |
| `src/index.ts` | 公开导出所有类型、接口、实现 |

**有效 Agent 判定：** `signal_count >= 3 && trade_count >= 1 && status !== 'disqualified'`
**无效 Agent：** 押注全额退还，不参与 Softmax

---

### packages/@base-agent/api-server

REST + WebSocket 服务器，供前端/链上脚本查询状态。

| 文件 | 说明 |
|------|------|
| `src/server.ts` | `createApiServer(engine, config)` — Express + WebSocket 服务器，自动绑定 ArenaEngine 钩子 |
| `src/routes/arena.ts` | Arena REST 路由（见下方 API 列表） |
| `src/ws/broadcaster.ts` | `WsBroadcaster` — WebSocket 广播，连接在 `/ws` 路径 |
| `package.json` | 依赖 express、ws；typescript 5.4 |
| `tsconfig.json` | 继承 tsconfig.base.json |

**REST API（/api/v1/...）：**
```
GET /health                        服务健康检查
GET /api/v1/leaderboard            当前赛季实时排行榜
GET /api/v1/season/current         当前赛季元数据
GET /api/v1/agents                 所有 Agent 列表（含 ROI）
GET /api/v1/agents/:id             单个 Agent 虚拟持仓详情
GET /api/v1/agents/:id/trades      某 Agent 虚拟交易历史
GET /api/v1/agents/:id/signals     某 Agent 信号历史
```

**WebSocket 事件（ws://host:port/ws）：**
```
cycle_complete   每次决策周期结束（含信号数、交易数）
leaderboard      排行榜实时更新
season_start     新赛季开始
season_end       赛季结束（含最终结果）
```

---

### 配置文件 (`config/`)

| 文件 | 说明 |
|------|------|
| `config/agent.yaml` | 主配置：agent 模式、chain RPC、行情轮询间隔、策略调度、AI 阈值、风险参数、IPC/API 端口 |
| `config/arena.yaml` | Arena 配置：赛季时长、起始虚拟资金、周期间隔、最小 Agent 数、有效性条件、settlement 算法、Agent 列表 |
| `config/tokens.yaml` | 代币注册表：ETH、USDC、cbBTC（Base Chain 合约地址、精度、Crypto.com 交易对） |
| `config/strategies/dca.yaml` | DCA 策略参数 |
| `config/strategies/trend_swap.yaml` | EMA 金叉/死叉参数 |
| `config/strategies/mean_reversion.yaml` | 布林带均值回归参数（%B + RSI + ATR） |
| `config/strategies/momentum.yaml` | MACD 动量策略参数 |
| `config/strategies/rsi_divergence.yaml` | RSI 顶底背离参数 |
| `config/strategies/rebalance.yaml` | 目标配比再平衡参数 |
| `config/strategies/limit_orders.yaml` | 限价单监控参数 |
| `config/strategies/custom/example_custom.yaml` | 自定义插件策略配置模板 |

---

### Python 策略引擎 (`python/`)

独立进程，通过 IPC 与 TypeScript 通信。

#### 主入口

| 文件 | 说明 |
|------|------|
| `python/main.py` | 加载 agent.yaml、实例化策略、启动 IPC Server（127.0.0.1:7890） |

#### IPC

| 文件 | 说明 |
|------|------|
| `python/ipc/server.py` | TCP JSON-RPC 服务端：接收 `process_snapshot`，调用策略，返回 `SignalBatch` |

#### 数据模型

| 文件 | 说明 |
|------|------|
| `python/models/market.py` | `MarketSnapshot`、`PortfolioState`、`Candle`（与 TypeScript 侧字段名对应） |
| `python/models/signal.py` | `Signal`、`SignalBatch`（snake_case，TypeScript 侧归一化） |

#### 策略

| 文件 | 说明 |
|------|------|
| `python/strategies/base.py` | `BaseStrategy` 抽象类：`id`、`enabled`、`generate_signals(snapshot, portfolio)` |
| `python/strategies/dca.py` | `TrendDCAStrategy` — EMA + RSI + 成交量趋势跟踪 DCA |
| `python/strategies/trend_swap.py` | `TrendSwapStrategy` — EMA 金叉（BUY）/ 死叉（SELL） |
| `python/strategies/mean_reversion.py` | `MeanReversionStrategy` — 布林带均值回归（%B + RSI + ATR 过滤） |
| `python/strategies/momentum.py` | `MomentumStrategy` — MACD 金叉 + ROC + 成交量确认 |
| `python/strategies/rsi_divergence.py` | `RSIDivergenceStrategy` — 顶底 RSI 背离检测 |
| `python/strategies/rebalance.py` | `RebalanceStrategy` — 目标配比偏差触发再平衡 |
| `python/strategies/limit_order.py` | `LimitOrderStrategy` — 限价单价格监控 |
| `python/strategies/mixer.py` | `WeightedStrategyMixer` — 多策略权重混合工具类，冲突解决（高置信度胜出）；**非默认流程，需显式实例化调用** |
| `python/strategies/plugin_loader.py` | 动态加载自定义策略插件（加新策略无需修改现有代码） |
| `python/strategies/__init__.py` | 导出所有策略类 |

#### 技术指标

| 文件 | 说明 |
|------|------|
| `python/signals/technical.py` | `ema`、`sma`、`rsi`、`bollinger_bands`、`macd`、`atr`、`percent_b`、`rsi_divergence`、`volume_above_avg` |

#### 风险管理

| 文件 | 说明 |
|------|------|
| `python/risk/manager.py` | `RiskManager` — 仓位上限、总敞口、日亏损限制、冷却期（来自 agent.yaml risk 配置） |

#### 回测

| 文件 | 说明 |
|------|------|
| `python/backtesting/engine.py` | 回测核心引擎（逐 K 线模拟，Walk-forward 验证） |
| `python/backtesting/data_feed.py` | 历史数据加载（CSV / DB） |
| `python/backtesting/report.py` | 回测报告：ROI、夏普比率、Sortino、最大回撤 |
| `python/backtesting/run_backtest.py` | 命令行回测入口 |

#### 测试

| 文件 | 说明 |
|------|------|
| `python/tests/test_strategies.py` | 策略单元测试 |

---

### 状态文件 (`state/`)

运行时生成，不在版本控制中。

```
state/
  portfolio.json          单Agent模式持仓状态
  signals.json            最近信号记录
  agent_memory.json       AI滚动记忆（JSON Lines）
  arena/
    season_current.json   当前赛季状态（SeasonManager 维护）
    leaderboard.json      最新排行榜
    agent-{id}.json       各Agent虚拟持仓快照
    seasons/
      season-{id}.json    历史赛季完整结果（赛季结算后归档）
```

---

## 四、架构关系图

```
┌─────────────────────────────────────────────────────────────┐
│                  CLI (base-agent)                           │
│  index.ts ──┬── start (CronEngine + single agent)          │
│             └── arena ──┬── arena start                    │
│                         ├── arena status                    │
│                         └── arena leaderboard              │
└───────────────────────────┬─────────────────────────────────┘
                            │
         ┌──────────────────▼──────────────────┐
         │         ArenaEngine                 │
         │  ┌─────────────────────────────┐    │
         │  │  每15分钟 runCycleWithSnapshot│    │
         │  │  Promise.allSettled() 并行   │    │
         │  └────────────┬────────────────┘    │
         │               │                     │
         │    ┌──────────┼──────────┐           │
         │    ▼          ▼          ▼           │
         │  Agent A   Agent B   Agent C  ...    │
         │ (Internal)(Internal)(Webhook)        │
         │    │          │                      │
         │    ▼          ▼                      │
         │  IPC+Gate  IPC+Gate                  │
         │    │          │                      │
         │  VirtualPortfolio updates            │
         │  Leaderboard update                  │
         │  WsBroadcaster.broadcast()           │
         └──────────────────────────────────────┘
                            │
         ┌──────────────────▼──────────────────┐
         │  API Server (Express + WebSocket)    │
         │  REST: /api/v1/...                   │
         │  WS:   /ws (实时推送)                │
         └──────────────────────────────────────┘
                            │
         ┌──────────────────▼──────────────────┐
         │  Python Engine (独立进程)            │
         │  TCP JSON-RPC 127.0.0.1:7890        │
         │  ┌──────────────────────────────┐   │
         │  │ StrategyEngine.process()     │   │
         │  │ 串行遍历 activeStrategies    │   │
         │  │ ┌──────┬──────┬──────┬────┐ │   │
         │  │ │ DCA  │Trend │MACD  │RSI │ │   │
         │  │ └──────┴──────┴──────┴────┘ │   │
         │  │ RiskManager.check_pre_trade  │   │
         │  └──────────────────────────────┘   │
         │  → SignalBatch                       │
         └──────────────────────────────────────┘
```

---

## 五、数据流（单次 Arena 周期）

```
1. MarketPoller.poll()
   → MarketSnapshot { timestamp, tokens: {ETH, cbBTC, USDC}, cycleId }

2. ArenaEngine.runCycleWithSnapshot(snapshot)
   → 检查赛季是否 active，是否到期

3. Promise.allSettled([agent.decide(snapshot, portfolio), ...])
   InternalAgent.decide():
     a. IpcClient.processSnapshot(snapshot)  → Python
        Python StrategyEngine.process():
          - 串行遍历 strategies 列表
          - 每个 strategy: strategy.generate_signals(snapshot, portfolio)
            （仅处理 snapshot.activeStrategies 中启用的策略）
          - 逐条 RiskManager.check_pre_trade(signal, portfolio)
            → 通过：加入 approved 列表
            → 拒绝：记录 veto_reason，继续处理下一条
          - 返回 SignalBatch { signals: approved, risk_vetoed, veto_reason }
        注意：WeightedStrategyMixer 是可选工具类，
              StrategyEngine 默认不使用它；
              mixer 由各 strategy 内部或上层显式调用时才生效
        Python → SignalBatch (snake_case)
        TypeScript normalize → SignalBatch (camelCase)
     b. DecisionGate.processSignals()
        → 低置信度或大金额 → LLM 审批
        → 返回 ApprovedDecision[]
     c. 转换为 ArenaSignal[]

   WebhookAgent.decide():
     a. HTTP POST {webhookUrl} with MarketSnapshot + Portfolio
     b. HMAC-SHA256 签名验证
     c. 5秒超时，失败计数

4. 各 Agent 更新 VirtualPortfolio
   applySignal() → VirtualTrade
   updatePrices() → 重算 ROI

5. saveLeaderboard() → state/arena/leaderboard.json
   saveStateFiles() → state/arena/agent-{id}.json

6. WsBroadcaster.broadcast('cycle_complete', ...)
   WsBroadcaster.broadcast('leaderboard', ...)

7. onCycleComplete 钩子触发
```

---

## 六、赛季结算流程

```
1. SeasonManager.isExpired() → true
2. ArenaEngine.settle()
3. 每个 Agent 计算:
   - signal_count、trade_count、roi
   - isValid = signal_count>=3 && trade_count>=1
4. validAgents → SoftmaxSettlement.calculate_weights()
   w_i = exp(ROI_i × T) / Σexp(ROI_j × T)  (T=2.0)
5. invalidAgents → weight = 0（链上合约退还押注）
6. buildLeaderboard() → leaderboard_hash (SHA-256)
7. buildMerkleRoot(allSignalLeaves) → merkle_root
8. SeasonManager.transitionTo('settled', {leaderboard_hash})
9. 归档到 state/arena/seasons/season-{id}.json
10. onSeasonEnd 钩子 → 链上同步（待实现）
    WsBroadcaster.broadcast('season_end', ...)
```

---

## 七、Webhook 接入规范（外部开发者）

```
POST {外部服务器URL}
Headers:
  Content-Type: application/json
  X-Arena-Version: 1.0
  X-Arena-Signature: HMAC-SHA256(body, secret)

请求体:
{
  "version": "1.0",
  "cycle_id": "uuid",
  "timestamp": "2026-02-24T10:00:00Z",
  "snapshot": {
    "tokens": {
      "ETH":   { "price": 2450.5, "change24h": 0.023, "candles1h": [...] },
      "cbBTC": { "price": 95000, ... },
      "USDC":  { "price": 1.0, ... }
    }
  },
  "portfolio": {
    "cash_usd": 8200,
    "positions": [{ "token": "ETH", "amount": 0.5, "current_value_usd": 1225 }],
    "total_value_usd": 9425,
    "roi": -0.0575
  }
}

响应体（必须在5秒内返回）:
{
  "signals": [
    {
      "token": "ETH",
      "action": "BUY",
      "amount_usd": 100,
      "confidence": 0.8,
      "reason": "ETH RSI oversold at 28"
    }
  ]
}
```

---

## 八、不可修改的接口（链上和IPC依赖）

以下字段名一旦确定不可改变：

```typescript
// ArenaSignal — 链上 Merkle 验证用
interface ArenaSignal {
  agent_id: string
  token: 'ETH' | 'cbBTC' | 'USDC'
  action: 'BUY' | 'SELL' | 'HOLD'
  amount_usd: number | null
  confidence: number
  reason: string
  timestamp: string   // ISO8601
  cycle_id: string
}

// IArenaAgent.decide() — 所有 Agent 的核心接口
decide(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): Promise<ArenaSignal[]>

// ISettlementAlgorithm — 结算算法接口
calculate_weights(
  results: AgentSeasonResult[],
  params: SettlementParams
): Record<string, number>  // agent_id → weight，总和必须 = 1
```

---

## 九、可扩展的部分

- **新增 Agent：** 在 `config/arena.yaml` 追加配置段 → 重启
- **新增策略：** 在 `python/strategies/` 新建 `.py` 继承 `BaseStrategy`
- **新增结算算法：** 实现 `ISettlementAlgorithm`，在 arena.yaml 中 `settlement.algorithm` 指定
- **新增 API 路由：** 在 `packages/api-server/src/routes/` 新建路由文件
- **所有接口可新增字段（向后兼容），不可删除或重命名现有字段**

---

## 十、已知问题 / 待实现

| 问题 | 位置 | 状态 |
|------|------|------|
| 链上同步（onSeasonEnd → 合约调用） | `arena-engine.ts` 的 `settle()` 方法末尾 | 待实现（Phase 2） |
| Leaderboard 历史接口 | `GET /api/v1/leaderboard/history` | 路由已规划，未实现 |
| WebSocket 认证 | `ws/broadcaster.ts` | 目前无认证 |
| Arena 周期的独立 MarketPoller | `arena-engine.ts` 的 `runCycle()` | 目前依赖外部注入 snapshot |
| 智能合约（ArenaToken, ArenaVault, SeasonSettler） | `contracts/`（目录不存在） | Phase 2 |

---

## 十一、构建与运行

> **最后验证时间：2026-02-24，环境：Windows 11，Node.js v20.20.0（nvm），pnpm 9.0.0**
> **结果：9 个 TypeScript 包全部编译通过，Python 策略导入正常**

```bash
# Windows Git Bash / bash 环境下设置 PATH
export PATH="/c/Users/yhxu4/AppData/Local/nvm/v20.20.0:/c/Users/yhxu4/AppData/Roaming/npm:/usr/bin:$PATH"

# PowerShell 等价写法
# $env:PATH = "C:\Users\yhxu4\AppData\Local\nvm\v20.20.0;C:\Users\yhxu4\AppData\Roaming\npm;" + $env:PATH

# 安装依赖
pnpm install

# 构建所有包
pnpm build
# 预期输出: packages/core, ai-brain, ipc-bridge, market-data, moonpay-client,
#           scheduler, arena-coordinator, api-server, cli — 全部 Done

# 验证 Python 策略
cd python
python -c "from strategies import *; print('OK')"

# 启动 Arena（需先启动 Python 引擎）
python main.py --config ../config/agent.yaml &
node cli/dist/index.js arena start --config config/arena.yaml

# 查看排行榜
node cli/dist/index.js arena leaderboard
```

---

## 十二、文件数量统计

> 统计口径：排除 `node_modules/`、`dist/`、`.venv/`、`state/`、`logs/`、`__pycache__/`、`pnpm-lock.yaml`、`*.d.ts`、`*.map`

| 分类 | 数量 |
|------|------|
| TypeScript 文件（.ts，不含 .d.ts） | 51 |
| Python 文件（.py） | 28 |
| YAML 配置文件（.yaml，不含 pnpm-lock.yaml） | 12 |
| 根目录文件（不含 pnpm-lock.yaml） | 10 |
| **合计** | **101** |

**TypeScript 51 个分布：** cli×2 / ai-brain×11 / core×8 / market-data×4 / ipc-bridge×2 / moonpay-client×4 / scheduler×2 / api-server×3 / arena-coordinator×14 / scripts×1

**Python 28 个分布：** main×1 / ipc×2 / models×3 / signals×2 / risk×2 / strategies×11 / backtesting×5 / tests×2

---

## 13. Phase 2 Status Update (2026-02-24)

Completed in this revision:
- `GET /api/v1/leaderboard/history` is implemented.
- WebSocket optional token auth is implemented in `ws/broadcaster.ts` (`ARENA_WS_AUTH_TOKEN`, client uses `/ws?token=...`).
- `WeightedStrategyMixer` is integrated into `python/ipc/server.py` default pipeline when >=2 weighted strategies are present.
- `ArenaEngine` supports internal market polling mode (no mandatory external `getSnapshot`).

Still pending:
- Smart contracts (`contracts/`): `ArenaToken`, `ArenaVault`, `SeasonSettler`.
- Real on-chain settlement transaction execution/confirmation path (current implementation is settlement payload submitter scaffold).

## 14. Contracts Status Update (2026-02-24)

Implemented in-repo contract suite:
- `contracts/src/ArenaToken.sol`
- `contracts/src/ArenaVault.sol`
- `contracts/src/SeasonSettler.sol`
- `contracts/src/Ownable.sol`
- `contracts/foundry.toml`
- `contracts/README.md`

CLI settlement path now supports direct on-chain submission (via `cast send`) when:
- `ARENA_SETTLEMENT_MODE=onchain`
- `ARENA_SETTLER_CONTRACT` is set
- `ARENA_SETTLER_PRIVATE_KEY` is set
- `ARENA_CHAIN_RPC_URL` (or `BASE_RPC_URL`) is set

Receipt persistence is supported by:
- `ARENA_SETTLEMENT_RECEIPTS_PATH`
