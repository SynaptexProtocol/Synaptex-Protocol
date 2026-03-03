import type { StrategySignal, MarketSnapshot, AgentMemoryEntry } from '@synaptex/core';

export const SYSTEM_PROMPT = `You are an autonomous BNB Chain trading agent decision engine.
Evaluate each trading signal and respond with a JSON object ONLY — no prose, no markdown.
Response format:
{
  "approved": boolean,
  "adjustedAmountUsd": number | null,
  "reasoning": "one concise sentence",
  "confidence": 0.0-1.0
}`;

export function buildEvaluationPrompt(
  signal: StrategySignal,
  snapshot: MarketSnapshot,
  memory: AgentMemoryEntry[],
): string {
  const token = snapshot.tokens[signal.token];
  const recentMemory = memory
    .slice(-5)
    .map((m) => `[${m.type}] ${m.summary}`)
    .join('\n');

  return `Trading Signal Evaluation

Signal:
- Strategy: ${signal.strategyId}
- Action: ${signal.action} ${signal.token}
- Amount: $${signal.amountUsd?.toFixed(2) ?? 'unspecified'}
- Confidence: ${(signal.confidence * 100).toFixed(1)}%
- Rationale: ${signal.rationale}

Market Context (${signal.token}):
- Price: $${token?.price.toFixed(4) ?? 'unknown'}
- 24h Change: ${((token?.change24h ?? 0) * 100).toFixed(2)}%
- 24h Volume: $${((token?.volume24h ?? 0) / 1e6).toFixed(1)}M

Portfolio:
- Total Value: $${snapshot.portfolio.totalValueUsd.toFixed(2)}
- Daily P&L: $${snapshot.portfolio.dailyPnlUsd.toFixed(2)}
- USDT Balance: $${snapshot.portfolio.stableBalance.toFixed(2)}

Recent Agent Memory (last 5 actions):
${recentMemory || 'No recent history'}

Should this trade be executed? Respond with JSON only.`;
}

export function parseDecisionJson(
  raw: string,
): { approved: boolean; adjustedAmountUsd?: number; reasoning: string; confidence: number } | null {
  // Strip potential markdown code fences
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
}
