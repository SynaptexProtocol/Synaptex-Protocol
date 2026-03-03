import type { MarketSnapshot } from '@synaptex/core';
import type { IArenaAgent } from '../interfaces/i-arena-agent.js';
import type { ArenaSignal, ArenaToken, ArenaAction } from '../types/arena-signal.js';
import type { VirtualPortfolio } from '../types/virtual-portfolio.js';
import type { VirtualTrade } from '../virtual-portfolio.js';
import { IpcClient } from '@synaptex/ipc-bridge';
import { DecisionGate } from '@synaptex/ai-brain';
import type { DecisionGateConfig } from '@synaptex/ai-brain';
import { randomUUID } from 'crypto';

export interface InternalAgentConfig {
  id: string;
  name: string;
  owner: string;
  strategyWeights: Record<string, number>;  // e.g. { trend_swap: 0.7, momentum: 0.3 }
  ipc: IpcClient;
  decisionGateConfig: DecisionGateConfig;
}

/**
 * InternalAgent wraps the existing IPC + DecisionGate pipeline.
 * It sends the MarketSnapshot to Python, gets signals, runs them
 * through the AI gate, and converts approved decisions → ArenaSignal[].
 */
export class InternalAgent implements IArenaAgent {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly type = 'internal' as const;
  readonly strategyTags: string[];

  private gate: DecisionGate;
  private ipc: IpcClient;

  constructor(private readonly config: InternalAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.owner = config.owner;
    this.strategyTags = Object.keys(config.strategyWeights);
    this.gate = new DecisionGate(config.decisionGateConfig);
    this.ipc = config.ipc;
  }

  async decide(snapshot: MarketSnapshot, _portfolio: VirtualPortfolio): Promise<ArenaSignal[]> {
    const cycleId = snapshot.cycleId;

    const ethPosition = _portfolio.positions.find((p) => p.token === 'ETH');
    // Inject per-agent strategy context into snapshot
    const agentSnapshot: MarketSnapshot = {
      ...snapshot,
      portfolio: {
        walletAddress: this.id,
        nativeBalance: ethPosition?.amount ?? 0,
        stableBalance: _portfolio.cash_usd,
        positions: _portfolio.positions.map((p) => ({
          token: p.token,
          amount: p.amount,
          avgCostUsd: p.avg_cost_usd,
          currentValueUsd: p.current_value_usd,
        })),
        totalValueUsd: _portfolio.total_value_usd,
        dailyPnlUsd: _portfolio.total_value_usd - _portfolio.starting_value_usd,
        timestamp: snapshot.timestamp,
      },
      activeStrategies: Object.keys(this.config.strategyWeights),
      strategyWeights: this.config.strategyWeights,
    };

    let signalBatch;
    try {
      signalBatch = await this.ipc.processSnapshot(agentSnapshot);
    } catch (err) {
      console.error(`[InternalAgent ${this.id}] IPC error:`, err);
      return [];
    }

    if (signalBatch.riskVetoed && signalBatch.signals.length === 0) {
      console.warn(`[InternalAgent ${this.id}] Risk veto: ${signalBatch.vetoReason}`);
      return [];
    }

    const approved = await this.gate.processSignals(signalBatch, snapshot, []);

    return approved.map(d => ({
      agent_id: this.id,
      token: d.signal.token as ArenaToken,
      action: d.signal.action as ArenaAction,
      amount_usd: d.signal.action === 'HOLD' ? null : (d.finalAmountUsd ?? null),
      confidence: d.signal.confidence,
      reason: d.signal.rationale,
      timestamp: new Date().toISOString(),
      cycle_id: cycleId,
    }));
  }

  async onCycleResult(_signals: ArenaSignal[], _executed: VirtualTrade[]): Promise<void> {
    // Future: send learning feedback back to Python
  }
}
