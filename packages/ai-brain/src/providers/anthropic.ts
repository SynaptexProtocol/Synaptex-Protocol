import Anthropic from '@anthropic-ai/sdk';
import type { AiDecision, StrategySignal, MarketSnapshot, AgentMemoryEntry } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import type { ILlmProvider, LlmProviderConfig } from '../provider-interface.js';
import { SYSTEM_PROMPT, buildEvaluationPrompt, parseDecisionJson } from '../prompt-builder.js';

export class AnthropicAdapter implements ILlmProvider {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(cfg: LlmProviderConfig) {
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens ?? 512;
    this.client = new Anthropic({
      apiKey: cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });
  }

  async evaluateSignal(
    signal: StrategySignal,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<AiDecision> {
    const prompt = buildEvaluationPrompt(signal, snapshot, memory);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const parsed = parseDecisionJson(raw);

    if (!parsed) {
      logger.warn('[anthropic] Failed to parse response', { raw });
      return this.safeReject('Failed to parse Anthropic response');
    }

    return {
      approved: parsed.approved,
      adjustedAmountUsd: parsed.adjustedAmountUsd ?? undefined,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      timestamp: new Date().toISOString(),
      provider: this.provider,
      model: this.model,
    };
  }

  private safeReject(reason: string): AiDecision {
    return { approved: false, reasoning: reason, confidence: 0, timestamp: new Date().toISOString(), provider: this.provider, model: this.model };
  }
}
