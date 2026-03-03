# Mainnet Runbook (Single-Signer)

Date: 2026-02-24  
Scope: Base mainnet deployment and operational checklist for Arena protocol stack.

## 1. Preconditions

- Foundry installed (`forge`, `cast`, `anvil`).
- Contracts compile and tests pass:
  - `cd contracts && forge build`
  - `cd contracts && forge test`
- Runtime build passes:
  - `pnpm -r build`
- Signing key is funded on target chain.
- You understand this runbook assumes **single-signer** operation.

## 2. Environment Variables

Set these before any deployment action:

```powershell
$env:RPC_URL="https://mainnet.base.org"
$env:PRIVATE_KEY="0x..."      # deployer key
$env:OWNER="0xYourOwner"      # protocol owner address (single signer)
$env:LOCK_CONFIG="true"       # lock critical config after deploy
```

Runtime (`.env`) variables after deployment:

```dotenv
ARENA_SETTLEMENT_MODE=onchain
ARENA_CHAIN_RPC_URL=https://mainnet.base.org
ARENA_SETTLER_PRIVATE_KEY=0x...
ARENA_CAST_BIN=
ARENA_SIGNER_KEYSTORE=
ARENA_SIGNER_PASSWORD=
ARENA_SIGNER_PRIVATE_KEY=
ARENA_ALLOW_INSECURE_PRIVATE_KEY=0
ARENA_CAST_USE_UNLOCKED=0
ARENA_CAST_FROM=
ARENA_SETTLEMENT_RECEIPTS_PATH=state/arena/settlement_receipts.jsonl
ARENA_LEARNING_RECEIPTS_PATH=state/arena/learning_root_receipts.jsonl
ARENA_SYNC_LEARNING_CURSOR_PATH=state/arena/sync_learning_cursor.json

ARENA_SETTLER_CONTRACT=0x...
LEARNING_ROOT_ORACLE=0x...
AGENT_NFA_CONTRACT=0x...
AGENT_ACCOUNT_REGISTRY=0x...

ARENA_ENABLE_AGENT_ONCHAIN_REGISTRATION=1
ARENA_AGENT_NFA_MINT_TO=0x...
ARENA_AGENT_TOKEN_URI_PREFIX=ipfs://arena-agent
ARENA_AGENT_TBA_SALT=0
```

## 3. Deploy Contracts

### 3.1 Build + dry check

```powershell
cd contracts
forge build
```

### 3.2 Deploy all contracts

```powershell
cd contracts
forge script script/Deploy.s.sol:Deploy `
  --rpc-url $env:RPC_URL `
  --private-key $env:PRIVATE_KEY `
  --broadcast
```

The script deploys:
- `ArenaToken`
- `ArenaVault`
- `SeasonSettler`
- `AgentNFA`
- `AgentAccountRegistry`
- `LearningRootOracle`

It also wires:
- `ArenaVault.setSettler(SeasonSettler)`

If `LOCK_CONFIG=true`, it additionally locks:
- `ArenaVault.lockSettler()`
- `SeasonSettler.lockVault()`

## 4. Capture Deployment Addresses

Read latest broadcast artifact:

```powershell
Get-Content contracts/broadcast/Deploy.s.sol/*/run-latest.json -Raw
```

Copy addresses into:
- `.env`
- secure deployment record (internal doc / secrets manager)

## 5. Post-Deploy Verification

Replace placeholders before running:

```powershell
cast call <VAULT> "settler()(address)" --rpc-url $env:RPC_URL
cast call <SETTLER> "vault()(address)" --rpc-url $env:RPC_URL
cast call <VAULT> "settlerLocked()(bool)" --rpc-url $env:RPC_URL
cast call <SETTLER> "vaultLocked()(bool)" --rpc-url $env:RPC_URL
cast call <LEARNING_ORACLE> "paused()(bool)" --rpc-url $env:RPC_URL
```

Expected:
- vault/settler cross references are correct.
- lock flags match your intended mode.
- pause flags are `false`.

## 6. Runtime Bring-Up

### 6.0 Preflight

```powershell
node cli/dist/index.js arena preflight --config config/arena.yaml
```

Do not continue if preflight prints any `ERROR`.

### 6.1 Bootstrap agent identities on-chain

```powershell
node cli/dist/index.js arena bootstrap-onchain --config config/arena.yaml
```

### 6.2 Start Arena

```powershell
node cli/dist/index.js arena start --config config/arena.yaml --agent-config config/agent.yaml
```

### 6.3 Replay any backlog learning roots (if needed)

```powershell
node cli/dist/index.js arena sync-learning --config config/arena.yaml --limit 500
```

Run repeatedly as needed; idempotent skip + resume cursor are enabled.

### 6.4 Generate runtime report

```powershell
node cli/dist/index.js arena ops-report --config config/arena.yaml
```

Check report output at `state/arena/ops_report.md`.

## 7. Operational Checklist (Daily)

- Check API health:
  - `curl http://127.0.0.1:3000/health`
- Check current season status:
  - `node cli/dist/index.js arena status --config config/arena.yaml`
- Check leaderboard:
  - `node cli/dist/index.js arena leaderboard --config config/arena.yaml`
- Check receipts:
  - `state/arena/settlement_receipts.jsonl`
  - `state/arena/learning_root_receipts.jsonl`
- Check sync cursor:
  - `state/arena/sync_learning_cursor.json`
- Generate ops report:
  - `node cli/dist/index.js arena ops-report --config config/arena.yaml`
- Check alert DLQ:
  - `state/arena/alert_failures.jsonl`

## 8. Incident Response (Single-Signer)

### 8.1 Emergency pause

Pause learning oracle:

```powershell
cast send <LEARNING_ROOT_ORACLE> "pause()" `
  --rpc-url $env:RPC_URL --private-key $env:PRIVATE_KEY
```

Pause vault:

```powershell
cast send <VAULT> "pause()" `
  --rpc-url $env:RPC_URL --private-key $env:PRIVATE_KEY
```

Pause settler:

```powershell
cast send <SETTLER> "pause()" `
  --rpc-url $env:RPC_URL --private-key $env:PRIVATE_KEY
```

### 8.2 Resume after mitigation

```powershell
cast send <LEARNING_ROOT_ORACLE> "unpause()" --rpc-url $env:RPC_URL --private-key $env:PRIVATE_KEY
cast send <VAULT> "unpause()" --rpc-url $env:RPC_URL --private-key $env:PRIVATE_KEY
cast send <SETTLER> "unpause()" --rpc-url $env:RPC_URL --private-key $env:PRIVATE_KEY
```

## 9. Key Management (Single-Signer Minimum)

### Signer mode comparison (Foundry 1.6.0-rc1)

| Mode | How to configure | argv exposure | Production safe |
|------|-----------------|--------------|----------------|
| Keystore file | `ARENA_SIGNER_KEYSTORE=path/to/keystore` + optional `ARENA_SIGNER_PASSWORD` | None — only file path in argv | **Yes** |
| Raw private key | `ARENA_SIGNER_PRIVATE_KEY=0x...` | Yes — `--private-key` appears in `cast` argv | Dev/CI only |
| Unlocked node | `ARENA_CAST_USE_UNLOCKED=1` + `ARENA_CAST_FROM=0x...` | None | Local dev node only |

> **Foundry 1.6.0-rc1 note:** `ETH_PRIVATE_KEY` environment variable is NOT supported by `cast send` in this version. There is no silent env-based injection path. Production deployments must use keystore.
> Runtime policy: raw private-key mode is blocked by default. Use `ARENA_ALLOW_INSECURE_PRIVATE_KEY=1` only for explicit non-production override.

- Keep signer key outside shell history where possible.
- Prefer keystore signer: `ARENA_SIGNER_KEYSTORE` + `ARENA_SIGNER_PASSWORD`
- `arena preflight` warns when raw private key env is detected.
- Keep a funded emergency owner key path documented and tested.


## 10. Release Gate (Go / No-Go)

Go only if all are true:
- Contracts deployed and verified.
- Runtime `.env` updated with final addresses.
- `bootstrap-onchain` succeeds for all enabled agents.
- Arena runs at least one complete cycle.
- Learning root submit and season settlement submit both produce receipts.
- Pause/unpause tested on mainnet fork or staging before production traffic.

### Gate Status v2 (2026-02-25 — ANVIL GATE PASSED, security batch 5 included)

| Check | Status |
|-------|--------|
| forge test 57 passed, 0 failed | ✓ |
| 7 contracts deployed (token/vault/settler/nfa/beacon/registry/oracle) | ✓ |
| Post-deploy preflight 8/8 cast call checks | ✓ PASS |
| preflight paper mode (3 WARNs expected) | ✓ PASS |
| preflight raw key blocked in onchain mode | ✓ ERROR raised as expected |
| pause/unpause drill (3 contracts) | ✓ all confirmed |
| two-step ownership drill (ArenaVault) | ✓ PASS |
| AgentNFA mint + non-settler reputation blocked | ✓ PASS |
| storage layout check (4 UUPS/Beacon contracts) | ✓ no reorder |
| CLI ops-report DLQ=0 | ✓ PASS |
| Security: AgentAccount owner-scoped auth | ✓ |
| Security: ArenaVault MAX_AGENTS_PER_SEASON=256 | ✓ |
| Security: AgentNFA safeTransferFrom + IERC721Receiver | ✓ |
| Security: ArenaToken cap>0 enforced | ✓ |
| Security: Two-step Ownable pendingOwner+acceptOwnership | ✓ |
| Security: AgentAccount rescue guardian-gated | ✓ |
| sepolia_drill.sh portability fix applied | ✓ |
| Evidence JSON archived | ✓ state/anvil_drill/gate_run_20260225T143200Z.json |

**Gate result: GO for mainnet deployment (external security audit required before live funds).**

### Gate Status (2026-02-25 — LOCAL ANVIL GATE PASSED)

| Check | Status |
|-------|--------|
| Mainnet fork reachable | ✓ (chain_id 8453 confirmed) |
| 6 contracts deployed | ✓ |
| preflight (keystore mode) | ✓ PASS |
| preflight (raw key) | ✓ ERROR (blocked as expected) |
| bootstrap-onchain ×2 | ✓ idempotent |
| arena cycle | ✓ 3 rows in cycle_commitments.jsonl |
| sync-learning | ✓ cursor 3→4 |
| ops-report | ✓ populated |
| pause/unpause (3 contracts) | ✓ all confirmed |
| Release baseline locked | ✓ `state/release_baseline/20260225T082455Z/` |

**Gate result: GO for mainnet deployment (after external security audit).**

## Section 11: Upgrade Storage Gate

Before every UUPS/Beacon upgrade release, run:

```powershell
cd contracts
powershell -ExecutionPolicy Bypass -File script/check-storage-layout.ps1
```

Expected artifacts:
- `contracts/storage-layout/AgentNFA.json`
- `contracts/storage-layout/SeasonSettler.json`
- `contracts/storage-layout/LearningRootOracle.json`
- `contracts/storage-layout/AgentAccount.json`

GO/NO-GO:
- GO: Only intentional append-only storage changes are present.
- NO-GO: Any reordered/removed state slots or incompatible layout deltas.
