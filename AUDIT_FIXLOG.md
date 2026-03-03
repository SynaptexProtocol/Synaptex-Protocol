# Audit Fix Log (2026-02-24)

## Code Changes
- `packages/moonpay-client/src/swap-executor.ts`
  - Fixed `chain` from `'bnb'` to `'base'` in live `SwapReceipt`.
  - Fixed `chain` from `'bnb'` to `'base'` in persisted `Trade`.
- `packages/core/src/types/market.ts`
  - Updated `PortfolioState` comments to match Base context:
    - `nativeBalance` comment: `ETH`
    - `stableBalance` comment: `USDC`
- `packages/scheduler/src/cron-engine.ts`
  - Added schedule-to-strategies mapping.
  - Each cron trigger now runs only the strategies bound to that schedule.
  - Preserved immediate startup cycle for all active strategies.

## Documentation Changes
- `AUDIT.md`
  - Removed fixed issues from the "已知问题" table.
  - Added "已在 2026-02-24 修复" section.
  - Corrected retry default delay from `300ms` to `1000ms`.
  - Corrected IPC strategy execution description from "并行" to "串行（按 activeStrategies）".
  - Updated scheduler behavior description to reflect cron-grouped strategy execution.

## Additional Fixes (2026-02-24)
- `packages/arena-coordinator/src/arena-engine.ts`
  - Added `getSnapshot()` config and wired internal cycle runner to actually execute cycles.
  - Fixed `start()` state handling so `running` is only set after start prerequisites pass.
  - Added immediate first cycle execution on start.
  - Added disqualification-aware season status assignment (`valid`/`invalid`/`disqualified`).
  - Corrected realtime leaderboard `is_valid` calculation using configured thresholds.
- `packages/arena-coordinator/src/agents/internal-agent.ts`
  - Injected each agent's virtual portfolio into IPC snapshot portfolio fields.
  - Avoided dropping all signals when `riskVetoed=true` but approved signals still exist.
- `python/risk/manager.py`
  - Changed total exposure check to use projected exposure (`current + pending order`).
- `python/ipc/server.py`
  - Removed premature cooldown recording (risk pass does not guarantee execution).
- `cli/src/commands/arena.ts`
  - Added `MarketPoller`-based snapshot provider and passed it to `ArenaEngine`.
 - `packages/arena-coordinator/src/arena-engine.ts`
  - Realtime leaderboard validity now excludes disqualified agents.

## Additional Fixes (Execution-Synced Cooldown)
- `packages/core/src/types/ipc.ts`
  - Added IPC method literal: `record_trade`.
- `packages/ipc-bridge/src/ipc-client.ts`
  - Added `recordTrade(token)` RPC client method.
- `python/ipc/server.py`
  - Added `record_trade` JSON-RPC endpoint to update `RiskManager` cooldown state.
- `packages/scheduler/src/cron-engine.ts`
  - `onExecution` now returns executed tokens.
  - After successful execution, scheduler syncs token cooldown to Python via `ipc.recordTrade(token)`.
- `cli/src/index.ts`
  - `onExecution` now returns successfully executed token list for cooldown sync.

## Additional Fixes (Phase 2 Scaffold)
- `packages/arena-coordinator/src/types/season-settlement.ts`
  - Added canonical season settlement payload type:
    - `season_id`, `leaderboard_hash`, `merkle_root`, `weights`, `leaderboard`.
- `packages/arena-coordinator/src/interfaces/i-arena-hook.ts`
  - Extended `onSeasonEnd` hook signature with optional settlement payload.
- `packages/arena-coordinator/src/arena-engine.ts`
  - `settle()` now builds settlement payload and emits it via `onSeasonEnd`.
- `packages/arena-coordinator/src/index.ts`
  - Exported `SeasonSettlementPayload`.
- `cli/src/arena/season-submitter.ts`
  - Added pluggable season submitter interface with:
    - default logging submitter (safe no-op behavior),
    - optional HTTP submitter (`ARENA_SETTLEMENT_ENDPOINT`, `ARENA_SETTLEMENT_AUTH_TOKEN`).
- `cli/src/commands/arena.ts`
  - Wired `onSeasonEnd` hook to call configured season submitter.

## Additional Fixes (Season Submitter Hardening)
- `cli/src/arena/season-submitter.ts`
  - Added HTTP submit retries with exponential backoff.
  - Added request timeout handling via `AbortController`.
  - Added optional HMAC signature header:
    - `X-Arena-Settlement-Signature = HMAC_SHA256(body, ARENA_SETTLEMENT_HMAC_SECRET)`.
  - Added dead-letter queue persistence for failed submissions (`jsonl`).
- `.env.example`
  - Added settlement submitter environment variables:
    - `ARENA_SETTLEMENT_ENDPOINT`
    - `ARENA_SETTLEMENT_AUTH_TOKEN`
    - `ARENA_SETTLEMENT_HMAC_SECRET`
    - `ARENA_SETTLEMENT_TIMEOUT_MS`
    - `ARENA_SETTLEMENT_MAX_ATTEMPTS`
    - `ARENA_SETTLEMENT_BACKOFF_MS`
    - `ARENA_SETTLEMENT_DLQ_PATH`

## Additional Fixes (Submitter Config Robustness)
- `cli/src/arena/season-submitter.ts`
  - Added guarded numeric env parsing for submitter knobs:
    - `ARENA_SETTLEMENT_TIMEOUT_MS`
    - `ARENA_SETTLEMENT_MAX_ATTEMPTS`
    - `ARENA_SETTLEMENT_BACKOFF_MS`
  - Invalid/non-positive values now safely fall back to defaults instead of propagating `NaN`/invalid timings.
  - Normalized endpoint via `trim()` before enabling HTTP submit mode.

## Additional Fixes (Phase 2 Completion Batch)
- `packages/arena-coordinator/src/arena-engine.ts`
  - Added built-in market snapshot mode:
    - `getSnapshot` is now optional.
    - If omitted, engine uses internal `MarketPoller` with configurable `marketSymbols` (default `ETH/cbBTC/USDC`).
  - Added internal snapshot builder for self-managed polling cycles.
- `cli/src/commands/arena.ts`
  - Switched Arena startup to engine-managed polling (`marketSymbols` from `arena.yaml`).
  - Passed API server runtime config:
    - `stateDir` for history API source
    - `wsAuthToken` from `ARENA_WS_AUTH_TOKEN` or `api.ws_auth_token`
- `config/arena.yaml`
  - Added `arena.market_symbols` default list.
- `packages/api-server/src/routes/arena.ts`
  - Implemented `GET /api/v1/leaderboard/history?limit=...`
  - Reads archived seasons from `state/arena/seasons/*.json`, sorts by end time desc, supports bounded limit.
- `packages/api-server/src/server.ts`
  - Extended API server config with optional `stateDir` and `wsAuthToken`.
- `packages/api-server/src/ws/broadcaster.ts`
  - Added optional WebSocket token auth (`/ws?token=...` when configured).
  - Unauthorized clients are closed with code `1008`.
- `packages/core/src/types/market.ts`
  - Added optional `strategyWeights` on `MarketSnapshot`.
- `packages/arena-coordinator/src/agents/internal-agent.ts`
  - Now forwards per-agent `strategyWeights` to Python snapshot payload.
- `python/models/market.py`
  - Added optional `strategyWeights` field.
- `python/ipc/server.py`
  - Integrated `WeightedStrategyMixer` into default execution path when at least 2 weighted strategies are provided.
  - Keeps sequential fallback path for compatibility and resilience.
- `.env.example`
  - Added `ARENA_WS_AUTH_TOKEN`.

## Additional Fixes (On-Chain Settlement Execution)
- `cli/src/arena/season-submitter.ts`
  - Added on-chain settlement mode (`ARENA_SETTLEMENT_MODE=onchain`) using `cast send`.
  - Added direct contract invocation:
    - `submitSeasonResult(string,bytes32,bytes32,string[],uint256[])`
  - Added bytes32 hash validation for `leaderboard_hash` / `merkle_root`.
  - Added on-chain receipt persistence (`ARENA_SETTLEMENT_RECEIPTS_PATH`).
- `contracts/src/Ownable.sol`
  - Added minimal ownership module used by settlement contracts.
- `contracts/src/ArenaToken.sol`
  - Added minimal ERC20 token implementation (`ARENA`).
- `contracts/src/ArenaVault.sol`
  - Added staking vault, season weight settlement, and per-user claim logic.
- `contracts/src/SeasonSettler.sol`
  - Added season result submission contract that writes settlement hashes and applies weights to vault.
- `contracts/foundry.toml`
  - Added Foundry build configuration.
- `contracts/README.md`
  - Added deployment sequence and runtime wiring instructions.
- `.env.example`
  - Added on-chain settlement runtime vars:
    - `ARENA_SETTLEMENT_MODE`
    - `ARENA_CHAIN_RPC_URL`
    - `ARENA_SETTLER_CONTRACT`
    - `ARENA_SETTLER_PRIVATE_KEY`
    - `ARENA_SETTLEMENT_RECEIPTS_PATH`

## Additional Fixes (Emergency Controls + Commitment Persistence)
- `contracts/src/ArenaVault.sol`
  - Added emergency pause controls:
    - `paused` state
    - `pause()/unpause()` (owner-only)
    - `whenNotPaused` protection on `stake`, `setSeasonWeights`, `claim`.
- `contracts/src/SeasonSettler.sol`
  - Added emergency pause controls:
    - `paused` state
    - `pause()/unpause()` (owner-only)
    - `whenNotPaused` protection on `submitSeasonResult`.
- `contracts/test/ArenaVault.t.sol`
  - Added pause regression test:
    - `test_Revert_WhenPaused_Stake`
- `contracts/test/SeasonSettler.t.sol`
  - Added pause regression test:
    - `test_Revert_WhenPaused_Submit`
- `packages/arena-coordinator/src/arena-engine.ts`
  - Added cycle-level commitment persistence:
    - for every cycle, writes `cycle_id`, `signal_count`, `cycle_root` to
      `state/arena/cycle_commitments.jsonl`.
  - `cycle_root` is computed deterministically from per-cycle signal Merkle leaves.

## Additional Fixes (Web4 Identity + Account + Learning Root MVP)
- `contracts/src/AgentNFA.sol`
  - Added on-chain agent identity NFT (ERC-721 style):
    - mint/register agent id
    - ownership transfer and approvals
    - one agent id -> one token guard.
- `contracts/src/AgentAccount.sol`
  - Added token-bound account contract:
    - owner resolved from NFA token owner
    - owner-authorized generic execution (`executeCall`).
- `contracts/src/AgentAccountRegistry.sol`
  - Added deterministic account registry (ERC-6551-style):
    - deterministic `accountAddress(...)`
    - `createAccount(...)` via CREATE2.
- `contracts/src/LearningRootOracle.sol`
  - Added cycle-level learning root commitment contract:
    - `submitCycleRoot(seasonId, cycleId, root)`
    - immutable duplicate guard per season+cycle
    - owner pause/unpause controls.
- `contracts/script/Deploy.s.sol`
  - Extended deployment to include:
    - `AgentNFA`
    - `AgentAccountRegistry`
    - `LearningRootOracle`.
- `contracts/test/AgentNFA.t.sol`
  - Added 4 tests covering mint, permission, owner transfer, approved transfer.
- `contracts/test/AgentAccountRegistry.t.sol`
  - Added 3 tests covering deterministic account, owner-follow semantics, execute permission.
- `contracts/test/LearningRootOracle.t.sol`
  - Added 4 tests covering submit, duplicate guard, pause gate, owner gate.
- `.env.example`
  - Added placeholders for new contract addresses:
    - `AGENT_NFA_CONTRACT`
    - `AGENT_ACCOUNT_REGISTRY`
    - `LEARNING_ROOT_ORACLE`

## Additional Fixes (Cycle Root Auto On-Chain Submit)
- `packages/arena-coordinator/src/interfaces/i-arena-hook.ts`
  - Extended `CycleCompleteEvent` with:
    - `seasonId`
    - `cycleRoot`
- `packages/arena-coordinator/src/arena-engine.ts`
  - `onCycleComplete` hook payload now includes per-cycle `cycleRoot`.
  - Continues persisting `cycle_commitments.jsonl`.
- `cli/src/arena/learning-root-submitter.ts`
  - Added on-chain learning root submitter using:
    - `submitCycleRoot(string,string,bytes32)` on `LearningRootOracle`
    - `cast send` with `ETH_PRIVATE_KEY` in process env (no key in argv).
- `cli/src/commands/arena.ts`
  - Wired `onCycleComplete` to auto-submit cycle root on each cycle.
- `.env.example`
  - Added `ARENA_LEARNING_RECEIPTS_PATH`.

## Additional Fixes (Agent Auto Registration On Startup)
- `cli/src/arena/agent-identity-registrar.ts`
  - Added startup-time on-chain registrar:
    - ensures agent NFA exists (`mintAgent` if missing)
    - ensures deterministic TBA is created via account registry (`createAccount`)
    - supports secure key injection via `ETH_PRIVATE_KEY` env for cast.
- `cli/src/commands/arena.ts`
  - Added registrar wiring in agent bootstrapping loop:
    - each enabled agent is ensured on-chain before runtime registration.
- `.env.example`
  - Added startup registration controls:
    - `ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION`
    - `ARENA_AGENT_NFA_MINT_TO`
    - `ARENA_AGENT_TOKEN_URI_PREFIX`
    - `ARENA_AGENT_TBA_SALT`
    - `ARENA_AGENT_REGISTRATION_LOG_PATH`

## Additional Fixes (Operational CLI Commands)
- `cli/src/commands/arena.ts`
  - Added `arena bootstrap-onchain`:
    - Ensures all enabled agents in `arena.yaml` are registered on-chain (NFA + TBA),
      without starting the engine.
  - Added `arena sync-learning --limit N`:
    - Replays local `state/arena/cycle_commitments.jsonl` rows to `LearningRootOracle`
      for backlog recovery.
- `packages/arena-coordinator/src/arena-engine.ts`
  - `cycle_commitments.jsonl` rows now include `season_id` to support replay tooling.

## Additional Fixes (Learning Sync Idempotency)
- `contracts/src/LearningRootOracle.sol`
  - Added query helper:
    - `hasCycleRoot(seasonId, cycleId) -> bool`
- `contracts/test/LearningRootOracle.t.sol`
  - Extended assertions to verify `hasCycleRoot(...)` behavior.
- `cli/src/arena/learning-root-submitter.ts`
  - Added pre-submit existence check against oracle to skip already-submitted cycles.
  - `submit(...)` now returns status: `submitted` or `skipped`.
- `cli/src/commands/arena.ts`
  - `arena sync-learning` now reports:
    - `submitted`
    - `skipped`
    - `failed`
  - Safe to re-run repeatedly without duplicate on-chain errors for existing cycles.

## Additional Fixes (Learning Sync Resume Cursor)
- `cli/src/commands/arena.ts`
  - Added cursor-based resume for `arena sync-learning`:
    - stores cursor to `sync_learning_cursor.json`
    - next run resumes from last successful/advanced row
    - on submit failure, cursor stays at failed row for retry.
  - Added `--reset-cursor` option to restart replay from the beginning.
  - Added output fields:
    - `cursor=<from>-><to>`
    - `scanned=<n>`
- `.env.example`
  - Added `ARENA_SYNC_LEARNING_CURSOR_PATH` for custom cursor file location.

## Additional Fixes (Production Alerting Webhook)
- `cli/src/ops/alert-notifier.ts`
  - Added generic alert notifier with:
    - webhook delivery
    - timeout/retry/backoff
    - auth header support
    - dead-letter jsonl persistence.
- `cli/src/commands/arena.ts`
  - Wired alerts for:
    - learning root submit failures
    - season settlement submit failures
    - per-agent runtime errors (`onAgentError`).
- `.env.example`
  - Added alerting env vars:
    - `ARENA_ALERT_WEBHOOK_URL`
    - `ARENA_ALERT_AUTH_TOKEN`
    - `ARENA_ALERT_TIMEOUT_MS`
    - `ARENA_ALERT_MAX_ATTEMPTS`
    - `ARENA_ALERT_BACKOFF_MS`
    - `ARENA_ALERT_DLQ_PATH`

## Additional Fixes (Alert Routing by Level)
- `cli/src/ops/alert-notifier.ts`
  - Added level-based alert routing:
    - `warn` can route to `ARENA_ALERT_WEBHOOK_URL_WARN`
    - `error` can route to `ARENA_ALERT_WEBHOOK_URL_ERROR`
  - Added fallback behavior:
    - if level endpoint is missing, fallback to `ARENA_ALERT_WEBHOOK_URL`
  - Added optional per-level auth token override:
    - `ARENA_ALERT_AUTH_TOKEN_WARN`
    - `ARENA_ALERT_AUTH_TOKEN_ERROR`
    - fallback to `ARENA_ALERT_AUTH_TOKEN`
  - Preserved retry/timeout/backoff/DLQ logic.
- `.env.example`
  - Added level routing variables:
    - `ARENA_ALERT_WEBHOOK_URL_WARN`
    - `ARENA_ALERT_WEBHOOK_URL_ERROR`
    - `ARENA_ALERT_AUTH_TOKEN_WARN`
    - `ARENA_ALERT_AUTH_TOKEN_ERROR`

## Additional Fixes (Ops Hardening: Preflight + Anti-Storm + Report)
- `cli/src/ops/alert-notifier.ts`
  - Added alert anti-storm controls:
    - dedup window (`ARENA_ALERT_DEDUP_WINDOW_MS`)
    - rate limit window (`ARENA_ALERT_RATE_LIMIT_WINDOW_MS`)
    - rate limit max (`ARENA_ALERT_RATE_LIMIT_MAX`)
- `cli/src/commands/arena.ts`
  - Added `arena preflight` runtime validator.
  - `arena start` now executes preflight checks before startup.
  - Added `arena ops-report` markdown report generator.
  - Fixed `arena status/leaderboard` state-dir resolution to follow `arena.yaml`.
- `.env.example`
  - Added anti-storm env vars:
    - `ARENA_ALERT_DEDUP_WINDOW_MS`
    - `ARENA_ALERT_RATE_LIMIT_WINDOW_MS`
    - `ARENA_ALERT_RATE_LIMIT_MAX`
  - Added optional cast binary override:
    - `ARENA_CAST_BIN`
- `OPERATIONS_SOP.md`
  - Added daily and incident SOP for runtime operations.
- `cli/src/arena/*.ts` + `cli/src/commands/arena.ts`
  - Added `ARENA_CAST_BIN` support for Windows/runtime environments where PATH lookup is restricted.
  - Added signer mode support for cast send:
    - keystore (`ARENA_SIGNER_KEYSTORE` + optional password)
    - private-key arg (`ARENA_SIGNER_PRIVATE_KEY` / `ARENA_SETTLER_PRIVATE_KEY`)
    - unlocked mode (`ARENA_CAST_USE_UNLOCKED=1`, `ARENA_CAST_FROM`)
  - Reworked cast process execution to use temp-file stdio redirection (avoids EPERM in restricted Windows pipe mode).

## Additional Fixes (2026-02-25 — Final Audit Pass)

### HIGH: cast-signer.ts private key argv exposure
- `cli/src/arena/cast-signer.ts`
  - Attempted ETH_PRIVATE_KEY env injection; reverted after confirming Foundry 1.6.0-rc1 does NOT support `ETH_PRIVATE_KEY` env var for `cast send`.
  - Final state: `--private-key` arg is unavoidable for raw-key mode in this Foundry version.
  - Added clear comment documenting the constraint and recommending keystore as production alternative.
  - `arena preflight` already warns when raw private key env is detected.
  - Recommended production path: `ARENA_SIGNER_KEYSTORE` (uses `--keystore` flag, key never in argv).

### MEDIUM: agent-identity-registrar.ts duplicate createAccount on restart
- `cli/src/arena/agent-identity-registrar.ts`
  - Added pre-check using `cast code <address>` before `createAccount`:
    - if code at TBA address is non-empty (`!= 0x`), skip `createAccount` entirely.
  - Reordered to compute `accountAddress` (read-only) before any write call.
  - Result: second `arena bootstrap-onchain` run confirmed fully idempotent (no re-deploy, no wasted gas).

### Validation (2026-02-25 — anvil end-to-end confirmed)
- `forge test -q`: 29 passed, 0 failed
- `pnpm --filter @base-agent/cli build`: clean
- `arena preflight` (paper mode): PASS — 2 expected WARNs
- `arena preflight` (onchain mode, all env set): PASS — 3 expected WARNs
- `arena ops-report`: PASS — markdown generated
- `arena bootstrap-onchain` run 1: 3 agents registered (NFA minted + TBA deployed)
- `arena bootstrap-onchain` run 2 (idempotency): PASS — no re-mints

## Additional Fixes (2026-02-25 — signer safety gate + lifecycle run)
- `cli/src/arena/cast-signer.ts`
  - Added hard safety gate for raw private-key signer:
    - blocked by default
    - requires explicit `ARENA_ALLOW_INSECURE_PRIVATE_KEY=1` override
  - Keeps keystore and unlocked modes as preferred defaults.
- `cli/src/commands/arena.ts`
  - `arena preflight` now reports raw-key blocked condition as `ERROR` in onchain mode.
  - Added keystore path existence check (`ARENA_SIGNER_KEYSTORE`).
- `.env.example`
  - Added `ARENA_ALLOW_INSECURE_PRIVATE_KEY=0`.
- `MAINNET_RUNBOOK.md` / `OPERATIONS_SOP.md`
  - Documented raw-key default block and override semantics.

### Runtime verification (paper lifecycle)
- Started Python IPC + Arena runtime and confirmed immediate first cycle execution.
- Generated and verified:
  - `state/arena/cycle_commitments.jsonl` (new cycle row persisted)
  - `arena sync-learning --limit 50` completed with cursor advance
  - `state/arena/ops_report.md` generated and populated

## Additional Fixes (2026-02-25 - Executor + Claim Hardening)
- `packages/swap-executor/src/executors/coinbase.ts`
  - Fixed SELL sizing logic:
    - no longer sends USD value as `base_size`
    - now fetches product price and converts USD target to token base size.
- `packages/swap-executor/src/executors/uniswap-v3.ts`
  - Removed unsafe default zero-slippage execution path.
  - BUY now requires explicit `amountOutMinimum` configuration unless `allowUnsafeZeroMinOut=true`.
  - SELL path is blocked until safe base-size conversion is implemented.
- `contracts/src/ArenaVault.sol`
  - Added per-agent claim path:
    - `claimAgent(seasonId, agentId)`
    - `userClaimedBySeasonAgent` tracking to prevent double-claim per agent.
  - `claim()` now skips already-claimed agents and marks per-agent claim states.
- `contracts/test/ArenaVault.t.sol`
  - Added tests:
    - `test_ClaimAgent_SinglePath`
    - `test_Revert_ClaimAgent_DoubleClaim`

## Additional Fixes (2026-02-25 — full lifecycle + pause/unpause drill)

### Full lifecycle run (anvil, 2026-02-25)
- Deployed all 6 contracts via `Deploy.s.sol` (local anvil).
- `arena preflight` (paper mode): PASS — 2 WARNs (expected).
- `arena preflight` (onchain, raw key): ERROR — blocked by safety gate ✓.
- `arena bootstrap-onchain` run 1: thunder/frost/aurora NFA minted + TBA deployed.
- `arena bootstrap-onchain` run 2 (idempotency): PASS — no re-mints, no re-deploys ✓.
- Python IPC started from project root (required for config path resolution).
- `arena start`: first cycle executed immediately, `cycle_commitments.jsonl` updated (2 rows).
- `arena sync-learning --limit 50`: `submitted=0, skipped=0, failed=0, scanned=1, cursor=2->3` ✓.
- `arena ops-report`: markdown generated with populated season/leaderboard/pipeline data ✓.

### Pause/unpause contract drill (cast send, anvil)
All 3 contracts drilled — pause then unpause, verified via `cast call paused()`:

| Contract | pause tx | paused=true | unpause tx | paused=false |
|---|---|---|---|---|
| ArenaVault | 0x6809829f... | ✓ | 0x24c56502... | ✓ |
| SeasonSettler | 0x70bd78ee... | ✓ | 0x82067f06... | ✓ |
| LearningRootOracle | 0x3cc9a719... | ✓ | 0xaaf3dfa7... | ✓ |

## Gate Run (2026-02-25 — release gate + baseline lockdown)

### Release Baseline
- SHA256 manifest generated: `state/release_baseline/20260225T082455Z/hashes.json` (16 files)
- Baseline zip archived: `state/release_baseline/20260225T082455Z/release_baseline_20260225T082455Z.zip` (37857 bytes)
- Summary: `state/release_baseline/20260225T082455Z/baseline_summary.json`

### Mainnet Fork Attempt
- `anvil --fork-url https://mainnet.base.org --port 8546`
- Result: **SUCCESS** — chain_id `0x2105` (Base, 8453) reachable.
- Gate used local anvil (not fork) to avoid deploying against live Base state.

### Gate Chain (local anvil, 2026-02-25)
- `forge script Deploy.s.sol:Deploy --broadcast` → 6 contracts deployed ✓
- `arena preflight` (keystore mode): PASS — 2 WARNs (expected) ✓
- `arena preflight` (raw key, no ALLOW_INSECURE): ERROR → blocked ✓
- `arena bootstrap-onchain` run 1: thunder/frost/aurora NFA+TBA registered ✓
- `arena bootstrap-onchain` run 2: PASS — idempotent, no re-mints ✓
- Python IPC: IPC:OK on port 7890 ✓
- `arena start` → cycle_commitments.jsonl updated (3 rows) ✓
- `arena sync-learning --limit 50` → `scanned=1, cursor=3->4` ✓
- `arena ops-report` → `cycle_count=3`, DLQ=0 ✓
- Pause/unpause drill (all 3 contracts): all confirmed ✓

Evidence archived to `state/gate_run/` (gate_summary.json, cycle_commitments.jsonl, ops_report.md, sync_learning_cursor.json, logs).

## Additional Fixes (2026-02-25 - Vault Reentrancy + Bounded Claims)
- `contracts/src/ArenaVault.sol`
  - Added `nonReentrant` guard to:
    - `stake`
    - `claim`
    - `claimAgent`
  - Added bounded batch claim entry:
    - `claimAgents(seasonId, agentIds[])`
    - allows users to claim by selected subset of agents in one tx, reducing full-loop pressure.
- `contracts/test/ArenaVault.t.sol`
  - Added tests:
    - `test_ClaimAgents_BatchPath`
    - `test_Revert_ClaimAgents_Empty`

## Additional Fixes (2026-02-25 - Webhook Protocol v2 + Replay Audit Trail)
- `packages/arena-coordinator/src/agents/webhook-agent.ts`
  - Upgraded webhook request envelope to protocol v2 fields:
    - `schema_version`
    - `trace_id`
    - `idempotency_key`
    - `agent_id`
    - `season_id`
  - Added outbound headers:
    - `X-Arena-Version: 2.0`
    - `X-Arena-Trace-Id`
    - `X-Arena-Idempotency-Key`
    - `X-Arena-Signature`
  - Added per-decision metadata capture (`trace/idempotency/request_hash/response_hash/latency_ms`).
- `packages/arena-coordinator/src/interfaces/i-arena-agent.ts`
  - Added optional `getLastDecisionMeta()` for audit metadata extraction.
- `packages/arena-coordinator/src/arena-engine.ts`
  - Added deterministic replay log output:
    - `state/arena/agent_decision_replay.jsonl`
  - Each row now persists cycle-level audit hashes:
    - snapshot hash
    - portfolio before/after hash
    - signals hash
    - counts + error + trace metadata

## Additional Fixes (2026-02-25 - Phase 1 Backend Scaffold)
- `packages/api-server/src/routes/auth.ts`
  - Added SIWE-style auth endpoints:
    - `GET /api/v1/auth/siwe/nonce`
    - `POST /api/v1/auth/siwe/verify`
    - `GET /api/v1/auth/session`
  - Added nonce/session lifecycle handling and TTL controls.
- `packages/api-server/src/auth/siwe-session-store.ts`
  - Added persistent local store for nonces and sessions (`state/arena/siwe_sessions.json`).
- `packages/api-server/src/routes/agent-registry.ts`
  - Added external agent registration API:
    - `GET /api/v1/registry/agents`
    - `GET /api/v1/registry/agents/:id`
    - `POST /api/v1/registry/agents`
- `packages/api-server/src/registry/agent-registry-store.ts`
  - Added persistent local registry store (`state/arena/agent_registry.json`).
- `packages/api-server/src/server.ts`
  - Wired new auth + registry routers into API server.
  - Added SIWE config knobs to `ApiServerConfig`.
- `cli/src/commands/arena.ts`
  - Passed SIWE runtime env knobs to API server startup.
- `packages/api-server/db/schema.sql`
  - Added PostgreSQL baseline schema for:
    - users / siwe_nonces / sessions / agents / seasons / cycles / decision_replay.
- `.env.example`
  - Added Phase 1 scaffold env vars:
    - `ARENA_DATABASE_URL`
    - `ARENA_SIWE_NONCE_TTL_SECONDS`
    - `ARENA_SIWE_SESSION_TTL_SECONDS`
    - `ARENA_SIWE_ENFORCE_SIGNATURE_VERIFY`
- `packages/api-server/src/routes/auth.ts`
  - Strict SIWE mode now performs cryptographic signature verification via `cast wallet verify`.
- `packages/api-server/src/routes/arena.ts`
  - Added `GET /api/v1/replay/decisions?limit=N` to inspect latest deterministic replay rows.
- `cli/src/commands/arena.ts`
  - Preflight now checks SIWE strict-mode dependency on `cast wallet verify`.
  - Preflight warns when `ARENA_DATABASE_URL` is missing (JSON-store fallback in use).
- `packages/api-server/src/routes/agent-registry.ts`
  - Added session-gated write path for `POST /api/v1/registry/agents` (Bearer token required).
  - Enforced owner binding: `owner_address` must equal authenticated session wallet.
  - Added idempotency support via `X-Idempotency-Key` with payload hash conflict detection.
- `packages/api-server/src/registry/idempotency-store.ts`
  - Added local idempotency store for registry writes.
- `packages/api-server/src/ops/audit-log.ts`
  - Added jsonl audit sink for auth/registry actions.
- `packages/api-server/src/routes/auth.ts`
  - Added audit logging for nonce/verify/session endpoints.
- `packages/api-server/src/server.ts`
  - Wired idempotency store + audit log into auth and registry routers.
- `cli/src/commands/arena.ts`
  - Added `arena export-sql` command to export local JSON/JSONL state into PostgreSQL-compatible upsert SQL script.
  - Covers agents, siwe nonces/sessions, current season, cycle commitments, and decision replay rows.
- `packages/arena-coordinator/src/agents/webhook-agent.ts`
  - Added strict response sanitization:
    - validates action/token enum
    - validates non-HOLD amount
    - clamps confidence
    - truncates reason length
    - caps accepted signals per cycle
- `config/arena.yaml` + `cli/src/commands/arena.ts`
  - Added webhook guardrail knobs:
    - `webhook_max_signals_per_cycle`
    - `webhook_max_reason_length`
- `cli/src/commands/arena.ts`
  - Runtime now auto-registers enabled webhook agents from `state/arena/agent_registry.json`.
  - Duplicate IDs are deduped (static `arena.yaml` entries take precedence).
  - Registry rows with `sdk`/`stdio` are persisted but skipped in current runtime phase.
- `packages/arena-coordinator/src/agents/process-agent.ts`
  - Added stdio runner agent:
    - spawns command per cycle
    - stdin JSON request envelope
    - stdout JSON signal parsing + sanitization
    - timeout/stdout-size guardrails
- `packages/arena-coordinator/src/interfaces/i-arena-agent.ts`
  - Added `stdio` as a supported agent type.
- `cli/src/commands/arena.ts` + `config/arena.yaml`
  - Runtime now supports registry `connection_type=stdio`.
  - Added stdio guardrail knobs (`stdio_timeout_seconds`, `stdio_max_stdout_bytes`).
- `cli/src/commands/arena.ts`
  - Added `arena db-init` command to apply PostgreSQL schema via `psql`.
- `deploy/postgres/docker-compose.yml`
  - Added local PostgreSQL bootstrap compose for Phase 1 backend.
- `cli/src/commands/arena.ts` + `packages/api-server/src/server.ts`
  - Added cloud runtime compatibility:
    - respects `PORT` for Railway
    - configurable host (`ARENA_API_HOST`)
    - configurable CORS (`ARENA_CORS_ORIGIN`)
- Added deployment scaffolding:
  - `railway.json`
  - `nixpacks.toml`
  - `deploy/RAILWAY_VERCEL_RUNBOOK.md`
  - `web/` minimal Next.js frontend template for Vercel
- `packages/api-server/src/registry/agent-registry-store.ts`
  - Added registry lifecycle methods: `setEnabled`, `remove`.
- `packages/api-server/src/routes/agent-registry.ts`
  - Added owner-authenticated lifecycle endpoints:
    - `PATCH /api/v1/registry/agents/:id/enable`
    - `DELETE /api/v1/registry/agents/:id`
- `cli/src/commands/arena.ts`
  - Added `secret_ref` env resolution for registry webhook agents:
    - `env://VAR_NAME` or `env:VAR_NAME`
- Added local development assets:
  - `LOCAL_DEV_QUICKSTART.md`
  - `scripts/mock_stdio_agent.py`
- Added local mock external agent scripts:
  - `scripts/mock_webhook_agent.py` (HTTP webhook at `:9001/decide`)
  - `scripts/mock_stdio_agent.py` (stdio JSON in/out)
- `LOCAL_DEV_QUICKSTART.md` updated with end-to-end local registration examples.
- `.env.example` added `ARENA_AGENT_SECRET_DEMO_WEBHOOK` for local secret-ref flow.
- Added local API smoke script:
  - `scripts/local_api_smoke.ps1`
  - validates nonce/verify/registry upsert/enable/delete flow against a running local API.
- `LOCAL_DEV_QUICKSTART.md` now includes one-command smoke test section.
- Added SDK integration path:
  - `packages/agent-sdk` new package (`@arena-protocol/agent-sdk`) with base types and helper.
  - `packages/arena-coordinator/src/agents/sdk-agent.ts` to run local module-based SDK agents.
  - Runtime now supports registry `connection_type=sdk`.
- Added local SDK mock and E2E helpers:
  - `scripts/mock_sdk_agent.mjs`
  - `scripts/local_e2e_smoke.ps1`
- Runtime SDK support finalized:
  - `packages/arena-coordinator/src/agents/sdk-agent.ts`
  - `cli` registry loader now supports `connection_type=sdk`.
- Added local E2E smoke harness:
  - `scripts/local_e2e_smoke.ps1`
- Workspace hardening:
  - `pnpm-workspace.yaml` switched to explicit package list to keep build deterministic in restricted local FS mode.
- `packages/arena-coordinator/src/agents/process-agent.ts`
  - Hardened stdio execution: removed `shell=true`, now parses command into executable + args and runs `shell=false`.
- `packages/api-server/src/routes/agent-registry.ts`
  - Added endpoint validation by connection type (webhook/sdk/stdio).
  - Added `GET /api/v1/registry/health` summary endpoint.
- Updated docs:
  - `PHASE1_BACKEND_API.md`
  - `LOCAL_DEV_QUICKSTART.md`
- `cli/src/commands/arena.ts`
  - `arena ops-report` now includes Registry/Auth section:
    - registry total/enabled/by_type
    - cached SIWE sessions/nonces
- Added revised project status report:
  - `SYSTEM_REPORT_2026-02.md`
  - corrected command examples and implementation status to match current source.
- Added ArenaVault mixed-claim edge tests:
  - `test_MixedClaimAgentThenClaim_RemainingPayoutOnly`
  - `test_MixedClaimAgentsSubsetThenClaim_CompletesSeason`
  - `test_Revert_ClaimAgents_UnknownOnly_NoPayout`
  - `forge test --match-contract ArenaVaultTest`: 16 passed.
- `packages/api-server/src/routes/auth.ts`
  - SIWE strict verification now supports pluggable command via `ARENA_SIWE_VERIFY_COMMAND`.
  - If custom command is unset, falls back to cast verifier.
- `packages/api-server/src/routes/arena.ts`
  - `GET /api/v1/replay/decisions` now supports `agent_id`, `season_id`, `offset` filters.
  - Added `GET /api/v1/audit/logs` with filter support (`category/action/status/actor/offset`).
- `.env.example`
  - Added `ARENA_SIWE_VERIFY_COMMAND` template variable.
- Fixed local smoke idempotency behavior:
  - `scripts/local_api_smoke.ps1` now uses per-run unique `X-Idempotency-Key` to avoid stale replay side-effects in repeated e2e runs.
- Re-ran `scripts/local_e2e_smoke.ps1`: PASS.

## Security Patch Addendum (2026-02-25, Batch 3)
- `contracts/src/AgentAccount.sol`
  - Fixed stale authorization risk after NFT ownership transfer:
    - introduced owner-scoped authorization map `authorizedCallersByOwner`.
    - `executeCall` now checks `authorizedCallersByOwner[currentOwner][caller]`.
    - legacy `authorizedCallers` mapping retained for storage compatibility only.
- `contracts/src/ArenaVault.sol`
  - Added upper bound for per-season agent set:
    - `MAX_AGENTS_PER_SEASON = 256`
    - enforced in both `stake` and `setSeasonWeights` when adding new season agent.
  - Goal: prevent unbounded growth of `seasonAgents` causing claim-path gas DoS.
- `contracts/src/SeasonSettler.sol`
  - Added `OwnershipTransferred` event emission in `initialize` and `transferOwnership`.
  - Updated upgrade-safety comment to avoid misleading fixed-slot wording.
- `contracts/src/LearningRootOracle.sol`
  - Added `OwnershipTransferred` event emission in `initialize` and `transferOwnership`.
  - Updated upgrade-safety comment to avoid misleading fixed-slot wording.
- `contracts/src/AgentNFA.sol`
  - Updated upgrade-safety comment to avoid misleading fixed-slot wording.
- `contracts/test/AgentAccountRegistry.t.sol`
  - Added `test_Authorization_DoesNotPersistAcrossOwnerTransfer`.
- `contracts/test/ArenaVault.t.sol`
  - Added `test_Revert_TooManyAgentsPerSeason_OnStake`.

## Security Patch Addendum (2026-02-25, Batch 4)
- `contracts/src/AgentNFA.sol`
  - Added ERC721-safe transfer paths:
    - `safeTransferFrom(address,address,uint256)`
    - `safeTransferFrom(address,address,uint256,bytes)`
  - Added receiver callback check against `IERC721Receiver.onERC721Received.selector`.
- `contracts/src/ArenaToken.sol`
  - Added configurable supply cap:
    - constructor now accepts `maxSupply`
    - `cap == 0` means uncapped (backward-compatible runtime mode)
    - mint now enforces cap when configured.
- `contracts/src/ArenaVault.sol`
  - Confirmed bounded agent-set protection on both paths (`stake` and `setSeasonWeights`).
- `contracts/test/AgentNFA.t.sol`
  - Added safe transfer tests:
    - `test_SafeTransferToReceiverContract`
    - `test_Revert_SafeTransferToNonReceiverContract`
- `contracts/test/ArenaToken.t.sol`
  - Added cap tests:
    - `test_CapEnforced_OnMint`
    - `test_Revert_InitialSupplyExceedsCap`
- `contracts/test/ArenaVault.t.sol`
  - Added `test_Revert_TooManyAgentsPerSeason_OnSetSeasonWeights`.
- `contracts/script/check-storage-layout.ps1`
  - Added storage layout snapshot gate script for upgradeable contracts.
- `contracts/storage-layout/*.json`
  - Generated fresh baseline snapshots for:
    - AgentNFA
    - SeasonSettler
    - LearningRootOracle
    - AgentAccount

## Security Patch Addendum (2026-02-25, Batch 5)
- `contracts/src/Ownable.sol`
  - Upgraded to two-step ownership transfer for non-upgradeable contracts:
    - `transferOwnership(newOwner)` now sets `pendingOwner`
    - `acceptOwnership()` finalizes transfer
  - Added `OwnershipTransferStarted` event.
- `contracts/src/ArenaToken.sol`
  - Token cap is now mandatory (`maxSupply > 0`).
  - Mint path always enforces cap.
- `contracts/src/AgentAccount.sol`
  - Added guardian-based emergency rescue methods for owner-unavailable accounts:
    - `rescueNative(...)`
    - `rescueERC20(...)`
  - Rescue only allowed when `owner() == address(0)` and caller is creating registry.
- `contracts/src/AgentAccountRegistry.sol`
  - Added beacon-owner-gated rescue entrypoints:
    - `rescueAccountNative(...)`
    - `rescueAccountERC20(...)`
- Tests added/updated:
  - `ArenaToken.t.sol`: zero-cap revert + two-step ownership flow
  - `AgentAccountRegistry.t.sol`: rescue success + non-owner revert
  - Existing suites updated for mandatory cap constructor.
- Validation:
  - `forge test` => 57 passed, 0 failed.

## Slither Static Analysis (2026-02-25, v0.11.5)

Tool: Slither 0.11.5 (Python 3.12.4)
Run: `slither . --filter-paths "lib/,test/"`
Initial findings: 31 results
Post-fix findings: 28 results

### Findings Resolved

#### HIGH: reentrancy-no-eth — SeasonSettler.submitSeasonResult
- **File**: `contracts/src/SeasonSettler.sol`
- **Issue**: `resultsBySeason[s]` state written after external calls to `vault.setSeasonWeights()` and `agentNFA.updateReputation()`. Violates CEI (Checks-Effects-Interactions) pattern.
- **Fix**: Moved `resultsBySeason[s] = SeasonResult({...})` to before the external calls.
- **Note**: Practical exploitability was minimal due to `onlyOwner` gate, but CEI is a hard invariant.
- **Validation**: `forge test` 57 passed, 0 failed.

#### LOW: constable-states — ArenaToken.name, ArenaToken.symbol
- **File**: `contracts/src/ArenaToken.sol`
- **Issue**: `string public name` and `string public symbol` are assignable state variables that never change.
- **Fix**: Changed to `string public constant name` and `string public constant symbol`.
- **Validation**: `forge test` 57 passed, 0 failed.

### Remaining Findings (Accepted / Won't Fix)

| Detector | Contract | Severity | Rationale |
|---|---|---|---|
| `uninitialized-local` | ArenaVault | LOW | Solidity default-init to 0 is correct; slither false positive for uint256 accumulators |
| `calls-loop` | SeasonSettler | MEDIUM | Bounded by `onlyOwner` + `MAX_AGENTS_PER_SEASON=256`; acceptable for settlement flow |
| `reentrancy-benign` | ArenaVault.stake | LOW | `nonReentrant` guard present; slither classifies as benign (no net ETH drain) |
| `reentrancy-events` | AgentAccount, AgentAccountRegistry | INFO | Events after external call is standard ERC pattern; no state impact |
| `missing-zero-check` | AgentAccount.initialize | LOW | BeaconProxy prevents zero-address init in practice; registry validates before call |
| `missing-zero-check` | AgentAccount.executeCall | LOW | `onlyAuthorized` gate; zero-address `to` will fail at EVM level with empty code |
| `missing-inheritance` | Multiple | INFO | Informal interfaces; explicit `is I*` declaration adds no security in these patterns |
| `timestamp` | SeasonSettler | INFO | Uses `block.timestamp` only for `settledAt` logging field, not for access control |
| `low-level-calls` | AgentAccount | INFO | Required for generic TBA execution; unavoidable in ERC-6551-style account |
| `naming-convention` | AgentAccount | INFO | Underscore prefix on initialize params is deliberate convention |
| `too-many-digits` | AgentAccountRegistry | INFO | BeaconProxy ABI encoding constant; no security implication |

### Slither Report Artifacts
- Initial: `state/slither/slither_report.json`
- Post-fix: `state/slither/slither_report_v2.json`

