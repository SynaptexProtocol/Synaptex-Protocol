import type { LeaderboardEntry } from '../leaderboard.js';

export interface SeasonSettlementPayload {
  season_id: string;
  leaderboard_hash: string;
  merkle_root: string;
  weights: Record<string, number>;
  leaderboard: LeaderboardEntry[];
  /** WAD-scaled reputation score deltas per agent (agentId → delta). Populated after settlement. */
  reputation_deltas?: Record<string, number>;
}

