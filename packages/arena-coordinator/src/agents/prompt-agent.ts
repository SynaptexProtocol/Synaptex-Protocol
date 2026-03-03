import type { MarketSnapshot } from '@synaptex/core';
import type { IArenaAgent } from '../interfaces/i-arena-agent.js';
import type { ArenaSignal, ArenaToken, ArenaAction } from '../types/arena-signal.js';
import type { VirtualPortfolio } from '../types/virtual-portfolio.js';
import type { VirtualTrade } from '../virtual-portfolio.js';

export interface PromptAgentConfig {
  id: string;
  name: string;
  owner: string;
  strategyPrompt: string;
  /** Override LLM model. Defaults to claude-haiku-4-5-20251001. */
  model?: string;
}

const SYSTEM_TEMPLATE = `You are an autonomous AI trading agent competing in the Synaptex Protocol arena.

USER STRATEGY:
{strategy_prompt}

RULES:
- Tokens you may trade: BNB, BTCB, USDT
- Actions: BUY, SELL, HOLD
- Respond ONLY with valid JSON — no markdown fences, no explanation
- Return 0-3 signals per cycle
- amount_usd must be > 0 for BUY/SELL; omit for HOLD
- confidence: 0.0 – 1.0
- reason: max 100 characters

OUTPUT FORMAT (exact):
{"signals":[{"token":"BNB","action":"BUY","amount_usd":500,"confidence":0.75,"reason":"brief reason"}]}`;

interface AnthropicContent { type: string; text: string; }
interface AnthropicResponse { content?: AnthropicContent[]; }

async function callClaude(apiKey: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json() as AnthropicResponse;
  return data.content?.[0]?.text ?? '';
}

export class PromptAgent implements IArenaAgent {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type = 'prompt' as const;

  private consecutiveFailures = 0;
  private readonly MAX_FAILURES = 5;

  constructor(private readonly config: PromptAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.owner = config.owner;
  }

  async decide(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): Promise<ArenaSignal[]> {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      console.warn(`[PromptAgent ${this.id}] ANTHROPIC_API_KEY not set, skipping`);
      return [];
    }
    if (this.consecutiveFailures >= this.MAX_FAILURES) return [];

    const systemPrompt = SYSTEM_TEMPLATE.replace('{strategy_prompt}', this.config.strategyPrompt);
    const userPrompt = this.buildUserPrompt(snapshot, portfolio);
    const model = this.config.model ?? 'claude-haiku-4-5-20251001';

    try {
      const raw = await callClaude(apiKey, model, systemPrompt, userPrompt);
      this.consecutiveFailures = 0;
      return this.parseSignals(raw, snapshot.cycleId);
    } catch (err) {
      this.consecutiveFailures++;
      console.error(`[PromptAgent ${this.id}] LLM error (${this.consecutiveFailures}/${this.MAX_FAILURES}):`, err);
      return [];
    }
  }

  private buildUserPrompt(snapshot: MarketSnapshot, portfolio: VirtualPortfolio): string {
    const prices = Object.entries(snapshot.tokens)
      .map(([sym, d]) => `${sym}: $${d.price.toFixed(2)} (24h: ${(d.change24h * 100).toFixed(2)}%)`)
      .join(' | ');

    const positions = portfolio.positions
      .filter(p => p.amount > 0)
      .map(p => `${p.token}: ${p.amount.toFixed(4)} ($${p.current_value_usd.toFixed(2)})`)
      .join(', ') || 'none';

    return `Market: ${prices}
Portfolio: $${portfolio.total_value_usd.toFixed(2)} total | cash $${portfolio.cash_usd.toFixed(2)} | ROI ${(portfolio.roi * 100).toFixed(2)}%
Positions: ${positions}
Cycle: ${snapshot.cycleId}

Apply your strategy and return signals JSON now.`;
  }

  private parseSignals(raw: string, cycleId: string): ArenaSignal[] {
    try {
      const cleaned = raw.replace(/```(?:json)?/g, '').trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const data = JSON.parse(match[0]) as { signals?: unknown[] };
      if (!Array.isArray(data.signals)) return [];

      return data.signals
        .slice(0, 3)
        .map((s: unknown) => {
          if (!s || typeof s !== 'object') return null;
          const obj = s as Record<string, unknown>;
          const action = String(obj['action'] ?? '').trim().toUpperCase() as ArenaAction;
          if (!['BUY', 'SELL', 'HOLD'].includes(action)) return null;
          const token = String(obj['token'] ?? '').trim() as ArenaToken;
          if (!['BNB', 'BTCB', 'USDT'].includes(token)) return null;
          const amount_usd = action === 'HOLD'
            ? null
            : Number.isFinite(Number(obj['amount_usd'])) && Number(obj['amount_usd']) > 0
              ? Number(obj['amount_usd'])
              : null;
          if (action !== 'HOLD' && amount_usd === null) return null;
          return {
            agent_id: this.id,
            token,
            action,
            amount_usd,
            confidence: Math.max(0, Math.min(1, Number(obj['confidence'] ?? 0.5))),
            reason: String(obj['reason'] ?? '').slice(0, 100),
            timestamp: new Date().toISOString(),
            cycle_id: cycleId,
          } satisfies ArenaSignal;
        })
        .filter((x): x is ArenaSignal => x !== null);
    } catch {
      return [];
    }
  }

  async onCycleResult(_signals: ArenaSignal[], _executed: VirtualTrade[]): Promise<void> {
    // Stateless — no feedback loop
  }
}
