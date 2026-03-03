# Arena Operations SOP

Date: 2026-02-24

## 1. Preflight Before Any Start

Run:

```powershell
node cli/dist/index.js arena preflight --config config/arena.yaml
```

Rules:
- Any `ERROR` must be fixed before `arena start`.
- `WARN` can run, but should be tracked in the daily report.
- If cast lookup is unstable on Windows, set `ARENA_CAST_BIN` to full `cast.exe` path.
- For local Anvil testing, you can use unlocked signer mode:
  - `ARENA_CAST_USE_UNLOCKED=1`
  - `ARENA_CAST_FROM=<anvil_account>`
- Raw private-key signer is blocked by default:
  - set `ARENA_ALLOW_INSECURE_PRIVATE_KEY=1` only for explicit non-production override.

## 2. Standard Bring-Up

1. Start Python IPC engine.
2. Run `arena bootstrap-onchain` (if registration enabled).
3. Run `arena start`.
4. Generate first report:

```powershell
node cli/dist/index.js arena ops-report --config config/arena.yaml
```

## 3. Daily Checklist

Run these checks:

```powershell
curl http://127.0.0.1:3000/health
node cli/dist/index.js arena status --config config/arena.yaml
node cli/dist/index.js arena leaderboard --config config/arena.yaml
node cli/dist/index.js arena ops-report --config config/arena.yaml
```

Inspect:
- `state/arena/ops_report.md`
- `state/arena/settlement_receipts.jsonl`
- `state/arena/learning_root_receipts.jsonl`
- `state/arena/alert_failures.jsonl`

## 4. Alert Operations

Recommended routing:
- `ARENA_ALERT_WEBHOOK_URL_WARN`: ops channel
- `ARENA_ALERT_WEBHOOK_URL_ERROR`: pager channel

Protection knobs:
- `ARENA_ALERT_DEDUP_WINDOW_MS` (default 60s)
- `ARENA_ALERT_RATE_LIMIT_WINDOW_MS` (default 60s)
- `ARENA_ALERT_RATE_LIMIT_MAX` (default 20)

If alert delivery fails, check:
- `state/arena/alert_failures.jsonl`

## 5. Learning Root Replay SOP

If runtime lag or temporary chain outage happened:

```powershell
node cli/dist/index.js arena sync-learning --config config/arena.yaml --limit 500
```

Notes:
- Command is idempotent.
- Cursor resume is enabled by default.
- Use `--reset-cursor` only for full replay.

## 6. Incident Handling

1. Pause contracts (`LearningRootOracle`, `ArenaVault`, `SeasonSettler`) if on-chain safety is at risk.
2. Keep Arena process up for observability unless process itself is unstable.
3. Collect evidence:
- latest `ops_report.md`
- latest DLQ files
- receipts and cursor files
4. Mitigate root cause.
5. Unpause contracts.
6. Run replay sync and confirm receipts increase.

## 7. Exit Criteria After Recovery

Recovery is complete only when all are true:
- `arena preflight` has no errors.
- `ops-report` shows stable cursor progression.
- no sustained growth in `alert_failures` DLQ.
- settlement and learning receipts continue to append.

## 8. Gate Run Evidence (2026-02-25)

Full lifecycle gate was run on local anvil (Base mainnet fork also confirmed reachable).
Evidence archived at `state/gate_run/`:
- `gate_summary.json` — step-by-step pass/fail record
- `cycle_commitments.jsonl` — 3 cycle rows
- `ops_report.md` — populated season report
- `sync_learning_cursor.json` — cursor=4
- `agent_registration.jsonl` — NFA+TBA registration log
- `anvil_gate.log`, `python.log` — process logs

Release baseline: `state/release_baseline/20260225T082455Z/`

## Section 9: Contract Upgrade Hygiene

- Always run storage layout snapshot before upgrade proposals:
  - `powershell -ExecutionPolicy Bypass -File contracts/script/check-storage-layout.ps1`
- Keep snapshot outputs under `contracts/storage-layout/` and attach them to the change ticket.
- Reject upgrade if layout is not append-only for UUPS/Beacon implementations.

## Section 10: Token Supply Controls

- `ArenaToken` now supports a configurable `cap`.
- Operational policy:
  - production deploy SHOULD use non-zero cap.
  - any cap change requires redeploy/governance decision (immutable cap).
