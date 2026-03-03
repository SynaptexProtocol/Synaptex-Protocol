export type SeasonStatus = 'pending' | 'active' | 'settling' | 'settled';

/**
 * Season duration preset labels used for display / marketing.
 * Maps to the underlying duration_minutes.
 */
export type SeasonPreset = 'micro' | 'hourly' | 'daily' | 'weekly' | 'custom';

export const SEASON_PRESET_MINUTES: Record<Exclude<SeasonPreset, 'custom'>, number> = {
  micro:  15,
  hourly: 60,
  daily:  60 * 24,
  weekly: 60 * 24 * 7,
};

export interface Season {
  id: string;
  status: SeasonStatus;
  start_time: string;          // ISO8601
  end_time: string;            // ISO8601
  settled_at?: string;         // ISO8601, set when settled
  /** Canonical duration field — minutes */
  duration_minutes: number;
  /** Derived: duration_minutes / 1440 (kept for backwards compat + display) */
  duration_days: number;
  /** Human-readable preset label */
  preset?: SeasonPreset;
  cycle_count: number;
  agent_ids: string[];
  leaderboard_hash?: string;
  settlement_algorithm: string;
}
