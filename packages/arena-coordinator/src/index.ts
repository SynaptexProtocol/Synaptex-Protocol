// Interfaces
export type { IArenaAgent } from './interfaces/i-arena-agent.js';
export type { ISettlementAlgorithm, AgentSeasonResult, SettlementParams } from './interfaces/i-settlement.js';
export type { IArenaHook, CycleCompleteEvent } from './interfaces/i-arena-hook.js';

// Types
export type { ArenaSignal, ArenaToken, ArenaAction } from './types/arena-signal.js';
export { signalToLeaf, buildMerkleRoot } from './types/arena-signal.js';
export type { VirtualPortfolio, VirtualPosition } from './types/virtual-portfolio.js';
export type { Season, SeasonStatus } from './types/season.js';
export type { SeasonSettlementPayload } from './types/season-settlement.js';

// Core classes
export { VirtualPortfolioManager } from './virtual-portfolio.js';
export type { VirtualTrade } from './virtual-portfolio.js';
export { SeasonManager } from './season-manager.js';
export { buildLeaderboard, isValidAgent } from './leaderboard.js';
export type { Leaderboard, LeaderboardEntry } from './leaderboard.js';

// Agents
export { InternalAgent } from './agents/internal-agent.js';
export type { InternalAgentConfig } from './agents/internal-agent.js';
export { WebhookAgent } from './agents/webhook-agent.js';
export type { WebhookAgentConfig } from './agents/webhook-agent.js';
export { ProcessAgent } from './agents/process-agent.js';
export type { ProcessAgentConfig } from './agents/process-agent.js';
export { SdkAgent } from './agents/sdk-agent.js';
export type { SdkAgentConfig } from './agents/sdk-agent.js';

// Settlement
export { SoftmaxSettlement } from './settlement/softmax.js';

// Engine
export { ArenaEngine } from './arena-engine.js';
export type { ArenaEngineConfig } from './arena-engine.js';
