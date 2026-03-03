import type { MarketSnapshot } from '@synaptex/core';
import type { ArenaSignal } from '../types/arena-signal.js';
import type { VirtualPortfolio } from '../types/virtual-portfolio.js';
import type { VirtualTrade } from '../virtual-portfolio.js';

export interface AgentDecisionMeta {
  schemaVersion?: string;
  traceId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  responseHash?: string;
  latencyMs?: number;
}

export interface IArenaAgent {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type: 'internal' | 'webhook' | 'stdio' | 'sdk';
  /** Optional: ordered list of strategy names used by this agent (for registry display). */
  readonly strategyTags?: string[];

  decide(
    snapshot: MarketSnapshot,
    portfolio: VirtualPortfolio,
  ): Promise<ArenaSignal[]>;

  // Optional learning feedback after each cycle
  onCycleResult?(
    signals: ArenaSignal[],
    executed: VirtualTrade[],
  ): Promise<void>;

  // Optional debug/audit metadata for the last decision cycle.
  getLastDecisionMeta?(): AgentDecisionMeta | null;
}
