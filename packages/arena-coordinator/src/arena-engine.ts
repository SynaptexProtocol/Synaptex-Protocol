import { writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import type { MarketSnapshot, PortfolioState } from '@synaptex/core';
import { MarketPoller } from '@synaptex/market-data';
import type { IArenaAgent } from './interfaces/i-arena-agent.js';
import type { IArenaHook } from './interfaces/i-arena-hook.js';
import type { ISettlementAlgorithm } from './interfaces/i-settlement.js';
import type { ArenaSignal } from './types/arena-signal.js';
import { signalToLeaf, buildMerkleRoot } from './types/arena-signal.js';
import { VirtualPortfolioManager } from './virtual-portfolio.js';
import type { VirtualTrade } from './virtual-portfolio.js';
import { SeasonManager } from './season-manager.js';
import type { SeasonPreset } from './types/season.js';
import { buildLeaderboard } from './leaderboard.js';
import type { LeaderboardEntry } from './leaderboard.js';
import { isValidAgent } from './leaderboard.js';
import type { AgentSeasonResult } from './interfaces/i-settlement.js';
import { SoftmaxSettlement } from './settlement/softmax.js';
import type { SeasonSettlementPayload } from './types/season-settlement.js';

export interface ArenaEngineConfig {
  startingVirtualUsd: number;
  cycleIntervalMinutes: number;
  /**
   * Season duration in minutes — canonical field.
   * Use SeasonManager.minutesFromPreset() to convert from preset name.
   */
  seasonDurationMinutes: number;
  /** Optional preset label for display ('micro' | 'hourly' | 'daily' | 'weekly' | 'custom') */
  seasonPreset?: SeasonPreset;
  minAgentsToStart: number;
  minSignalsToQualify: number;
  minTradesToQualify: number;
  webhookTimeoutSeconds: number;
  settlement: {
    algorithm: string;
    temperature: number;
  };
  stateDir: string;
  getSnapshot?: () => Promise<MarketSnapshot>;
  marketSymbols?: string[];
}

interface AgentState {
  agent: IArenaAgent;
  portfolio: VirtualPortfolioManager;
  signals: ArenaSignal[];
  failureCount: number;
}

function isDisqualifiedAgent(agent: IArenaAgent): boolean {
  const maybe = agent as IArenaAgent & { isDisqualified?: () => boolean };
  return typeof maybe.isDisqualified === 'function' && maybe.isDisqualified();
}

export class ArenaEngine {
  private agents = new Map<string, AgentState>();
  private seasonManager: SeasonManager;
  private settlement: ISettlementAlgorithm;
  private hooks: IArenaHook[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private poller: MarketPoller | null = null;

  constructor(private readonly config: ArenaEngineConfig) {
    mkdirSync(join(config.stateDir, 'seasons'), { recursive: true });
    this.seasonManager = new SeasonManager(config.stateDir);
    this.settlement = new SoftmaxSettlement();
    if (!config.getSnapshot) {
      this.poller = new MarketPoller(config.marketSymbols ?? ['ETH', 'cbBTC', 'USDC']);
    }
  }

  // 鈹€鈹€ Agent registration 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  registerAgent(agent: IArenaAgent): void {
    const season = this.seasonManager.getCurrent();
    const seasonId = season?.id ?? 'no-season';
    const portfolio = new VirtualPortfolioManager(
      agent.id,
      seasonId,
      this.config.startingVirtualUsd,
    );
    this.agents.set(agent.id, { agent, portfolio, signals: [], failureCount: 0 });
  }

  addHook(hook: IArenaHook): void {
    this.hooks.push(hook);
  }

  // 鈹€鈹€ Lifecycle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  start(): void {
    if (this.running) return;

    // Start a new season if none is active
    if (!this.seasonManager.isActive()) {
      const agentIds = [...this.agents.keys()];
      if (agentIds.length < this.config.minAgentsToStart) {
        console.warn(`[Arena] Not enough agents (${agentIds.length} < ${this.config.minAgentsToStart}), not starting`);
        return;
      }
      const season = this.seasonManager.startNewSeason(
        this.config.seasonDurationMinutes,
        agentIds,
        this.config.settlement.algorithm,
        this.config.seasonPreset,
      );
      this.fireHook(h => h.onSeasonStart?.(season));
      console.log(`[Arena] Season ${season.id} started, ends ${season.end_time}`);
    }

    this.running = true;
    const intervalMs = this.config.cycleIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => { void this.runCycle(); }, intervalMs);
    void this.runCycle();
    console.log(`[Arena] Engine started, cycle every ${this.config.cycleIntervalMinutes}m`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }

  // 鈹€鈹€ Main cycle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  /**
   * Inject a pre-polled market snapshot from outside (used by scheduler).
   * The caller is responsible for polling once and passing it here.
   */
  async runCycleWithSnapshot(snapshot: MarketSnapshot): Promise<void> {
    if (!this.seasonManager.isActive()) {
      // Check if expired
      if (this.seasonManager.isExpired()) {
        await this.settle();
      }
      return;
    }

    if (this.seasonManager.isExpired()) {
      await this.settle();
      return;
    }

    const cycleId = snapshot.cycleId || randomUUID();
    const currentPrices = this.extractPrices(snapshot);

    // Parallel: send snapshot to all agents
    const results = await Promise.allSettled(
      [...this.agents.entries()].map(([id, state]) =>
        this.runAgentCycle(id, state, snapshot, currentPrices),
      ),
    );

    // Count totals and persist cycle-level commitments
    let totalSignals = 0;
    let totalTrades = 0;
    const cycleSignals: ArenaSignal[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        totalSignals += r.value.signals;
        totalTrades += r.value.trades;
        cycleSignals.push(...r.value.cycleSignals);
      }
    }
    const seasonId = this.seasonManager.getCurrent()?.id ?? 'unknown';
    const cycleRoot = this.saveCycleCommitment(seasonId, cycleId, cycleSignals);

    // Update leaderboard
    this.saveLeaderboard();
    this.seasonManager.incrementCycle();

    // Fire hooks
    this.fireHook(h => h.onCycleComplete?.({
      seasonId,
      cycleId,
      cycleRoot,
      timestamp: new Date().toISOString(),
      signalCount: totalSignals,
      tradeCount: totalTrades,
    }));

    this.saveStateFiles();
  }

  // Alias: when arena manages its own market polling (future)
  private async runCycle(): Promise<void> {
    try {
      const snapshot = await this.getSnapshot();
      await this.runCycleWithSnapshot(snapshot);
    } catch (err) {
      console.error('[Arena] runCycle error:', err);
    }
  }

  private async runAgentCycle(
    agentId: string,
    state: AgentState,
    snapshot: MarketSnapshot,
    currentPrices: Record<string, number>,
  ): Promise<{ signals: number; trades: number; cycleSignals: ArenaSignal[] }> {
    try {
      const portfolio = state.portfolio.getPortfolio();
      const portfolioBefore = { ...portfolio };
      const signals = await state.agent.decide(snapshot, portfolio);

      const executed: VirtualTrade[] = [];
      for (const sig of signals) {
        state.signals.push(sig);
        const trade = state.portfolio.applySignal(sig, currentPrices);
        if (trade) executed.push(trade);
      }

      state.portfolio.updatePrices(currentPrices);

      if (state.agent.onCycleResult && executed.length > 0) {
        await state.agent.onCycleResult(signals, executed).catch(() => {});
      }

      this.saveDecisionReplayRow({
        seasonId: portfolioBefore.season_id,
        cycleId: snapshot.cycleId,
        agentId,
        agentType: state.agent.type,
        snapshotHash: this.hashJson(snapshot),
        portfolioBeforeHash: this.hashJson(portfolioBefore),
        portfolioAfterHash: this.hashJson(state.portfolio.getPortfolio()),
        signalsHash: this.hashJson(signals),
        signalCount: signals.length,
        tradeCount: executed.length,
        decisionMeta: state.agent.getLastDecisionMeta?.() ?? null,
      });

      return { signals: signals.length, trades: executed.length, cycleSignals: signals };
    } catch (err) {
      state.failureCount++;
      this.saveDecisionReplayRow({
        seasonId: this.seasonManager.getCurrent()?.id ?? 'unknown',
        cycleId: snapshot.cycleId,
        agentId,
        agentType: state.agent.type,
        snapshotHash: this.hashJson(snapshot),
        portfolioBeforeHash: this.hashJson(state.portfolio.getPortfolio()),
        portfolioAfterHash: this.hashJson(state.portfolio.getPortfolio()),
        signalsHash: this.hashJson([]),
        signalCount: 0,
        tradeCount: 0,
        error: err instanceof Error ? err.message : String(err),
        decisionMeta: state.agent.getLastDecisionMeta?.() ?? null,
      });
      await this.fireHookSafe(h => h.onAgentError?.(agentId, err instanceof Error ? err : new Error(String(err))));
      return { signals: 0, trades: 0, cycleSignals: [] };
    }
  }

  // 鈹€鈹€ Settlement 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  async settle(): Promise<LeaderboardEntry[]> {
    const season = this.seasonManager.getCurrent();
    if (!season) throw new Error('No season to settle');

    this.seasonManager.transitionTo('settling');

    const results: AgentSeasonResult[] = [];
    for (const [agentId, state] of this.agents.entries()) {
      const tradeCount = state.portfolio.getTrades().length;
      const signalCount = state.signals.length;
      const roi = state.portfolio.getPortfolio().roi;
      const disqualified = isDisqualifiedAgent(state.agent);
      const valid = !disqualified && signalCount >= this.config.minSignalsToQualify
        && tradeCount >= this.config.minTradesToQualify;

      results.push({
        agent_id: agentId,
        agent_name: state.agent.name,
        roi,
        signal_count: signalCount,
        trade_count: tradeCount,
        status: disqualified ? 'disqualified' : (valid ? 'valid' : 'invalid'),
      });
    }

    const validResults = results.filter(isValidAgent);
    const weights = validResults.length > 0
      ? this.settlement.calculate_weights(validResults, { temperature: this.config.settlement.temperature })
      : {};

    // All weights default to 0 (invalid agents get full refund 鈥?handled by smart contract)
    const allWeights: Record<string, number> = {};
    for (const r of results) {
      allWeights[r.agent_id] = weights[r.agent_id] ?? 0;
    }

    const portfolioValues: Record<string, number> = {};
    for (const [id, state] of this.agents.entries()) {
      portfolioValues[id] = state.portfolio.getPortfolio().total_value_usd;
    }

    const leaderboard = buildLeaderboard(season.id, results, allWeights, portfolioValues);

    // Build Merkle root from all signals
    const allLeaves = [...this.agents.values()]
      .flatMap(s => s.signals)
      .map(signalToLeaf);
    const merkleRoot = buildMerkleRoot(allLeaves);

    this.seasonManager.transitionTo('settled', {
      leaderboard_hash: leaderboard.leaderboard_hash,
    });

    // Save final state
    writeFileSync(
      join(this.config.stateDir, 'leaderboard.json'),
      JSON.stringify({ ...leaderboard, merkle_root: merkleRoot }, null, 2),
    );

    const settlementPayload: SeasonSettlementPayload = {
      season_id: season.id,
      leaderboard_hash: leaderboard.leaderboard_hash,
      merkle_root: merkleRoot,
      weights: allWeights,
      leaderboard: leaderboard.entries,
      reputation_deltas: this.computeReputationDeltas(results, allWeights),
    };

    this.fireHook(h => h.onSeasonEnd?.(
      this.seasonManager.getCurrent()!,
      leaderboard.entries,
      settlementPayload,
    ));

    console.log(`[Arena] Season ${season.id} settled. Valid agents: ${validResults.length}/${results.length}`);
    console.log(`[Arena] Merkle root: ${merkleRoot}`);

    return leaderboard.entries;
  }

  // 鈹€鈹€ Queries 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  getLeaderboard(): LeaderboardEntry[] | null {
    const entries: LeaderboardEntry[] = [];
    for (const [agentId, state] of this.agents.entries()) {
      const p = state.portfolio.getPortfolio();
      const signalCount = state.signals.length;
      const tradeCount = state.portfolio.getTrades().length;
      const disqualified = isDisqualifiedAgent(state.agent);
      const isValid = signalCount >= this.config.minSignalsToQualify
        && tradeCount >= this.config.minTradesToQualify
        && !disqualified;
      entries.push({
        rank: 0,
        agent_id: agentId,
        agent_name: state.agent.name,
        roi: p.roi,
        total_value_usd: p.total_value_usd,
        signal_count: signalCount,
        trade_count: tradeCount,
        is_valid: isValid,
        settlement_weight: 0,
      });
    }
    return entries.sort((a, b) => b.roi - a.roi).map((e, i) => ({ ...e, rank: i + 1 }));
  }

  getAgentPortfolio(agentId: string) {
    return this.agents.get(agentId)?.portfolio.getPortfolio() ?? null;
  }

  getAgentTrades(agentId: string) {
    return this.agents.get(agentId)?.portfolio.getTrades() ?? [];
  }

  getAgentSignals(agentId: string) {
    return this.agents.get(agentId)?.signals ?? [];
  }

  getSeason() {
    return this.seasonManager.getCurrent();
  }

  /**
   * Returns enriched agent registry data combining live portfolio stats with
   * agent metadata (type, owner, strategy tags).
   */
  getAgentRegistry() {
    const leaderboard = this.getLeaderboard() ?? [];
    return leaderboard.map((entry) => {
      const state = this.agents.get(entry.agent_id);
      return {
        ...entry,
        agent_type: state?.agent.type ?? 'internal',
        owner: state?.agent.owner ?? '',
        strategy_tags: state?.agent.strategyTags ?? [],
      };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private extractPrices(snapshot: MarketSnapshot): Record<string, number> {
    const prices: Record<string, number> = {};
    for (const [symbol, data] of Object.entries(snapshot.tokens)) {
      prices[symbol] = data.price;
    }
    return prices;
  }

  private async getSnapshot(): Promise<MarketSnapshot> {
    if (this.config.getSnapshot) return this.config.getSnapshot();
    if (!this.poller) {
      throw new Error('ArenaEngine snapshot source is not configured');
    }

    const tokenData = await this.poller.poll();
    const emptyPortfolio: PortfolioState = {
      walletAddress: 'arena',
      nativeBalance: 0,
      stableBalance: 0,
      positions: [],
      totalValueUsd: 0,
      dailyPnlUsd: 0,
      timestamp: new Date().toISOString(),
    };

    return {
      timestamp: new Date().toISOString(),
      cycleId: randomUUID(),
      tokens: tokenData,
      activeStrategies: [],
      portfolio: emptyPortfolio,
    };
  }

  private saveCycleCommitment(seasonId: string, cycleId: string, signals: ArenaSignal[]): string {
    const leaves = signals.map(signalToLeaf);
    const cycleRoot = buildMerkleRoot(leaves);
    const row = {
      season_id: seasonId,
      cycle_id: cycleId,
      timestamp: new Date().toISOString(),
      signal_count: signals.length,
      cycle_root: cycleRoot,
    };
    appendFileSync(
      join(this.config.stateDir, 'cycle_commitments.jsonl'),
      `${JSON.stringify(row)}\n`,
      'utf-8',
    );
    return cycleRoot;
  }

  private hashJson(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private saveDecisionReplayRow(row: {
    seasonId: string;
    cycleId: string;
    agentId: string;
    agentType: 'internal' | 'webhook' | 'stdio' | 'sdk';
    snapshotHash: string;
    portfolioBeforeHash: string;
    portfolioAfterHash: string;
    signalsHash: string;
    signalCount: number;
    tradeCount: number;
    error?: string;
    decisionMeta?: {
      schemaVersion?: string;
      traceId?: string;
      idempotencyKey?: string;
      requestHash?: string;
      responseHash?: string;
      latencyMs?: number;
    } | null;
  }): void {
    const replayRow = {
      timestamp: new Date().toISOString(),
      season_id: row.seasonId,
      cycle_id: row.cycleId,
      agent_id: row.agentId,
      agent_type: row.agentType,
      snapshot_hash: row.snapshotHash,
      portfolio_before_hash: row.portfolioBeforeHash,
      portfolio_after_hash: row.portfolioAfterHash,
      signals_hash: row.signalsHash,
      signal_count: row.signalCount,
      trade_count: row.tradeCount,
      schema_version: row.decisionMeta?.schemaVersion,
      trace_id: row.decisionMeta?.traceId,
      idempotency_key: row.decisionMeta?.idempotencyKey,
      request_hash: row.decisionMeta?.requestHash,
      response_hash: row.decisionMeta?.responseHash,
      latency_ms: row.decisionMeta?.latencyMs,
      error: row.error,
    };
    appendFileSync(
      join(this.config.stateDir, 'agent_decision_replay.jsonl'),
      `${JSON.stringify(replayRow)}\n`,
      'utf-8',
    );
  }

  private saveLeaderboard(): void {
    const entries = this.getLeaderboard() ?? [];
    writeFileSync(
      join(this.config.stateDir, 'leaderboard.json'),
      JSON.stringify({ updated_at: new Date().toISOString(), entries }, null, 2),
    );
  }

  private saveStateFiles(): void {
    for (const [agentId, state] of this.agents.entries()) {
      writeFileSync(
        join(this.config.stateDir, `agent-${agentId}.json`),
        JSON.stringify(state.portfolio.toJSON(), null, 2),
      );
    }
  }

  private computeReputationDeltas(
    results: AgentSeasonResult[],
    weights: Record<string, number>,
  ): Record<string, number> {
    // Base participation score: 1e15 WAD (0.001 ARENA unit) per season participated
    const BASE_WAD = 1e15;
    // Performance bonus: weight × 1e18 WAD (top agent gets up to 1 ARENA unit extra)
    const WEIGHT_MULTIPLIER = 1e18;
    const deltas: Record<string, number> = {};
    for (const r of results) {
      const participationBonus = BASE_WAD;
      const performanceBonus = (weights[r.agent_id] ?? 0) * WEIGHT_MULTIPLIER;
      deltas[r.agent_id] = Math.floor(participationBonus + performanceBonus);
    }
    return deltas;
  }

  private fireHook(fn: (h: IArenaHook) => Promise<void> | undefined): void {
    for (const h of this.hooks) {
      Promise.resolve(fn(h)).catch(err =>
        console.error('[Arena] Hook error:', err),
      );
    }
  }

  private async fireHookSafe(fn: (h: IArenaHook) => Promise<void> | undefined): Promise<void> {
    for (const h of this.hooks) {
      await Promise.resolve(fn(h)).catch(() => {});
    }
  }
}



