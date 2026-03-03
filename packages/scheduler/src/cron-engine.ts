import cron from 'node-cron';
import { randomUUID } from 'crypto';
import type { MarketSnapshot, SignalBatch, PortfolioState, ApprovedDecision } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { MarketPoller } from '@synaptex/market-data';
import { IpcClient } from '@synaptex/ipc-bridge';

export interface CronEngineConfig {
  tokens: string[];
  activeStrategies: string[];
  ipc: { host: string; port: number; timeoutMs: number };
  strategySchedules: Record<string, string>;  // strategyId -> cron expression
  onSignalBatch: (batch: SignalBatch, snapshot: MarketSnapshot) => Promise<ApprovedDecision[]>;
  onExecution: (decisions: ApprovedDecision[]) => Promise<string[]>;
  getPortfolio: () => Promise<PortfolioState>;
}

export class CronEngine {
  private poller: MarketPoller;
  private ipc: IpcClient;
  private jobs: cron.ScheduledTask[] = [];
  private running = false;
  private readonly scheduleToStrategies: Record<string, string[]>;

  constructor(private readonly config: CronEngineConfig) {
    this.poller = new MarketPoller(config.tokens);
    this.ipc = new IpcClient(config.ipc);
    this.scheduleToStrategies = this.buildScheduleMap(config.strategySchedules);
  }

  async start(): Promise<void> {
    logger.info('CronEngine starting, connecting IPC...');
    await this.ipc.connect();
    const health = await this.ipc.getHealth();
    logger.info('Python engine healthy', { strategies: health.strategies });

    // Run an immediate first cycle
    await this.runCycle();

    // Run cycles grouped by schedule; each cycle only includes strategies
    // mapped to the triggered cron expression.
    for (const [schedule, strategies] of Object.entries(this.scheduleToStrategies)) {
      const task = cron.schedule(schedule, async () => {
        await this.runCycle(strategies);
      });
      this.jobs.push(task);
    }

    this.running = true;
    logger.info('CronEngine running', { schedules: this.scheduleToStrategies });
  }

  async runCycle(strategies = this.config.activeStrategies): Promise<void> {
    const cycleId = randomUUID();
    const cycleStart = Date.now();

    try {
      // 1. Collect market data
      const tokenData = await this.poller.poll();
      const portfolio = await this.config.getPortfolio();

      const snapshot: MarketSnapshot = {
        timestamp: new Date().toISOString(),
        tokens: tokenData,
        portfolio,
        activeStrategies: strategies,
        cycleId,
      };

      // 2. Send to Python for signal generation
      const batch = await this.ipc.processSnapshot(snapshot);

      logger.info('Signals received', {
        cycleId,
        count: batch.signals.length,
        vetoed: batch.riskVetoed,
        ms: Date.now() - cycleStart,
      });

      if (batch.signals.length === 0) return;

      // 3. Route signals to decision gate (Claude or auto)
      const decisions = await this.config.onSignalBatch(batch, snapshot);

      // 4. Execute approved decisions
      if (decisions.length > 0) {
        const executedTokens = await this.config.onExecution(decisions);
        for (const token of new Set(executedTokens)) {
          try {
            await this.ipc.recordTrade(token);
          } catch (err) {
            logger.warn('Failed to sync executed trade token to Python risk manager', {
              token,
              error: String(err),
            });
          }
        }
      }
    } catch (err) {
      logger.error('Cycle error', { cycleId, error: String(err) });
    }
  }

  private buildScheduleMap(strategySchedules: Record<string, string>): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const [strategyId, schedule] of Object.entries(strategySchedules)) {
      if (!this.config.activeStrategies.includes(strategyId)) continue;
      if (!map[schedule]) map[schedule] = [];
      map[schedule].push(strategyId);
    }
    return map;
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    this.ipc.disconnect();
    this.running = false;
    logger.info('CronEngine stopped');
  }
}
