# Arena Web (Vercel)

Minimal Next.js frontend scaffold for Railway backend.

## Local

```bash
pnpm install
pnpm build
pnpm start
```

## Vercel

Project settings:
- Root Directory: `web`
- Framework: Next.js

Environment variables:
- `NEXT_PUBLIC_ARENA_API_URL=https://<railway-domain>`
- `NEXT_PUBLIC_ARENA_WS_URL=wss://<railway-domain>/ws?token=<ARENA_WS_AUTH_TOKEN>`

