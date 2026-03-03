import { createHmac, createHash, randomUUID } from 'crypto';
import type { MarketSnapshot } from '@synaptex/core';
import type { IArenaAgent } from '../interfaces/i-arena-agent.js';
import type { AgentDecisionMeta } from '../interfaces/i-arena-agent.js';
import type { ArenaSignal, ArenaToken, ArenaAction } from '../types/arena-signal.js';
import type { VirtualPortfolio } from '../types/virtual-portfolio.js';
import type { VirtualTrade } from '../virtual-portfolio.js';

export interface WebhookAgentConfig {
  id: string;
  name: string;
  owner: string;
  webhookUrl: string;
  webhookSecret: string;
  timeoutMs: number;  // default 5000
  maxSignalsPerCycle?: number; // default 20
  maxReasonLength?: number; // default 280
}

interface WebhookRequest {
  schema_version: '2.0';
  trace_id: string;
  idempotency_key: string;
  agent_id: string;
  season_id: string;
  cycle_id: string;
  timestamp: string;
  snapshot: {
    tokens: Record<string, {
      price: number;
      change24h: number;
      candles1h: unknown[];
    }>;
  };
  portfolio: {
    cash_usd: number;
    positions: Array<{ token: string; amount: number; current_value_usd: number }>;
    total_value_usd: number;
    roi: number;
  };
}

interface WebhookResponseSignal {
  token: string;
  action: string;
  amount_usd?: number;
  confidence: number;
  reason: string;
}

interface WebhookResponse {
  schema_version?: string;
  trace_id?: string;
  idempotency_key?: string;
  signals?: WebhookResponseSignal[];
}

/**
 * WebhookAgent sends the market snapshot to an external HTTP endpoint
 * and converts the response into ArenaSignal[].
 *
 * Timeout: 5 seconds (configurable)
 * Auth: HMAC-SHA256 signature in X-Arena-Signature header
 * Failure tracking: consecutive failures tracked, 3x = disqualified
 */
export class WebhookAgent implements IArenaAgent {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type = 'webhook' as const;

  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 3;
  private lastDecisionMeta: AgentDecisionMeta | null = null;
  private readonly maxSignalsPerCycle: number;
  private readonly maxReasonLength: number;

  constructor(private readonly config: WebhookAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.owner = config.owner;
    this.maxSignalsPerCycle = Math.max(1, Math.floor(config.maxSignalsPerCycle ?? 20));
    this.maxReasonLength = Math.max(32, Math.floor(config.maxReasonLength ?? 280));
  }

  isDisqualified(): boolean {
    return this.consecutiveFailures >= this.MAX_FAILURES;
  }

  async decide(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): Promise<ArenaSignal[]> {
    if (this.isDisqualified()) return [];

    const traceId = randomUUID();
    const idempotencyKey = `${this.id}:${snapshot.cycleId}`;
    const body = this.buildRequestBody(snapshot, portfolio, traceId, idempotencyKey);
    const bodyStr = JSON.stringify(body);
    const signature = this.sign(bodyStr);
    const requestHash = createHash('sha256').update(bodyStr).digest('hex');
    const startedAt = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);

    try {
      const res = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Arena-Version': '2.0',
          'X-Arena-Trace-Id': traceId,
          'X-Arena-Idempotency-Key': idempotencyKey,
          'X-Arena-Signature': signature,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as WebhookResponse;
      this.consecutiveFailures = 0;
      const responseHash = createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex');
      this.lastDecisionMeta = {
        schemaVersion: data.schema_version ?? '2.0',
        traceId: data.trace_id ?? traceId,
        idempotencyKey: data.idempotency_key ?? idempotencyKey,
        requestHash,
        responseHash,
        latencyMs: Date.now() - startedAt,
      };

      return this.sanitizeSignals(data.signals ?? [], snapshot.cycleId);
    } catch (err) {
      this.consecutiveFailures++;
      this.lastDecisionMeta = {
        schemaVersion: '2.0',
        traceId,
        idempotencyKey,
        requestHash,
        latencyMs: Date.now() - startedAt,
      };
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[WebhookAgent ${this.id}] Failure ${this.consecutiveFailures}/${this.MAX_FAILURES}: ${reason}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRequestBody(
    snapshot: MarketSnapshot,
    portfolio: VirtualPortfolio,
    traceId: string,
    idempotencyKey: string,
  ): WebhookRequest {
    const tokens: WebhookRequest['snapshot']['tokens'] = {};
    for (const [symbol, data] of Object.entries(snapshot.tokens)) {
      tokens[symbol] = {
        price: data.price,
        change24h: data.change24h,
        candles1h: data.candles1h,
      };
    }

    return {
      schema_version: '2.0',
      trace_id: traceId,
      idempotency_key: idempotencyKey,
      agent_id: this.id,
      season_id: portfolio.season_id,
      cycle_id: snapshot.cycleId,
      timestamp: snapshot.timestamp,
      snapshot: { tokens },
      portfolio: {
        cash_usd: portfolio.cash_usd,
        positions: portfolio.positions.map(p => ({
          token: p.token,
          amount: p.amount,
          current_value_usd: p.current_value_usd,
        })),
        total_value_usd: portfolio.total_value_usd,
        roi: portfolio.roi,
      },
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.config.webhookSecret)
      .update(body)
      .digest('hex');
  }

  async onCycleResult(_signals: ArenaSignal[], _executed: VirtualTrade[]): Promise<void> {
    // Webhook agents don't get feedback (stateless external service)
  }

  getLastDecisionMeta(): AgentDecisionMeta | null {
    return this.lastDecisionMeta;
  }

  private sanitizeSignals(raw: WebhookResponseSignal[], cycleId: string): ArenaSignal[] {
    const trimmed = raw.slice(0, this.maxSignalsPerCycle);
    const out: ArenaSignal[] = [];
    for (const s of trimmed) {
      const action = normalizeAction(s.action);
      if (!action) continue;
      const token = normalizeToken(s.token);
      if (!token) continue;

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
        reason: String(s.reason ?? '').slice(0, this.maxReasonLength),
        timestamp: new Date().toISOString(),
        cycle_id: cycleId,
      });
    }
    return out;
  }
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
