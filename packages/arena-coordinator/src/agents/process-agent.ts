import { spawn } from 'child_process';
import type { MarketSnapshot } from '@synaptex/core';
import type { IArenaAgent } from '../interfaces/i-arena-agent.js';
import type { AgentDecisionMeta } from '../interfaces/i-arena-agent.js';
import type { ArenaAction, ArenaSignal, ArenaToken } from '../types/arena-signal.js';
import type { VirtualPortfolio } from '../types/virtual-portfolio.js';
import type { VirtualTrade } from '../virtual-portfolio.js';

export interface ProcessAgentConfig {
  id: string;
  name: string;
  owner: string;
  command: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxSignalsPerCycle?: number;
}

interface ProcessSignal {
  action: string;
  token: string;
  amount_usd?: number;
  confidence?: number;
  reason?: string;
}

interface ProcessResponse {
  signals?: ProcessSignal[];
  trace_id?: string;
  idempotency_key?: string;
}

export class ProcessAgent implements IArenaAgent {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type = 'stdio' as const;

  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxSignalsPerCycle: number;
  private lastDecisionMeta: AgentDecisionMeta | null = null;

  constructor(private readonly config: ProcessAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.owner = config.owner;
    this.timeoutMs = Math.max(500, Math.floor(config.timeoutMs ?? 4000));
    this.maxStdoutBytes = Math.max(1024, Math.floor(config.maxStdoutBytes ?? 256 * 1024));
    this.maxSignalsPerCycle = Math.max(1, Math.floor(config.maxSignalsPerCycle ?? 20));
  }

  async decide(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): Promise<ArenaSignal[]> {
    const startedAt = Date.now();
    const idempotencyKey = `${this.id}:${snapshot.cycleId}`;
    const traceId = `${this.id}-${Date.now()}`;
    const payload = {
      schema_version: '2.0',
      trace_id: traceId,
      idempotency_key: idempotencyKey,
      agent_id: this.id,
      season_id: portfolio.season_id,
      cycle_id: snapshot.cycleId,
      timestamp: snapshot.timestamp,
      snapshot: {
        tokens: snapshot.tokens,
      },
      portfolio: {
        cash_usd: portfolio.cash_usd,
        positions: portfolio.positions,
        total_value_usd: portfolio.total_value_usd,
        roi: portfolio.roi,
      },
    };

    let stdout = '';
    const cmd = parseCommand(this.config.command);
    if (!cmd) {
      this.lastDecisionMeta = { schemaVersion: '2.0', traceId, idempotencyKey, latencyMs: Date.now() - startedAt };
      return [];
    }

    const proc = spawn(cmd.file, cmd.args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    const result = await new Promise<{ ok: boolean; stderr?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ ok: false, stderr: 'Process timeout' });
      }, this.timeoutMs);

      proc.stdout.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, 'utf-8') > this.maxStdoutBytes) {
          proc.kill();
          clearTimeout(timeout);
          resolve({ ok: false, stderr: 'stdout too large' });
        }
      });

      let stderr = '';
      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (chunk: string) => { stderr += chunk; });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, stderr: err.message });
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, stderr: stderr || `exit code ${code}` });
      });
    });

    this.lastDecisionMeta = {
      schemaVersion: '2.0',
      traceId,
      idempotencyKey,
      latencyMs: Date.now() - startedAt,
    };

    if (!result.ok) {
      return [];
    }

    let response: ProcessResponse;
    try {
      response = JSON.parse(stdout) as ProcessResponse;
    } catch {
      return [];
    }

    if (response.trace_id) this.lastDecisionMeta.traceId = response.trace_id;
    if (response.idempotency_key) this.lastDecisionMeta.idempotencyKey = response.idempotency_key;

    return this.sanitizeSignals(response.signals ?? [], snapshot.cycleId);
  }

  async onCycleResult(_signals: ArenaSignal[], _executed: VirtualTrade[]): Promise<void> {
    // Optional feedback channel for stdio agents in future.
  }

  getLastDecisionMeta(): AgentDecisionMeta | null {
    return this.lastDecisionMeta;
  }

  private sanitizeSignals(raw: ProcessSignal[], cycleId: string): ArenaSignal[] {
    const out: ArenaSignal[] = [];
    for (const s of raw.slice(0, this.maxSignalsPerCycle)) {
      const action = normalizeAction(s.action);
      const token = normalizeToken(s.token);
      if (!action || !token) continue;
      const amount = action === 'HOLD'
        ? null
        : Number.isFinite(s.amount_usd) && (s.amount_usd ?? 0) > 0
          ? Number(s.amount_usd)
          : null;
      if (action !== 'HOLD' && amount === null) continue;

      out.push({
        agent_id: this.id,
        token,
        action,
        amount_usd: amount,
        confidence: Math.max(0, Math.min(1, Number(s.confidence ?? 0))),
        reason: String(s.reason ?? '').slice(0, 280),
        timestamp: new Date().toISOString(),
        cycle_id: cycleId,
      });
    }
    return out;
  }
}

function parseCommand(input: string): { file: string; args: string[] } | null {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;

  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if ((ch === '"' || ch === "'")) {
      if (!quote) {
        quote = ch;
        continue;
      }
      if (quote === ch) {
        quote = null;
        continue;
      }
    }
    if (!quote && /\s/.test(ch)) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (quote) return null;
  if (buf) parts.push(buf);
  if (parts.length === 0) return null;
  return { file: parts[0]!, args: parts.slice(1) };
}

function normalizeAction(value: string): ArenaAction | null {
  const v = String(value ?? '').trim().toUpperCase();
  if (v === 'BUY' || v === 'SELL' || v === 'HOLD') return v;
  return null;
}

function normalizeToken(value: string): ArenaToken | null {
  const v = String(value ?? '').trim();
  if (v === 'ETH' || v === 'cbBTC' || v === 'USDC') return v;
  return null;
}
