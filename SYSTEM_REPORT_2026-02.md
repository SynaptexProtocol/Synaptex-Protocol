# Arena Protocol - 当前系统完整报告（修订版，源码基准 2026-02）

## 1. 当前系统总览
Arena Protocol 目前是“本地可完整运行 + 云部署可选”的 Web4 AI 竞技系统。  
系统支持四类 Agent（`internal/webhook/stdio/sdk`）参与模拟交易竞技；每周期会生成承诺与重放日志，赛季可走链上结算链路。  
当前可在本地无云部署完成端到端运行；Railway/Vercel/PostgreSQL 已有部署骨架，但不是本地开发必需条件。

## 2. 已实现能力清单
### 2.1 引擎层
- `ArenaEngine` 周期执行、赛季生命周期、实时排行榜。
- `VirtualPortfolioManager` 虚拟持仓与 ROI 更新。
- 周期承诺：`cycle_commitments.jsonl`。
- 决策重放：`agent_decision_replay.jsonl`（含请求/响应哈希与 trace 元数据）。
- 结算算法：softmax 权重计算。

### 2.2 接入层（4 类 Agent）
- `internal`：IPC -> Python 策略 -> 决策门控。
- `webhook`：HMAC、超时、响应清洗、失败计数。
- `stdio`：子进程执行（`shell=false`）、超时、输出大小限制。
- `sdk`：本地模块动态加载，调用 `decide(input)`。

统一校验：
- action: `BUY|SELL|HOLD`
- token: `ETH|cbBTC|USDC`
- 非 HOLD 需正 `amount_usd`
- 信号数量上限、reason 长度上限、confidence clamp。

### 2.3 API 层（Phase 1）
- `GET /health`
- `GET /api/v1/auth/siwe/nonce`
- `POST /api/v1/auth/siwe/verify`
- `GET /api/v1/auth/session`
- `GET/POST/PATCH/DELETE /api/v1/registry/agents`
- `GET /api/v1/registry/health`
- `GET /api/v1/leaderboard`
- `GET /api/v1/season/current`
- `GET /api/v1/agents/:id/trades`
- `GET /api/v1/replay/decisions`
- `WS /ws`

附加能力：
- Bearer 会话鉴权
- owner 地址绑定
- 幂等键（`X-Idempotency-Key`）
- 审计日志（jsonl）

### 2.4 链上层
- `ArenaVault`：stake/settle/claim/claimAgent/claimAgents，含 `nonReentrant`。
- `SeasonSettler`：提交赛季结果，权限控制与暂停。
- `LearningRootOracle`：周期 root 提交与幂等保护。
- `AgentNFA/AgentAccountRegistry/AgentAccount`：身份与账户基础设施。

### 2.5 运维层
- `arena preflight/start/status/leaderboard/ops-report`
- `arena sync-learning/bootstrap-onchain/export-sql/db-init`
- 本地 smoke 脚本与 mock agent 脚本齐全。

## 3. 仍未完成 / 半完成项
### 高优先
- SIWE strict 当前依赖 `cast wallet verify`，应改为纯 JS 验签（跨平台）。
- PostgreSQL 运行时尚未替换 JSON store（当前是 schema + 导出迁移链路）。
- 前端虽有 `web/` 骨架，但功能页仍是最小版本，未达到完整产品面。

### 中优先
- `ArenaVault` 新增 claim 路径的边界测试仍可继续补齐（混合领取路径）。
- `sdk/stdio` 多租户隔离仍不足（当前是本地优先实现）。

### 低优先
- 幂等存储和本地 JSON 写入在高并发下仍有竞态空间。

## 4. 本地可运行闭环（修订）
1. `pnpm -r build`
2. 启动 Python IPC（按项目现有方式）
3. `node cli/dist/index.js arena start --config config/arena.yaml --agent-config config/agent.yaml`
4. 验证：
   - `GET /health`
   - `GET /api/v1/leaderboard`
5. 一键 smoke：`powershell -ExecutionPolicy Bypass -File scripts/local_e2e_smoke.ps1`

> 注意：CLI 当前参数是 `--config` + `--agent-config`，不是 `--arena-config/--state-dir`。

## 5. 结论（简版）
- 核心引擎和四类接入已落地，可本地完整运行。
- 安全与运维基础已形成闭环（鉴权、幂等、审计、preflight、smoke）。
- 下一步重点应放在：SIWE 纯 JS 验签、PostgreSQL 运行时集成、前端功能完善。
