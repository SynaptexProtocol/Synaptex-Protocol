/**
 * Minimal SDK-compatible agent module.
 * Arena runtime loads this file and calls exported `decide(input)`.
 */
export async function decide(input) {
  const eth = input?.snapshot?.tokens?.ETH;
  const change = Number(eth?.change24h ?? 0);
  const signals = [];

  if (change > 0.015) {
    signals.push({
      action: 'BUY',
      token: 'ETH',
      amount_usd: 80,
      confidence: 0.66,
      reason: 'mock sdk momentum long',
    });
  } else if (change < -0.015) {
    signals.push({
      action: 'SELL',
      token: 'ETH',
      amount_usd: 80,
      confidence: 0.66,
      reason: 'mock sdk momentum short',
    });
  }

  return {
    schema_version: '2.0',
    trace_id: input?.trace_id,
    idempotency_key: input?.idempotency_key,
    signals,
  };
}

export default { decide };

