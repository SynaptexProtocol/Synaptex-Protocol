#!/usr/bin/env node
/**
 * BNB Chain AI Trading Agent - Main entry point.
 *
 * Wires together all packages:
 * - CronEngine (scheduler)
 * - DecisionGate (multi-provider AI brain)
 * - SwapExecutor (plugin: paper | moonpay | uniswap_v3 | zerox | coinbase)
 * - MemoryManager (agent memory)
 * - ArenaEngine (multi-agent competition)
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'yaml';
import { Command } from 'commander';
import { CronEngine } from '@synaptex/scheduler';
import { DecisionGate, MemoryManager } from '@synaptex/ai-brain';
import { createSwapExecutor } from '@synaptex/swap-executor';
import { IpcClient } from '@synaptex/ipc-bridge';
import { logger } from '@synaptex/core/utils/logger.js';
import { readJsonOrDefault } from '@synaptex/core/utils/file-state.js';
import type { PortfolioState, SignalBatch, MarketSnapshot, ApprovedDecision } from '@synaptex/core';
import { registerArenaCommands } from './commands/arena.js';

const program = new Command();

program
  .name('synaptex')
  .description('BNB Chain AI Autonomous Trading Agent')
  .version('1.0.0');

program
  .command('start')
  .description('Start the trading agent')
  .option('--config <path>', 'Path to agent.yaml', 'config/agent.yaml')
  .option('--mode <mode>', 'paper or live', undefined)
  .action(async (opts) => {
    const configPath = resolve(opts.config);
    const raw = readFileSync(configPath, 'utf-8');
    // Substitute env vars in YAML
    const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '');
    const config = yaml.parse(interpolated) as Record<string, any>;

    const mode = opts.mode ?? config.agent.mode ?? 'paper';
    const isPaper = mode !== 'live';
    logger.info(`Starting Base Trading Agent in ${mode.toUpperCase()} mode`);

    const projectRoot = resolve(configPath, '../..');
    const memoryPath = resolve(projectRoot, 'state/agent_memory.json');
    const tradesLogPath = resolve(projectRoot, 'logs/trades.log');

    const memory = new MemoryManager(memoryPath, config.ai?.rolling_memory_entries ?? 20);
    const executorProvider: string =
      config.executor?.provider ?? process.env['SWAP_EXECUTOR'] ?? 'paper';
    const executor = createSwapExecutor({
      provider: executorProvider as any,
      isPaper,
      tradesLogPath,
      options: config.executor?.options ?? {},
    });
    const gate = new DecisionGate({
      approvalThresholdUsd: config.ai?.approval_threshold_usd ?? 200,
      confidenceThreshold: config.ai?.confidence_threshold ?? 0.65,
      provider: config.ai?.provider ?? { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      fallbackProvider: config.ai?.fallback_provider,
    });

    // Build strategy schedule map
    const strategySchedules: Record<string, string> = {};
    const activeStrategies: string[] = [];
    for (const [id, meta] of Object.entries<any>(config.strategies ?? {})) {
      if (meta.enabled) {
        strategySchedules[id] = meta.schedule;
        activeStrategies.push(id);
      }
    }

    // Build token list from tokens.yaml
    const tokensPath = resolve(projectRoot, 'config/tokens.yaml');
    const tokensRaw = readFileSync(tokensPath, 'utf-8');
    const tokensConfig = yaml.parse(tokensRaw) as { tokens: Record<string, any> };
    const tokens = Object.keys(tokensConfig.tokens);

    const engine = new CronEngine({
      tokens,
      activeStrategies,
      ipc: {
        host: config.ipc?.host ?? '127.0.0.1',
        port: config.ipc?.port ?? 7890,
        timeoutMs: config.ipc?.timeout_ms ?? 5000,
      },
      strategySchedules,
      getPortfolio: async (): Promise<PortfolioState> => {
        return readJsonOrDefault<PortfolioState>(
          resolve(projectRoot, 'state/portfolio.json'),
          {
            walletAddress: '',
            nativeBalance: 0,
            stableBalance: 0,
            positions: [],
            totalValueUsd: 0,
            dailyPnlUsd: 0,
            timestamp: new Date().toISOString(),
          }
        );
      },
      onSignalBatch: async (batch: SignalBatch, snapshot: MarketSnapshot): Promise<ApprovedDecision[]> => {
        const recentMemory = memory.getRecent(10);
        return gate.processSignals(batch, snapshot, recentMemory);
      },
      onExecution: async (decisions: ApprovedDecision[]): Promise<string[]> => {
        const executedTokens: string[] = [];
        for (const decision of decisions) {
          const receipt = await executor.execute(decision);
          if (receipt) {
            executedTokens.push(decision.signal.token);
            memory.append({
              type: 'trade',
              summary: `${decision.signal.action} ${decision.signal.token} $${decision.finalAmountUsd.toFixed(2)} via ${decision.approvedBy} | tx:${receipt.txHash}`,
            });
          }
        }
        return executedTokens;
      },
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      logger.info('Shutting down...');
      engine.stop();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      engine.stop();
      process.exit(0);
    });

    await engine.start();
  });

program
  .command('status')
  .description('Show current agent status and portfolio')
  .option('--config <path>', 'Path to agent.yaml', 'config/agent.yaml')
  .action(async (opts) => {
    const projectRoot = resolve(opts.config, '../..');
    const portfolio = readJsonOrDefault<PortfolioState>(
      resolve(projectRoot, 'state/portfolio.json'),
      { walletAddress: '', nativeBalance: 0, stableBalance: 0, positions: [], totalValueUsd: 0, dailyPnlUsd: 0, timestamp: '' }
    );
    const signals = readJsonOrDefault<unknown[]>(resolve(projectRoot, 'state/signals.json'), []);

    console.log('\n=== Base Trading Agent Status ===');
    console.log(`Portfolio Total: $${portfolio.totalValueUsd.toFixed(2)}`);
    console.log(`ETH Balance:     ${portfolio.nativeBalance.toFixed(6)} ETH`);
    console.log(`USDC Balance:    $${portfolio.stableBalance.toFixed(2)}`);
    console.log(`Daily P&L:       $${portfolio.dailyPnlUsd.toFixed(2)}`);
    console.log(`Last Signals:    ${signals.length}`);
    console.log(`Updated:         ${portfolio.timestamp || 'never'}`);
    console.log('');

    // Try to reach Python engine
    const ipc = new IpcClient({ host: '127.0.0.1', port: 7890, timeoutMs: 2000 });
    try {
      await ipc.connect();
      const health = await ipc.getHealth();
      console.log(`Python Engine:   ${health.status.toUpperCase()}`);
      console.log(`Strategies:      ${health.strategies.join(', ')}`);
      ipc.disconnect();
    } catch {
      console.log('Python Engine:   OFFLINE');
    }
    console.log('');
  });

// Register arena subcommands
registerArenaCommands(program);

program.parse();
