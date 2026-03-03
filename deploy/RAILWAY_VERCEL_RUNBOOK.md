# Railway + Vercel Deployment Runbook

## 1. Backend on Railway

Service root:
- repo root (`bnb-trading-agent`)

Railway files already prepared:
- `railway.json`
- `nixpacks.toml`

Start command:
- `node cli/dist/index.js arena start --config config/arena.yaml --agent-config config/agent.yaml`

Required Railway environment variables:
- `PORT` (Railway provides automatically)
- `ARENA_API_HOST=0.0.0.0`
- `ARENA_CORS_ORIGIN=https://<your-vercel-domain>`
- `ARENA_WS_AUTH_TOKEN=<strong-random-token>`
- `ARENA_DATABASE_URL=<Railway Postgres URL>`
- `ARENA_SIWE_NONCE_TTL_SECONDS=300`
- `ARENA_SIWE_SESSION_TTL_SECONDS=86400`
- `ARENA_SIWE_ENFORCE_SIGNATURE_VERIFY=0` (set `1` only if `cast` exists in runtime)

Recommended (if using on-chain flows):
- `ARENA_CHAIN_RPC_URL=<base-rpc>`
- `ARENA_SETTLEMENT_MODE=onchain`
- `ARENA_SETTLER_CONTRACT=0x...`
- `LEARNING_ROOT_ORACLE=0x...`
- signer envs (prefer keystore mode)

Health check:
- `GET /health`

Core APIs:
- `GET /api/v1/leaderboard`
- `GET /api/v1/replay/decisions`
- `POST /api/v1/auth/siwe/verify`
- `POST /api/v1/registry/agents`

## 2. Database on Railway

Option A (recommended): add Railway PostgreSQL plugin and copy `DATABASE_URL` to:
- `ARENA_DATABASE_URL`

Option B (manual init):
1. run `base-agent arena db-init` (or execute `packages/api-server/db/schema.sql`)
2. run `base-agent arena export-sql`
3. import `state/arena/phase1_export.sql` into Postgres

## 3. Frontend on Vercel

Frontend template is included at:
- `web/`

Vercel project settings:
- Root Directory: `web`
- Framework Preset: Next.js

Vercel environment variables:
- `NEXT_PUBLIC_ARENA_API_URL=https://<your-railway-domain>`
- `NEXT_PUBLIC_ARENA_WS_URL=wss://<your-railway-domain>/ws?token=<ARENA_WS_AUTH_TOKEN>`

## 4. Cross-Origin and Auth Checklist

1. Railway `ARENA_CORS_ORIGIN` must match exact Vercel origin.
2. Frontend uses SIWE flow:
   - get nonce
   - sign message
   - verify to get `session_token`
3. `POST /api/v1/registry/agents` must include:
   - `Authorization: Bearer <session_token>`
   - optional `X-Idempotency-Key`

