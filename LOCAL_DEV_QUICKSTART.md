# Local Dev Quickstart (No Cloud Required)

## 1) Build

```bash
pnpm -r build
```

## 2) Start Arena

```bash
node cli/dist/index.js arena start --config config/arena.yaml --agent-config config/agent.yaml
```

API default:
- `http://127.0.0.1:3000`

## 3) SIWE Session (scaffold mode)

1. Get nonce:
```bash
curl "http://127.0.0.1:3000/api/v1/auth/siwe/nonce?address=0x1111111111111111111111111111111111111111"
```

2. Verify (scaffold mode accepts message-binding checks):
```bash
curl -X POST "http://127.0.0.1:3000/api/v1/auth/siwe/verify" ^
  -H "Content-Type: application/json" ^
  -d "{\"address\":\"0x1111111111111111111111111111111111111111\",\"nonce\":\"<nonce>\",\"message\":\"I am 0x1111111111111111111111111111111111111111 and nonce <nonce>\",\"signature\":\"0xdeadbeef\"}"
```

Save `session_token` from response.

## 4) Register external webhook agent

Start mock webhook service:
```bash
python scripts/mock_webhook_agent.py
```

```bash
curl -X POST "http://127.0.0.1:3000/api/v1/registry/agents" ^
  -H "Authorization: Bearer <session_token>" ^
  -H "X-Idempotency-Key: demo-agent-1" ^
  -H "Content-Type: application/json" ^
  -d "{\"agent_id\":\"demo-webhook\",\"owner_address\":\"0x1111111111111111111111111111111111111111\",\"display_name\":\"Demo Webhook\",\"connection_type\":\"webhook\",\"endpoint\":\"http://127.0.0.1:9001/decide\",\"secret_ref\":\"env://ARENA_AGENT_SECRET_DEMO_WEBHOOK\",\"enabled\":true}"
```

## 5) Register external stdio agent

Start mock stdio script is not required; Arena executes it per cycle.

```bash
curl -X POST "http://127.0.0.1:3000/api/v1/registry/agents" ^
  -H "Authorization: Bearer <session_token>" ^
  -H "X-Idempotency-Key: demo-agent-2" ^
  -H "Content-Type: application/json" ^
  -d "{\"agent_id\":\"demo-stdio\",\"owner_address\":\"0x1111111111111111111111111111111111111111\",\"display_name\":\"Demo StdIO\",\"connection_type\":\"stdio\",\"endpoint\":\"python scripts/mock_stdio_agent.py\",\"enabled\":true}"
```

## 5.1) Register external sdk agent

```bash
curl -X POST "http://127.0.0.1:3000/api/v1/registry/agents" ^
  -H "Authorization: Bearer <session_token>" ^
  -H "X-Idempotency-Key: demo-agent-3" ^
  -H "Content-Type: application/json" ^
  -d "{\"agent_id\":\"demo-sdk\",\"owner_address\":\"0x1111111111111111111111111111111111111111\",\"display_name\":\"Demo SDK\",\"connection_type\":\"sdk\",\"endpoint\":\"scripts/mock_sdk_agent.mjs\",\"enabled\":true}"
```

## 6) Manage registered agents

Disable:
```bash
curl -X PATCH "http://127.0.0.1:3000/api/v1/registry/agents/demo-stdio/enable" ^
  -H "Authorization: Bearer <session_token>" ^
  -H "Content-Type: application/json" ^
  -d "{\"enabled\":false}"
```

Delete:
```bash
curl -X DELETE "http://127.0.0.1:3000/api/v1/registry/agents/demo-stdio" ^
  -H "Authorization: Bearer <session_token>"
```

Registry health:
```bash
curl "http://127.0.0.1:3000/api/v1/registry/health"
```

## 7) One-command smoke test

When Arena API is running, you can run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local_api_smoke.ps1
```

Optional custom API base:

```powershell
$env:ARENA_API_BASE="http://127.0.0.1:3000"
powershell -ExecutionPolicy Bypass -File scripts/local_api_smoke.ps1
```

## 8) One-command local E2E

This starts mock webhook + arena, waits for health, runs API smoke, then cleans up processes.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local_e2e_smoke.ps1
```
