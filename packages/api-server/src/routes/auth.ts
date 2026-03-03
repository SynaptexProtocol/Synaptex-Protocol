import { Router } from 'express';
import { spawnSync } from 'child_process';
import { SiweSessionStore } from '../auth/siwe-session-store.js';
import { AuditLog } from '../ops/audit-log.js';

interface AuthRouterOptions {
  nonceTtlSeconds: number;
  sessionTtlSeconds: number;
  enforceSignatureVerify: boolean;
  castBin?: string;
  verifyCommand?: string;
}

function isHexAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

export function createAuthRouter(
  store: SiweSessionStore,
  options: AuthRouterOptions,
  auditLog?: AuditLog,
): Router {
  const router = Router();

  // GET /api/v1/auth/siwe/nonce?address=0x...
  router.get('/siwe/nonce', (req, res) => {
    const address = String(req.query['address'] ?? '').trim();
    const traceId = String(req.headers['x-trace-id'] ?? '').trim() || undefined;
    if (!isHexAddress(address)) {
      auditLog?.write({ category: 'auth', action: 'nonce', trace_id: traceId, status: 'error', detail: { error: 'invalid address' } });
      res.status(400).json({ ok: false, error: 'Invalid address' });
      return;
    }
    const nonce = store.issueNonce(address, options.nonceTtlSeconds);
    auditLog?.write({ category: 'auth', action: 'nonce', actor: nonce.address, trace_id: traceId, status: 'ok' });
    res.json({
      ok: true,
      data: {
        address: nonce.address,
        nonce: nonce.nonce,
        expires_at: nonce.expiresAt,
      },
    });
  });

  // POST /api/v1/auth/siwe/verify
  router.post('/siwe/verify', (req, res) => {
    const traceId = String(req.headers['x-trace-id'] ?? '').trim() || undefined;
    const address = String(req.body?.['address'] ?? '').trim();
    const nonce = String(req.body?.['nonce'] ?? '').trim();
    const message = String(req.body?.['message'] ?? '').trim();
    const signature = String(req.body?.['signature'] ?? '').trim();

    if (!isHexAddress(address) || !nonce || !message || !signature) {
      auditLog?.write({ category: 'auth', action: 'verify', trace_id: traceId, status: 'error', detail: { error: 'invalid fields' } });
      res.status(400).json({ ok: false, error: 'Missing or invalid fields' });
      return;
    }

    const consumed = store.consumeNonce(address, nonce);
    if (!consumed) {
      auditLog?.write({ category: 'auth', action: 'verify', actor: address.toLowerCase(), trace_id: traceId, status: 'error', detail: { error: 'bad nonce' } });
      res.status(401).json({ ok: false, error: 'Nonce invalid, expired, or already used' });
      return;
    }

    const includesAddress = message.toLowerCase().includes(address.toLowerCase());
    const includesNonce = message.includes(nonce);
    let signatureVerified = false;

    if (options.enforceSignatureVerify) {
      signatureVerified = includesAddress
        && includesNonce
        && verifySignatureStrict(options, message, signature, address);
      if (!signatureVerified) {
        auditLog?.write({ category: 'auth', action: 'verify', actor: address.toLowerCase(), trace_id: traceId, status: 'error', detail: { error: 'signature verification failed' } });
        res.status(401).json({ ok: false, error: 'SIWE verification failed' });
        return;
      }
    } else {
      signatureVerified = includesAddress && includesNonce;
    }

    const session = store.issueSession(address, options.sessionTtlSeconds, signatureVerified);
    auditLog?.write({
      category: 'auth',
      action: 'verify',
      actor: session.address,
      trace_id: traceId,
      status: 'ok',
      detail: { signature_verified: signatureVerified, mode: options.enforceSignatureVerify ? 'strict' : 'scaffold' },
    });
    res.json({
      ok: true,
      data: {
        session_token: session.token,
        address: session.address,
        expires_at: session.expiresAt,
        signature_verified: session.signatureVerified,
        mode: options.enforceSignatureVerify ? 'strict' : 'scaffold',
      },
    });
  });

  // GET /api/v1/auth/session?token=...
  router.get('/session', (req, res) => {
    const traceId = String(req.headers['x-trace-id'] ?? '').trim() || undefined;
    const token = String(req.query['token'] ?? '').trim();
    if (!token) {
      auditLog?.write({ category: 'auth', action: 'session', trace_id: traceId, status: 'error', detail: { error: 'missing token' } });
      res.status(400).json({ ok: false, error: 'Missing token' });
      return;
    }
    const session = store.getSession(token);
    if (!session) {
      auditLog?.write({ category: 'auth', action: 'session', trace_id: traceId, status: 'error', detail: { error: 'session not found' } });
      res.status(404).json({ ok: false, error: 'Session not found or expired' });
      return;
    }
    auditLog?.write({ category: 'auth', action: 'session', actor: session.address, trace_id: traceId, status: 'ok' });
    res.json({ ok: true, data: session });
  });

  return router;
}

function verifySignatureWithCast(
  castBin: string,
  message: string,
  signature: string,
  address: string,
): boolean {
  const result = spawnSync(castBin, ['wallet', 'verify', '--address', address, message, signature], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function verifySignatureStrict(
  options: AuthRouterOptions,
  message: string,
  signature: string,
  address: string,
): boolean {
  const cmdTemplate = options.verifyCommand?.trim() || process.env['SYNAPTEX_SIWE_VERIFY_COMMAND']?.trim() || '';
  if (cmdTemplate) {
    return verifySignatureWithCommand(cmdTemplate, message, signature, address);
  }
  return verifySignatureWithCast(
    options.castBin ?? process.env['ARENA_CAST_BIN'] ?? 'cast',
    message,
    signature,
    address,
  );
}

function verifySignatureWithCommand(
  template: string,
  message: string,
  signature: string,
  address: string,
): boolean {
  // Template placeholders:
  // {address} {signature} {message_b64}
  const messageB64 = Buffer.from(message, 'utf-8').toString('base64');
  const cmd = template
    .replaceAll('{address}', address)
    .replaceAll('{signature}', signature)
    .replaceAll('{message_b64}', messageB64);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: 'ignore',
  });
  return result.status === 0;
}
