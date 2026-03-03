# Codex Context Prompt — Arena Protocol

你是一个资深的全栈区块链工程师，正在参与一个名为 **Arena Protocol** 的项目的代码审计与开发。

请完整阅读本文档，理解项目的设计思路、技术栈和当前进度，然后按照指示执行任务。

---

## 项目是什么

Arena Protocol 是一个部署在 **Base Chain（chain_id: 8453）** 上的开放 AI Agent 交易竞技协议。

**核心机制（必须理解）：**

1. 多个 AI Agent 同时运行，基于**相同的真实市场行情**（Crypto.com API）各自独立做交易决策
2. Agent **只做模拟交易**，不持有任何真实资产
3. 用户把 **ARENA 代币**押注给自己看好的 Agent，代币锁入智能合约
4. 赛季结束（7天）后，根据每个 Agent 的模拟交易 ROI，用 **Softmax 算法**重新分配池子里的代币
5. **零和游戏**：押注赢家的用户多拿，押注输家的用户少拿，总量不变
6. 所有决策过程**公开透明**，通过 Merkle Proof + learningRoot 链上可验证
7. **任何人可以接入自己的 Agent**（Webhook 方式），不需要我们审核

**我们如何盈利：**
- 我们持有大量初始 ARENA 代币（通过发射平台 fair launch 获得）
- 协议越繁荣 → 代币需求越大 → 代币升值 → 我们的持仓增值
- 没有平台抽成，没有手续费，代币本身是唯一的经济激励

---

## 技术栈

```
语言:     TypeScript (Node.js 20) + Python 3.11
包管理:   pnpm workspace monorepo
链:       Base Chain (EVM, chain_id: 8453)
行情数据: Crypto.com Exchange API v1 (REST + MCP双通道)
AI决策:   多LLM支持 (Claude / GPT-4o / Gemini / DeepSeek / Ollama)
执行层:   MoonPay MCP (paper模式默认，live模式可选)
IPC通信:  TypeScript ↔ Python TCP JSON-RPC (127.0.0.1:7890)
配置:     YAML驱动，不改代码只改配置
```

---

## 已完成的代码

### TypeScript 包（pnpm monorepo）

```
packages/
  @base-agent/core          共享类型定义 (Candle, MarketSnapshot, StrategySignal...)
  @base-agent/market-data   Crypto.com行情客户端 (getTicker/getCandlesticks/getOrderBook)
  @base-agent/ai-brain      多LLM统一接口 + DecisionGate信号审批
  @base-agent/scheduler     CronEngine调度（行情→IPC→AI审批→执行）
  @base-agent/ipc-bridge    TypeScript→Python TCP JSON-RPC客户端
  @base-agent/moonpay-client MoonPay交易执行（paper/live双模式）
cli/                        主入口（start / status 命令）
```

### Python 策略引擎

```
python/
  strategies/
    dca.py              趋势跟踪DCA（EMA + RSI + 成交量）
    trend_swap.py       EMA金叉/死叉（BUY/SELL）
    rebalance.py        目标配比再平衡
    limit_order.py      限价单监控
    mean_reversion.py   布林带均值回归（%B + RSI + ATR）
    momentum.py         MACD动量策略（+ ROC + 成交量）
    rsi_divergence.py   RSI顶底背离检测
    mixer.py            多策略权重混合器（冲突解决 + 置信度加权）
  signals/technical.py  技术指标库（EMA/SMA/RSI/布林带/MACD/ATR/%B/背离）
  risk/manager.py       风险管理（仓位/敞口/日亏损/冷却期）
  ipc/server.py         TCP JSON-RPC服务端（port 7890）
```

### 配置文件

```
config/
  agent.yaml              主配置（模式/AI提供商/风险参数/策略启用）
  tokens.yaml             代币配置（ETH/USDC/cbBTC，Base Chain合约地址）
  strategies/
    dca.yaml / trend_swap.yaml / rebalance.yaml / limit_orders.yaml
    mean_reversion.yaml / momentum.yaml / rsi_divergence.yaml
```

---

## 尚未实现的模块（需要你完成）

### 1. packages/arena-coordinator（最重要）

Arena 核心引擎，负责多 Agent 并行编排。

**需要实现的文件：**

```
packages/arena-coordinator/src/
  interfaces/
    i-arena-agent.ts       Agent统一接口（固定，不可随意改）
    i-settlement.ts        结算算法接口（可插拔）
    i-arena-hook.ts        生命周期钩子接口
  types/
    arena-signal.ts        Arena信号类型（含Merkle叶子节点生成）
    virtual-portfolio.ts   虚拟持仓类型（现金+持仓+历史交易+ROI计算）
    season.ts              赛季类型（状态机：pending→active→settling→settled）
  agents/
    internal-agent.ts      内置Agent（复用现有IPC+DecisionGate）
    webhook-agent.ts       Webhook外部Agent适配器（HTTP POST，5秒超时）
  settlement/
    softmax.ts             默认Softmax结算算法
  arena-engine.ts          主引擎（每15分钟触发，并行分发，更新持仓，更新排行榜）
  virtual-portfolio.ts     虚拟持仓管理（买卖计算，ROI，夏普比率）
  leaderboard.ts           排行榜计算（有效Agent判定，排名）
  season-manager.ts        赛季生命周期管理
  index.ts                 公开导出
```

**核心接口（必须保持不变，后续所有Agent都依赖这个）：**

```typescript
// i-arena-agent.ts
export interface IArenaAgent {
  readonly id: string
  readonly name: string
  readonly owner: string           // 创建者标识
  readonly type: 'internal' | 'webhook'

  decide(
    snapshot: MarketSnapshot,      // 来自 @base-agent/core
    portfolio: VirtualPortfolio,
  ): Promise<ArenaSignal[]>

  // 可选，用于学习反馈
  onCycleResult?(
    signals: ArenaSignal[],
    executed: VirtualTrade[],
  ): Promise<void>
}

// i-settlement.ts
export interface ISettlementAlgorithm {
  readonly algorithm_id: string    // e.g. "softmax_v1"
  calculate_weights(
    results: AgentSeasonResult[],  // 只传有效完成赛季的Agent
    params: SettlementParams,
  ): Record<string, number>        // agent_id → 权重(0-1，总和必须=1)
}
```

**ArenaSignal 类型（链上验证用，字段名固定）：**

```typescript
// arena-signal.ts
export interface ArenaSignal {
  agent_id: string
  token: 'ETH' | 'cbBTC' | 'USDC'
  action: 'BUY' | 'SELL' | 'HOLD'
  amount_usd: number | null        // HOLD时为null
  confidence: number               // 0.0 - 1.0
  reason: string                   // 必填，公开展示
  timestamp: string                // ISO8601
  cycle_id: string
}
```

**ArenaEngine 主循环逻辑：**

```
每15分钟（从配置读取interval）：

1. 检查当前赛季是否active，不是则跳过
2. MarketPoller.poll() 拉取行情（一次，所有Agent共享）
3. Promise.allSettled() 并行发给所有Agent
   - InternalAgent: 走现有IPC + DecisionGate流程
   - WebhookAgent: HTTP POST，5秒超时，失败记录但不中断
4. 各Agent独立更新自己的VirtualPortfolio
5. 更新Leaderboard
6. 触发 onCycleComplete 钩子
7. 写入 state/arena/ 目录的JSON文件
8. （未来）WebSocket广播

赛季结束时：
1. 判定有效Agent（信号数>=3 且 执行>=1笔虚拟交易）
2. 无效Agent标记，押注退还
3. 有效Agent计算Softmax权重
4. 构建leaderboardHash（keccak256）
5. 触发 onSeasonEnd 钩子（链上同步在这里做）
```

**Softmax结算算法：**

```typescript
// settlement/softmax.ts
// 温度参数T控制差距大小，T越大赢家通吃越明显
// w_i = exp(ROI_i × T) / Σ exp(ROI_j × T)
// 只对有效Agent计算，无效Agent返回0权重
```

**有效Agent判定：**

```typescript
// 满足以下条件才参与结算
isValid(result: AgentSeasonResult): boolean {
  return result.signal_count >= MIN_SIGNALS       // 默认3
      && result.trade_count >= MIN_TRADES         // 默认1
      && result.status !== 'disqualified'
}
// 无效Agent的staked代币全额退还，不参与Softmax
```

---

### 2. packages/api-server

REST API + WebSocket 实时推送。

**需要实现的文件：**

```
packages/api-server/src/
  server.ts              Express + ws 服务器
  routes/
    arena.ts             Arena路由
  ws/
    broadcaster.ts       WebSocket广播
  package.json
  tsconfig.json
```

**API 路由（v1，向后兼容）：**

```
GET  /api/v1/leaderboard           当前赛季排行榜
GET  /api/v1/leaderboard/history   历史赛季排名
GET  /api/v1/season/current        当前赛季状态
GET  /api/v1/agents                所有Agent列表
GET  /api/v1/agents/:id            单个Agent详情
GET  /api/v1/agents/:id/trades     某Agent的虚拟交易历史
GET  /api/v1/agents/:id/signals    某Agent的信号历史
GET  /health                       服务健康检查

WebSocket /ws
  推送事件:
    cycle_complete   每次决策周期结束
    leaderboard      排行榜更新
    season_start     新赛季开始
    season_end       赛季结束（含最终结果）
```

---

### 3. config/arena.yaml

**Arena 主配置（Agent 列表动态加载，加新Agent只改这个文件）：**

```yaml
arena:
  season_duration_days: 7
  starting_virtual_usd: 10000
  cycle_interval_minutes: 15
  min_agents_to_start: 2
  min_signals_to_qualify: 3       # 有效完成赛季的最低信号数
  min_trades_to_qualify: 1        # 有效完成赛季的最低交易数
  webhook_timeout_seconds: 5

settlement:
  algorithm: "softmax_v1"
  temperature: 2.0                # Softmax温度参数

agents:
  - id: "thunder"
    name: "Thunder"
    enabled: true
    type: "internal"
    llm:
      provider: "anthropic"
      model: "claude-sonnet-4-6"
    strategy_weights:
      trend_swap: 0.7
      momentum: 0.3

  - id: "frost"
    name: "Frost"
    enabled: true
    type: "internal"
    llm:
      provider: "openai"
      model: "gpt-4o"
    strategy_weights:
      rebalance: 0.6
      limit_orders: 0.4

  - id: "aurora"
    name: "Aurora"
    enabled: true
    type: "internal"
    llm:
      provider: "gemini"
      model: "gemini-2.0-flash"
    strategy_weights:
      dca: 0.4
      momentum: 0.6

  # 外部接入示例（Webhook）
  # - id: "external-ninja"
  #   name: "Ninja"
  #   enabled: false
  #   type: "webhook"
  #   webhook_url: "https://user-server.com/decide"
  #   webhook_secret: "your-hmac-secret"
```

---

## 架构约束（必须遵守）

### 1. 不能改的接口

以下类型/接口一旦定义就不能修改字段名（链上和IPC依赖）：

- `MarketSnapshot`（TypeScript + Python都用）
- `StrategySignal` / `SignalBatch`（IPC协议）
- `ArenaSignal`（链上Merkle验证）
- `IArenaAgent.decide()` 签名
- Webhook Request/Response格式
- API路由路径（/api/v1/...）

### 2. 可以扩展的部分

- 任何接口可以**新增**字段（向后兼容）
- 不能**删除或重命名**现有字段
- 新策略：在 python/strategies/ 新建 .py 文件继承 BaseStrategy
- 新Agent：在 config/arena.yaml 追加配置段

### 3. 数据存储

```
state/
  portfolio.json          单Agent模式的持仓状态
  signals.json            最近的信号记录
  agent_memory.json       AI滚动记忆
  arena/                  Arena专用（需要新建）
    season_current.json   当前赛季状态
    leaderboard.json      最新排行榜
    agent-{id}.json       各Agent虚拟持仓快照
    seasons/
      season-{id}.json    历史赛季完整结果
```

### 4. 错误处理原则

- **单个Agent失败不影响其他Agent**（Promise.allSettled）
- **Webhook超时**：记录失败次数，连续3次超时标记该赛季内失联
- **IPC断开**：自动重连，最多3次，全部失败则跳过本次cycle
- **LLM失败**：切换fallback provider，全部失败则信号不执行（安全优先）

---

## 当前已知问题

| 问题 | 文件 | 状态 |
|---|---|---|
| `chain: 'bnb'` 未更新 | `swap-executor.ts` 第83/106行 | 待修复 |
| arena-coordinator 未实现 | `packages/arena-coordinator/` | 待实现 |
| api-server 路由未实现 | `packages/api-server/` | 待实现 |
| arena.yaml 不存在 | `config/arena.yaml` | 待创建 |

---

## 你的任务

按以下优先级执行：

**P0（立即修复）：**
1. 修复 `packages/moonpay-client/src/swap-executor.ts` 第83行和106行的 `chain: 'bnb'` → `chain: 'base'`

**P1（核心实现）：**
2. 实现 `packages/arena-coordinator/` 所有文件
3. 创建 `config/arena.yaml`
4. 更新 `pnpm-workspace.yaml` 和根 `package.json` 加入新包

**P2（接口层）：**
5. 实现 `packages/api-server/` (Express + WebSocket)
6. 实现 `cli/src/commands/arena.ts` (arena start/status/leaderboard命令)

**P3（验证）：**
7. 运行 `pnpm build` 验证TypeScript编译无错误
8. 运行 `python -c "from strategies import *; print('OK')"` 验证Python导入正常

---

## 重要背景：为什么这样设计

- **不是产品，是协议**：我们不收手续费，靠持有代币升值盈利
- **开放性第一**：任何人可以接入Agent，接口固定保证未来兼容
- **链上可验证**：所有决策最终通过Merkle Proof上链，不可篡改
- **零资金风险**：默认paper模式，Agent只做模拟交易，真实资金只在合约里（代币）
- **可扩展**：加新Agent/策略/算法都只改配置或加文件，不动核心代码

---

## 参考：Webhook接入规范（给外部开发者的接口，审计重点）

```
POST {外部服务器URL}
Headers:
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

响应体（5秒内返回）:
{
  "signals": [
    {
      "token": "ETH",
      "action": "BUY",
      "amount_usd": 100,
      "confidence": 0.8,
      "reason": "ETH RSI oversold at 28, expecting bounce"
    }
  ]
}
```

---

阅读完毕后，先确认你理解了整个系统，然后开始执行任务。
从 P0 开始，每完成一个任务告诉我，再继续下一个。
