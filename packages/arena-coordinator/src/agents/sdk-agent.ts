import { createHash } from 'crypto';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import type { MarketSnapshot } from '@synaptex/core';
import type { IArenaAgent, AgentDecisionMeta } from '../interfaces/i-arena-agent.js';
import type { ArenaAction, ArenaSignal, ArenaToken } from '../types/arena-signal.js';
import type { VirtualPortfolio } from '../types/virtual-portfolio.js';
import type { VirtualTrade } from '../virtual-portfolio.js';

export interface SdkAgentConfig {
  id: string;
  name: string;
  owner: string;
  modulePath: string;
  timeoutMs?: number;
  maxSignalsPerCycle?: number;
}

interface SdkSignal {
  action?: string;
  token?: string;
  amount_usd?: number;
  confidence?: number;
  reason?: string;
}

interface SdkResponse {
  schema_version?: string;
  trace_id?: string;
  idempotency_key?: string;
  signals?: SdkSignal[];
}

type SdkDecideFn = (input: Record<string, unknown>) => Promise<SdkResponse | SdkSignal[] | null | undefined>;

export class SdkAgent implements IArenaAgent {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type = 'sdk' as const;

  private readonly timeoutMs: number;
  private readonly maxSignalsPerCycle: number;
  private sdkDecide: SdkDecideFn | null = null;
  private lastDecisionMeta: AgentDecisionMeta | null = null;

  constructor(private readonly config: SdkAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.owner = config.owner;
    this.timeoutMs = Math.max(500, Math.floor(config.timeoutMs ?? 4000));
    this.maxSignalsPerCycle = Math.max(1, Math.floor(config.maxSignalsPerCycle ?? 20));
  }

  async decide(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): Promise<ArenaSignal[]> {
    const traceId = `${this.id}-${Date.now()}`;
    const idempotencyKey = `${this.id}:${snapshot.cycleId}`;
    const payload = {
      schema_version: '2.0',
      trace_id: traceId,
      idempotency_key: idempotencyKey,
      agent_id: this.id,
      season_id: portfolio.season_id,
      cycle_id: snapshot.cycleId,
      timestamp: snapshot.timestamp,
      snapshot: { tokens: snapshot.tokens },
      portfolio: {
        cash_usd: portfolio.cash_usd,
        positions: portfolio.positions,
        total_value_usd: portfolio.total_value_usd,
        roi: portfolio.roi,
      },
    } as const;
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const startedAt = Date.now();

    const fn = await this.loadDecide();
    if (!fn) {
      this.lastDecisionMeta = { schemaVersion: '2.0', traceId, idempotencyKey, requestHash, latencyMs: Date.now() - startedAt };
      return [];
    }

    const result = await this.withTimeout(fn(payload), this.timeoutMs);
    if (!result.ok) {
      this.lastDecisionMeta = { schemaVersion: '2.0', traceId, idempotencyKey, requestHash, latencyMs: Date.now() - startedAt };
      return [];
    }

    const normalized = this.normalizeResponse(result.value);
    this.lastDecisionMeta = {
      schemaVersion: normalized.schema_version ?? '2.0',
      traceId: normalized.trace_id ?? traceId,
      idempotencyKey: normalized.idempotency_key ?? idempotencyKey,
      requestHash,
      responseHash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
      latencyMs: Date.now() - startedAt,
    };
    return this.sanitizeSignals(normalized.signals ?? [], snapshot.cycleId);
  }

  async onCycleResult(_signals: ArenaSignal[], _executed: VirtualTrade[]): Promise<void> {
    // Reserved for future feedback.
  }

  getLastDecisionMeta(): AgentDecisionMeta | null {
    return this.lastDecisionMeta;
  }

  private async loadDecide(): Promise<SdkDecideFn | null> {
    if (this.sdkDecide) return this.sdkDecide;
    try {
      const modulePath = resolve(this.config.modulePath);
      const mod = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
      const maybeFn = mod['decide'] ?? (mod['default'] as Record<string, unknown> | undefined)?.['decide'];
      if (typeof maybeFn !== 'function') return null;
      this.sdkDecide = maybeFn as SdkDecideFn;
      return this.sdkDecide;
    } catch {
      return null;
    }
  }

  private normalizeResponse(value: SdkResponse | SdkSignal[] | null | undefined): SdkResponse {
    if (!value) return { signals: [] };
    if (Array.isArray(value)) return { signals: value };
    return value;
  }

  private sanitizeSignals(raw: SdkSignal[], cycleId: string): ArenaSignal[] {
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false }> {
    let timer: NodeJS.Timeout | null = null;
    try {
      const value = await Promise.race([
        promise,
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(Symbol.for('timeout')), timeoutMs);
        }),
      ]);
      if (value === Symbol.for('timeout')) {
        return { ok: false };
      }
      return { ok: true, value: value as T };
    } catch {
      return { ok: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function normalizeAction(value: string | undefined): ArenaAction | null {
  const v = String(value ?? '').trim().toUpperCase();
  if (v === 'BUY' || v === 'SELL' || v === 'HOLD') return v;
  return null;
}

function normalizeToken(value: string | undefined): ArenaToken | null {
  const v = String(value ?? '').trim();
  if (v === 'ETH' || v === 'cbBTC' || v === 'USDC') return v;
  return null;
}

