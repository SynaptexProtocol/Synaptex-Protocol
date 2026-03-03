import type { ArenaToken } from './arena-signal.js';

export interface VirtualPosition {
  token: ArenaToken;
  amount: number;           // token units
  avg_cost_usd: number;     // average purchase price
  current_value_usd: number;
}

export interface VirtualPortfolio {
  agent_id: string;
  season_id: string;
  cash_usd: number;
  positions: VirtualPosition[];
  total_value_usd: number;
  roi: number;              // (total_value / starting_value) - 1
  starting_value_usd: number;
  updated_at: string;
}
