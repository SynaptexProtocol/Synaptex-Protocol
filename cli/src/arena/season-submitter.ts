import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { createHmac, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import type { SeasonSettlementPayload } from '@synaptex/arena-coordinator';
import { tmpdir } from 'os';
import { resolveCastSigner } from './cast-signer.js';

export interface ISeasonSubmitter {
  submit(payload: SeasonSettlementPayload): Promise<void>;
}

class LoggingSeasonSubmitter implements ISeasonSubmitter {
  async submit(payload: SeasonSettlementPayload): Promise<void> {
    console.log('[Arena] settlement payload ready (no on-chain submit configured)', {
      season_id: payload.season_id,
      leaderboard_hash: payload.leaderboard_hash,
      merkle_root: payload.merkle_root,
      agents: Object.keys(payload.weights).length,
    });
  }
}

interface HttpSubmitterOptions {
  authToken?: string;
  hmacSecret?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  deadLetterPath?: string;
}

class HttpSeasonSubmitter implements ISeasonSubmitter {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(private readonly endpoint: string, private readonly opts: HttpSubmitterOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 750;
  }

  async submit(payload: SeasonSettlementPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Arena-Settlement-Version': '1.0',
    };

    if (this.opts.authToken) headers['Authorization'] = `Bearer ${this.opts.authToken}`;
    if (this.opts.hmacSecret) {
      headers['X-Arena-Settlement-Signature'] = createHmac('sha256', this.opts.hmacSecret)
        .update(body)
        .digest('hex');
    }

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        clearTimeout(timer);
        return;
      } catch (err) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.backoffMs * attempt));
        }
      }
    }

    if (this.opts.deadLetterPath) {
      this.persistDeadLetter(payload, lastError);
    }
    throw new Error(`Settlement submit failed after ${this.maxAttempts} attempts: ${lastError}`);
  }

  private persistDeadLetter(payload: SeasonSettlementPayload, error: string): void {
    const entry = {
      timestamp: new Date().toISOString(),
      endpoint: this.endpoint,
      error,
      payload,
    };
    mkdirSync(dirname(this.opts.deadLetterPath!), { recursive: true });
    appendFileSync(this.opts.deadLetterPath!, `${JSON.stringify(entry)}\n`, 'utf-8');
  }
}

interface ChainSubmitterOptions {
  rpcUrl: string;
  /** Raw hex private key – stored in memory only, never placed in process argv */
  privateKey?: string;
  contractAddress: string;
  receiptsPath?: string;
}

class CastChainSeasonSubmitter implements ISeasonSubmitter {
  private readonly castBin: string;
  private readonly signer = resolveCastSigner();

  constructor(private readonly opts: ChainSubmitterOptions) {
    this.castBin = process.env['ARENA_CAST_BIN']?.trim() || 'cast';
  }

  async submit(payload: SeasonSettlementPayload): Promise<void> {
    const entries = Object.entries(payload.weights);
    const agentIds = entries.map(([id]) => id);
    const weightsWad = toWeightsWad(entries).map((v) => v.toString());

    // Build reputation deltas (WAD bigint strings); 0 if not present
    const reputationWad = agentIds.map((id) => {
      const delta = payload.reputation_deltas?.[id] ?? 0;
      return BigInt(Math.max(0, Math.floor(delta))).toString();
    });

    const seasonId = payload.season_id;
    const leaderboardHash = asBytes32(payload.leaderboard_hash, 'leaderboard_hash');
    const merkleRoot = asBytes32(payload.merkle_root, 'merkle_root');
    const agentIdsArg = `[${agentIds.map((id) => JSON.stringify(id)).join(',')}]`;
    const weightsArg = `[${weightsWad.join(',')}]`;
    const reputationArg = `[${reputationWad.join(',')}]`;
    const fnSig = 'submitSeasonResult(string,bytes32,bytes32,string[],uint256[],uint256[])';

    // Signer credentials are resolved by cast-signer (keystore / --private-key / unlocked).
    // Production deployments should use SYNAPTEX_SIGNER_KEYSTORE to avoid raw key in argv.
    const args = [
      'send',
      this.opts.contractAddress,
      fnSig,
      seasonId,
      leaderboardHash,
      merkleRoot,
      agentIdsArg,
      weightsArg,
      reputationArg,
      '--rpc-url',
      this.opts.rpcUrl,
      '--json',
      ...this.signer.extraArgs,
    ];

    const output = await runProcess(this.castBin, args, this.signer.env);
    const receipt = safeJsonParse(output.stdout) ?? { raw: output.stdout };

    if (this.opts.receiptsPath) {
      persistJsonLine(this.opts.receiptsPath, {
        timestamp: new Date().toISOString(),
        mode: 'onchain_cast',
        contract: this.opts.contractAddress,
        season_id: seasonId,
        receipt,
      });
    }

    console.log('[Arena] on-chain season settlement submitted', {
      season_id: seasonId,
      contract: this.opts.contractAddress,
    });
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
}

export function createSeasonSubmitter(
  endpoint?: string,
  authToken?: string,
): ISeasonSubmitter {
  const mode = (process.env['SYNAPTEX_SETTLEMENT_MODE'] ?? '').trim().toLowerCase();
  if (mode === 'onchain') {
    const rpcUrl = process.env['SYNAPTEX_CHAIN_RPC_URL']?.trim()
      || process.env['BASE_RPC_URL']?.trim();
    const contractAddress = process.env['SYNAPTEX_SETTLER_CONTRACT']?.trim();
    if (!rpcUrl || !contractAddress) {
      throw new Error(
        'SYNAPTEX_SETTLEMENT_MODE=onchain requires SYNAPTEX_CHAIN_RPC_URL (or BASE_RPC_URL), '
        + 'SYNAPTEX_SETTLER_CONTRACT, and signer config (keystore/private-key/unlocked mode)',
      );
    }
    return new CastChainSeasonSubmitter({
      rpcUrl,
      privateKey: process.env['ARENA_SETTLER_PRIVATE_KEY']?.trim(),
      contractAddress,
      receiptsPath: process.env['ARENA_SETTLEMENT_RECEIPTS_PATH'],
    });
  }

  const normalizedEndpoint = endpoint?.trim();
  if (normalizedEndpoint) {
    return new HttpSeasonSubmitter(normalizedEndpoint, {
      authToken,
      hmacSecret: process.env['ARENA_SETTLEMENT_HMAC_SECRET'],
      timeoutMs: parsePositiveInt(process.env['ARENA_SETTLEMENT_TIMEOUT_MS'], 5000),
      maxAttempts: parsePositiveInt(process.env['ARENA_SETTLEMENT_MAX_ATTEMPTS'], 3),
      backoffMs: parsePositiveInt(process.env['ARENA_SETTLEMENT_BACKOFF_MS'], 750),
      deadLetterPath: process.env['ARENA_SETTLEMENT_DLQ_PATH'],
    });
  }
  return new LoggingSeasonSubmitter();
}

function asBytes32(value: string, field: string): string {
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex value`);
  }
  return normalized;
}

function persistJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf-8');
}

function toWeightsWad(entries: [string, number][]): bigint[] {
  const target = 10n ** 18n;
  const weights = entries.map(([, w]) => (w > 0 ? w : 0));
  if (weights.length === 0) return [];

  const ints = weights.map((w) => BigInt(Math.floor(w * 1e18)));
  let sum = ints.reduce((a, b) => a + b, 0n);
  const deficit = target - sum;
  if (deficit === 0n) return ints;

  let maxIndex = 0;
  for (let i = 1; i < weights.length; i++) {
    if (weights[i] > weights[maxIndex]) maxIndex = i;
  }

  ints[maxIndex] = ints[maxIndex] + deficit;
  sum = ints.reduce((a, b) => a + b, 0n);
  if (sum !== target || ints.some((v) => v < 0n)) {
    throw new Error('Failed to normalize settlement weights to 1e18');
  }
  return ints;
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runProcess(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const outPath = join(tmpdir(), `arena-cast-out-${randomUUID()}.log`);
    const errPath = join(tmpdir(), `arena-cast-err-${randomUUID()}.log`);
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');
    const child = spawn(cmd, args, {
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...extraEnv },
    });
    child.on('error', (err) => {
      closeSync(outFd);
      closeSync(errFd);
      try { unlinkSync(outPath); } catch {}
      try { unlinkSync(errPath); } catch {}
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      closeSync(outFd);
      closeSync(errFd);
      const stdout = readFileSync(outPath, 'utf-8').trim();
      const stderr = readFileSync(errPath, 'utf-8').trim();
      try { unlinkSync(outPath); } catch {}
      try { unlinkSync(errPath); } catch {}
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}
