import { Router, type Request, type Response } from 'express';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { AgentConnectionType } from '../registry/agent-registry-store.js';
import { AgentRegistryStore } from '../registry/agent-registry-store.js';
import { SiweSessionStore } from '../auth/siwe-session-store.js';
import { IdempotencyStore } from '../registry/idempotency-store.js';
import { AuditLog } from '../ops/audit-log.js';

function isHexAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

function isConnectionType(v: string): v is AgentConnectionType {
  return v === 'webhook' || v === 'sdk' || v === 'stdio';
}

function looksLikeHttpUrl(v: string): boolean {
  return /^https?:\/\/.+/i.test(v);
}

function validateEndpoint(connectionType: AgentConnectionType, endpoint: string): string | null {
  if (connectionType === 'webhook') {
    return looksLikeHttpUrl(endpoint) ? null : 'webhook endpoint must be http(s) URL';
  }
  if (connectionType === 'stdio') {
    const firstToken = endpoint.trim().split(/\s+/)[0] ?? '';
    if (!firstToken) return 'stdio endpoint command is empty';
    return null;
  }
  if (connectionType === 'sdk') {
    const full = resolve(endpoint);
    if (!existsSync(full)) return `sdk module path not found: ${full}`;
    if (!/\.(mjs|js|cjs)$/i.test(full)) return 'sdk endpoint must be .js/.mjs/.cjs module path';
    return null;
  }
  return 'unsupported connection type';
}

export function createAgentRegistryRouter(store: AgentRegistryStore): Router {
  return createAgentRegistryRouterWithAuth(
    store,
    new SiweSessionStore('state/arena/siwe_sessions.json'),
    new IdempotencyStore('state/arena/idempotency_registry.json'),
    new AuditLog('state/arena/audit_log.jsonl'),
  );
}

export function createAgentRegistryRouterWithAuth(
  store: AgentRegistryStore,
  sessionStore: SiweSessionStore,
  idempotencyStore: IdempotencyStore,
  auditLog: AuditLog,
): Router {
  const router = Router();

  function requireSession(req: Request, res: Response): { address: string } | null {
    const authHeader = String(req.headers['authorization'] ?? '').trim();
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
    if (!token) {
      res.status(401).json({ ok: false, error: 'Missing bearer session token' });
      return null;
    }
    const session = sessionStore.getSession(token);
    if (!session) {
      res.status(401).json({ ok: false, error: 'Invalid or expired session' });
      return null;
    }
    return { address: session.address };
  }

  // GET /api/v1/registry/agents
  router.get('/agents', (_req, res) => {
    res.json({ ok: true, data: store.list() });
  });

  // GET /api/v1/registry/health
  router.get('/health', (_req, res) => {
    const rows = store.list();
    const byType = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.connection_type] = (acc[row.connection_type] ?? 0) + 1;
      return acc;
    }, {});
    res.json({
      ok: true,
      data: {
        total: rows.length,
        enabled: rows.filter((r) => r.enabled).length,
        by_type: byType,
      },
    });
  });

  // GET /api/v1/registry/agents/:id
  router.get('/agents/:id', (req, res) => {
    const found = store.getById(String(req.params['id'] ?? ''));
    if (!found) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    res.json({ ok: true, data: found });
  });

  // POST /api/v1/registry/agents
  router.post('/agents', (req, res) => {
    const traceId = String(req.headers['x-trace-id'] ?? '').trim() || undefined;
    const session = requireSession(req, res);
    if (!session) {
      auditLog.write({ category: 'registry', action: 'upsert_agent', status: 'error', trace_id: traceId, detail: { error: 'invalid session' } });
      return;
    }

    const agentId = String(req.body?.['agent_id'] ?? '').trim();
    const ownerAddress = String(req.body?.['owner_address'] ?? '').trim();
    const displayName = String(req.body?.['display_name'] ?? '').trim();
    const connectionType = String(req.body?.['connection_type'] ?? '').trim();
    const endpoint = String(req.body?.['endpoint'] ?? '').trim();
    const secretRef = String(req.body?.['secret_ref'] ?? '').trim();
    const enabledRaw = req.body?.['enabled'];
    const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : true;
    const idemKey = String(req.headers['x-idempotency-key'] ?? '').trim();

    if (!agentId || !/^[a-zA-Z0-9-_]{3,64}$/.test(agentId)) {
      res.status(400).json({ ok: false, error: 'Invalid agent_id (3-64 chars: a-zA-Z0-9-_).' });
      return;
    }
    if (!isHexAddress(ownerAddress)) {
      res.status(400).json({ ok: false, error: 'Invalid owner_address' });
      return;
    }
    if (session.address.toLowerCase() !== ownerAddress.toLowerCase()) {
      auditLog.write({
        category: 'registry',
        action: 'upsert_agent',
        actor: session.address,
        trace_id: traceId,
        status: 'error',
        detail: { error: 'owner/session mismatch', owner_address: ownerAddress },
      });
      res.status(403).json({ ok: false, error: 'owner_address must match authenticated session address' });
      return;
    }
    if (!displayName) {
      res.status(400).json({ ok: false, error: 'display_name is required' });
      return;
    }
    if (!isConnectionType(connectionType)) {
      res.status(400).json({ ok: false, error: 'connection_type must be webhook|sdk|stdio' });
      return;
    }
    if (!endpoint) {
      res.status(400).json({ ok: false, error: 'endpoint is required' });
      return;
    }
    const endpointError = validateEndpoint(connectionType, endpoint);
    if (endpointError) {
      res.status(400).json({ ok: false, error: endpointError });
      return;
    }

    const payload = {
      agent_id: agentId,
      owner_address: ownerAddress.toLowerCase(),
      display_name: displayName,
      connection_type: connectionType,
      endpoint,
      secret_ref: secretRef || undefined,
      enabled,
    };
    const reqHash = idempotencyStore.hashPayload(payload);
    if (idemKey) {
      const prev = idempotencyStore.get(idemKey);
      if (prev) {
        if (prev.request_hash !== reqHash) {
          res.status(409).json({ ok: false, error: 'Idempotency key conflict: payload mismatch' });
          return;
        }
        res.json(prev.response);
        return;
      }
    }

    const saved = store.upsert({
      ...payload,
    });
    const response = { ok: true, data: saved };
    if (idemKey) {
      idempotencyStore.save(idemKey, reqHash, response);
    }
    auditLog.write({
      category: 'registry',
      action: 'upsert_agent',
      actor: session.address,
      trace_id: traceId,
      status: 'ok',
      detail: { agent_id: saved.agent_id, connection_type: saved.connection_type, idempotency_key: idemKey || null },
    });
    res.json(response);
  });

  // PATCH /api/v1/registry/agents/:id/enable
  router.patch('/agents/:id/enable', (req, res) => {
    const traceId = String(req.headers['x-trace-id'] ?? '').trim() || undefined;
    const session = requireSession(req, res);
    if (!session) return;
    const agentId = String(req.params['id'] ?? '').trim();
    const enabled = req.body?.['enabled'];
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ ok: false, error: 'enabled must be boolean' });
      return;
    }
    const found = store.getById(agentId);
    if (!found) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    if (found.owner_address.toLowerCase() !== session.address.toLowerCase()) {
      auditLog.write({
        category: 'registry',
        action: 'set_enabled',
        actor: session.address,
        trace_id: traceId,
        status: 'error',
        detail: { error: 'owner/session mismatch', agent_id: agentId },
      });
      res.status(403).json({ ok: false, error: 'Only owner can update this agent' });
      return;
    }
    const updated = store.setEnabled(agentId, enabled);
    auditLog.write({
      category: 'registry',
      action: 'set_enabled',
      actor: session.address,
      trace_id: traceId,
      status: 'ok',
      detail: { agent_id: agentId, enabled },
    });
    res.json({ ok: true, data: updated });
  });

  // DELETE /api/v1/registry/agents/:id
  router.delete('/agents/:id', (req, res) => {
    const traceId = String(req.headers['x-trace-id'] ?? '').trim() || undefined;
    const session = requireSession(req, res);
    if (!session) return;
    const agentId = String(req.params['id'] ?? '').trim();
    const found = store.getById(agentId);
    if (!found) {
      res.status(404).json({ ok: false, error: 'Agent not found' });
      return;
    }
    if (found.owner_address.toLowerCase() !== session.address.toLowerCase()) {
      auditLog.write({
        category: 'registry',
        action: 'delete_agent',
        actor: session.address,
        trace_id: traceId,
        status: 'error',
        detail: { error: 'owner/session mismatch', agent_id: agentId },
      });
      res.status(403).json({ ok: false, error: 'Only owner can delete this agent' });
      return;
    }
    const removed = store.remove(agentId);
    auditLog.write({
      category: 'registry',
      action: 'delete_agent',
      actor: session.address,
      trace_id: traceId,
      status: removed ? 'ok' : 'error',
      detail: { agent_id: agentId },
    });
    res.json({ ok: true, removed });
  });

  return router;
}
