# Phase 1 Backend API (Scaffold)

## Auth (SIWE-style)

### GET `/api/v1/auth/siwe/nonce?address=0x...`
- Issue one-time nonce for wallet login.

Response:
```json
{
  "ok": true,
  "data": {
    "address": "0x...",
    "nonce": "ab12cd34...",
    "expires_at": "2026-02-25T12:00:00.000Z"
  }
}
```

### POST `/api/v1/auth/siwe/verify`
- Verify nonce + message binding.
- If `ARENA_SIWE_ENFORCE_SIGNATURE_VERIFY=1`, also verifies signature via `cast wallet verify`.

Request:
```json
{
  "address": "0x...",
  "nonce": "ab12cd34...",
  "message": "SIWE message ...",
  "signature": "0x..."
}
```

### GET `/api/v1/auth/session?token=...`
- Read active session by token.

## Agent Registry

### GET `/api/v1/registry/agents`
- List all registered external agents.

### GET `/api/v1/registry/health`
- Return registry totals (`total/enabled/by_type`).

### GET `/api/v1/registry/agents/:id`
- Read one registered agent.

### POST `/api/v1/registry/agents`
- Upsert one external agent registration.
- Requires:
  - `Authorization: Bearer <session_token>`
  - Optional idempotency header: `X-Idempotency-Key: <key>`
- Security checks:
  - `owner_address` must match authenticated session address.
  - Same idempotency key with different payload returns `409`.
- Endpoint checks:
  - `webhook`: must be `http(s)` URL.
  - `sdk`: module path must exist and end in `.js/.mjs/.cjs`.
  - `stdio`: command string must be non-empty.

Request:
```json
{
  "agent_id": "alpha-webhook",
  "owner_address": "0x...",
  "display_name": "Alpha Webhook",
  "connection_type": "webhook",
  "endpoint": "https://example.com/arena/decide",
  "secret_ref": "env://ARENA_AGENT_SECRET_ALPHA",
  "enabled": true
}
```

### PATCH `/api/v1/registry/agents/:id/enable`
- Owner-authenticated enable/disable toggle.

### DELETE `/api/v1/registry/agents/:id`
- Owner-authenticated removal.

Runtime behavior:
- `arena start` auto-loads enabled `webhook` + `stdio` + `sdk` agents from `state/arena/agent_registry.json`.
- If an id already exists in `config/arena.yaml`, static config wins and registry duplicate is skipped.
- `sdk` endpoint is treated as a local module path that exports `decide(input)`.
- For webhook agents, `secret_ref` supports env references:
  - `env://VAR_NAME`
  - `env:VAR_NAME`

## Replay Audit

### GET `/api/v1/replay/decisions?limit=100`
- Return latest deterministic replay rows from:
- `state/arena/agent_decision_replay.jsonl`
- Supports filters:
  - `agent_id`
  - `season_id`
  - `offset` (tail pagination)

### GET `/api/v1/audit/logs?limit=100`
- Return audit log rows from:
- `state/arena/audit_log.jsonl`
- Supports filters:
  - `category`
  - `action`
  - `status`
  - `actor`
  - `offset`

## Webhook Guardrails

- Arena webhook response parser now enforces:
  - max signals per cycle (default `20`)
  - max reason length (default `280`)
  - strict action/token enum checks
  - non-HOLD signals must include positive `amount_usd`

## Persistence (Scaffold phase)

- SIWE/session local file:
  - `state/arena/siwe_sessions.json`
- Agent registry local file:
  - `state/arena/agent_registry.json`
- Idempotency cache:
  - `state/arena/idempotency_registry.json`
- API audit log:
  - `state/arena/audit_log.jsonl`
- Replay log:
  - `state/arena/agent_decision_replay.jsonl`

## PostgreSQL Baseline

- Schema file:
  - `packages/api-server/db/schema.sql`
- Local Postgres bootstrap:
  - `deploy/postgres/docker-compose.yml`
  - `docker compose -f deploy/postgres/docker-compose.yml up -d`
- Planned tables:
  - `users`, `siwe_nonces`, `sessions`, `agents`, `seasons`, `cycles`, `decision_replay`
- Export command for bootstrap migration:
  - `base-agent arena export-sql --config config/arena.yaml`
  - output default: `state/arena/phase1_export.sql`
- Init schema command:
  - `base-agent arena db-init`
