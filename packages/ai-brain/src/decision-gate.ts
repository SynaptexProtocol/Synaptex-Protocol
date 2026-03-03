import type {
  SignalBatch, StrategySignal, MarketSnapshot, ApprovedDecision, AgentMemoryEntry,
} from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import type { ILlmProvider, LlmProviderConfig } from './provider-interface.js';
import { createProvider } from './provider-factory.js';

export interface DecisionGateConfig {
  approvalThresholdUsd: number;
  confidenceThreshold: number;
  provider: LlmProviderConfig;
  /** Optional fallback provider if primary fails */
  fallbackProvider?: LlmProviderConfig;
}

export class DecisionGate {
  private primary: ILlmProvider;
  private fallback?: ILlmProvider;

  constructor(private readonly config: DecisionGateConfig) {
    this.primary = createProvider(config.provider);
    if (config.fallbackProvider) {
      this.fallback = createProvider(config.fallbackProvider);
    }
    logger.info('DecisionGate initialized', {
      primary: `${config.provider.provider}/${config.provider.model}`,
      fallback: config.fallbackProvider
        ? `${config.fallbackProvider.provider}/${config.fallbackProvider.model}`
        : 'none',
    });
  }

  async processSignals(
    batch: SignalBatch,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<ApprovedDecision[]> {
    const decisions: ApprovedDecision[] = [];
    for (const signal of batch.signals) {
      const decision = await this.routeSignal(signal, snapshot, memory);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }

  private async routeSignal(
    signal: StrategySignal,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<ApprovedDecision | null> {
    const needsAi =
      signal.requiresAiApproval ||
      (signal.amountUsd ?? 0) > this.config.approvalThresholdUsd ||
      signal.confidence < this.config.confidenceThreshold;

    if (!needsAi) {
      logger.info('Auto-approved', {
        strategy: signal.strategyId, action: signal.action,
        token: signal.token, amount: signal.amountUsd,
      });
      return { signal, approvedBy: 'auto', finalAmountUsd: signal.amountUsd ?? 0 };
    }

    // Try primary, then fallback
    for (const llm of [this.primary, this.fallback].filter(Boolean) as ILlmProvider[]) {
      try {
        logger.info(`Sending to ${llm.provider}/${llm.model}`, {
          strategy: signal.strategyId, amount: signal.amountUsd,
        });
        const decision = await llm.evaluateSignal(signal, snapshot, memory);

        if (!decision.approved) {
          logger.info(`${llm.provider} rejected signal`, {
            token: signal.token, reason: decision.reasoning,
          });
          return null;
        }

        return {
          signal,
          approvedBy: 'ai',
          finalAmountUsd: decision.adjustedAmountUsd ?? signal.amountUsd ?? 0,
          aiDecision: decision,
        };
      } catch (err) {
        logger.error(`${llm.provider} evaluation failed`, { error: String(err) });
        if (llm === this.fallback) {
          logger.error('All providers failed — rejecting signal for safety');
          return null;
        }
        logger.warn('Trying fallback provider...');
      }
    }

    return null;
  }
}
