import express from 'express';
import { createServer } from 'http';
import { join } from 'path';
import type { ArenaEngine } from '@synaptex/arena-coordinator';
import { createArenaRouter } from './routes/arena.js';
import { createVaultRouter } from './routes/vault.js';
import { createAuthRouter } from './routes/auth.js';
import { createAgentRegistryRouterWithAuth } from './routes/agent-registry.js';
import { createTasksRouter } from './routes/tasks.js';
import { createWebhookRegistrationRouter, loadPersistedWebhookAgents } from './routes/webhook-registration.js';
import { SiweSessionStore } from './auth/siwe-session-store.js';
import { AgentRegistryStore } from './registry/agent-registry-store.js';
import { IdempotencyStore } from './registry/idempotency-store.js';
import { AuditLog } from './ops/audit-log.js';
import { WsBroadcaster } from './ws/broadcaster.js';

export interface ApiServerConfig {
  port: number;
  host: string;
  stateDir?: string;
  wsAuthToken?: string;
  corsOrigin?: string;
  siweNonceTtlSeconds?: number;
  siweSessionTtlSeconds?: number;
  siweEnforceSignatureVerify?: boolean;
}

export function createApiServer(engine: ArenaEngine, config: ApiServerConfig) {
  const app = express();
  const httpServer = createServer(app);
  const broadcaster = new WsBroadcaster(httpServer, {
    authToken: config.wsAuthToken,
  });
  const stateDir = config.stateDir ?? 'state/arena';
  const corsOriginRaw = config.corsOrigin ?? '*';
  // Support comma-separated list of allowed origins; pick only the matching one per request
  const allowedOrigins = corsOriginRaw === '*' ? null : corsOriginRaw.split(',').map(o => o.trim());

  // Load any previously registered webhook agents into the engine
  loadPersistedWebhookAgents(engine, stateDir);
  const siweStore = new SiweSessionStore(join(stateDir, 'siwe_sessions.json'));
  const registryStore = new AgentRegistryStore(join(stateDir, 'agent_registry.json'));
  const idempotencyStore = new IdempotencyStore(join(stateDir, 'idempotency_registry.json'));
  const auditLog = new AuditLog(join(stateDir, 'audit_log.jsonl'));

  app.use(express.json());
  app.use((req, res, next) => {
    const requestOrigin = req.get('Origin') ?? '';
    let allowOrigin: string;
    if (!allowedOrigins) {
      allowOrigin = '*';
    } else if (allowedOrigins.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
    } else {
      allowOrigin = allowedOrigins[0] ?? '*';
    }
    res.header('Access-Control-Allow-Origin', allowOrigin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key, X-Trace-Id');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      season: engine.getSeason()?.status ?? 'none',
      ws_clients: broadcaster.clientCount,
      timestamp: new Date().toISOString(),
    });
  });

  // Arena API v1
  app.use('/api/v1', createArenaRouter(engine, stateDir));
  app.use('/api/v1/vault', createVaultRouter());
  app.use('/api/v1/tasks', createTasksRouter(stateDir, broadcaster));
  app.use('/api/v1/auth', createAuthRouter(siweStore, {
    nonceTtlSeconds: config.siweNonceTtlSeconds ?? 300,
    sessionTtlSeconds: config.siweSessionTtlSeconds ?? 86400,
    enforceSignatureVerify: config.siweEnforceSignatureVerify ?? false,
    castBin: process.env['ARENA_CAST_BIN'] ?? 'cast',
    verifyCommand: process.env['SYNAPTEX_SIWE_VERIFY_COMMAND'],
  }, auditLog));
  app.use('/api/v1/webhook-agents', createWebhookRegistrationRouter(engine, stateDir));
  app.use('/api/v1/registry', createAgentRegistryRouterWithAuth(
    registryStore,
    siweStore,
    idempotencyStore,
    auditLog,
  ));

  // Wire up engine hooks to broadcast WebSocket events
  engine.addHook({
    async onCycleComplete(event) {
      broadcaster.broadcast('cycle_complete', event);
      broadcaster.broadcast('leaderboard', engine.getLeaderboard());
    },
    async onSeasonStart(season) {
      broadcaster.broadcast('season_start', season);
    },
    async onSeasonEnd(season, leaderboard) {
      broadcaster.broadcast('season_end', { season, leaderboard });
    },
  });

  function start(): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(config.port, config.host, () => {
        console.log(`[API] Server listening on http://${config.host}:${config.port}`);
        console.log(`[API] WebSocket at ws://${config.host}:${config.port}/ws`);
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { start, stop, broadcaster };
}
