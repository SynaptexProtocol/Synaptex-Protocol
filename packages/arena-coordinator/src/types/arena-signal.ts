import { createHash } from 'crypto';

export type ArenaAction = 'BUY' | 'SELL' | 'HOLD';
export type ArenaToken = 'ETH' | 'cbBTC' | 'USDC';

export interface ArenaSignal {
  agent_id: string;
  token: ArenaToken;
  action: ArenaAction;
  amount_usd: number | null;   // null for HOLD
  confidence: number;          // 0.0 - 1.0
  reason: string;
  timestamp: string;           // ISO8601
  cycle_id: string;
}

/**
 * Generate a Merkle leaf hash for a signal.
 * Format: keccak256-like hash of canonical JSON fields.
 * Field order is fixed and MUST NOT change (on-chain verification depends on this).
 */
export function signalToLeaf(signal: ArenaSignal): string {
  const canonical = JSON.stringify({
    agent_id: signal.agent_id,
    token: signal.token,
    action: signal.action,
    amount_usd: signal.amount_usd,
    confidence: signal.confidence,
    reason: signal.reason,
    timestamp: signal.timestamp,
    cycle_id: signal.cycle_id,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Build a simple binary Merkle root from an array of leaf hashes.
 * Used for learningRoot in BAP-578 style on-chain verification.
 */
export function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return '0'.repeat(64);
  if (leaves.length === 1) return leaves[0];

  let layer = [...leaves];
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? layer[i]; // duplicate last if odd
      const combined = left < right ? left + right : right + left; // sort for determinism
      next.push(createHash('sha256').update(combined, 'hex').digest('hex'));
    }
    layer = next;
  }
  return layer[0];
}
