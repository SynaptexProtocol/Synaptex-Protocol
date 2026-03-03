import { createHash } from 'crypto';
import type { AgentSeasonResult } from './interfaces/i-settlement.js';

export interface LeaderboardEntry {
  rank: number;
  agent_id: string;
  agent_name: string;
  roi: number;
  total_value_usd: number;
  signal_count: number;
  trade_count: number;
  is_valid: boolean;
  settlement_weight: number;  // 0 if invalid
}

export interface Leaderboard {
  season_id: string;
  updated_at: string;
  entries: LeaderboardEntry[];
  leaderboard_hash: string;
}

const MIN_SIGNALS = 3;
const MIN_TRADES = 1;

export function isValidAgent(result: AgentSeasonResult): boolean {
  return result.signal_count >= MIN_SIGNALS
    && result.trade_count >= MIN_TRADES
    && result.status !== 'disqualified';
}

export function buildLeaderboard(
  seasonId: string,
  results: AgentSeasonResult[],
  weights: Record<string, number>,
  portfolioValues: Record<string, number>,
): Leaderboard {
  const entries: LeaderboardEntry[] = results
    .map((r, _i) => ({
      rank: 0,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      roi: r.roi,
      total_value_usd: portfolioValues[r.agent_id] ?? 0,
      signal_count: r.signal_count,
      trade_count: r.trade_count,
      is_valid: isValidAgent(r),
      settlement_weight: weights[r.agent_id] ?? 0,
    }))
    .sort((a, b) => b.roi - a.roi);

  entries.forEach((e, i) => { e.rank = i + 1; });

  const leaderboard_hash = createHash('sha256')
    .update(JSON.stringify(entries.map(e => ({
      agent_id: e.agent_id,
      roi: e.roi,
      weight: e.settlement_weight,
    }))))
    .digest('hex');

  return {
    season_id: seasonId,
    updated_at: new Date().toISOString(),
    entries,
    leaderboard_hash,
  };
}
