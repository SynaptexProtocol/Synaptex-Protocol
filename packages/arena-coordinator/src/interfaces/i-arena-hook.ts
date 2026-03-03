import type { ArenaSignal } from '../types/arena-signal.js';
import type { VirtualTrade } from '../virtual-portfolio.js';
import type { Season } from '../types/season.js';
import type { LeaderboardEntry } from '../leaderboard.js';
import type { SeasonSettlementPayload } from '../types/season-settlement.js';

export interface CycleCompleteEvent {
  seasonId: string;
  cycleId: string;
  cycleRoot: string;
  timestamp: string;
  signalCount: number;
  tradeCount: number;
}

export interface IArenaHook {
  onCycleComplete?(event: CycleCompleteEvent): Promise<void>;
  onSeasonStart?(season: Season): Promise<void>;
  onSeasonEnd?(
    season: Season,
    leaderboard: LeaderboardEntry[],
    settlement?: SeasonSettlementPayload,
  ): Promise<void>;
  onAgentError?(agentId: string, error: Error): Promise<void>;
}
