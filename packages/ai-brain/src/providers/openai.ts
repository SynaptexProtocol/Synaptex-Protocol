import OpenAI from 'openai';
import type { AiDecision, StrategySignal, MarketSnapshot, AgentMemoryEntry } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import type { ILlmProvider, LlmProviderConfig } from '../provider-interface.js';
import { SYSTEM_PROMPT, buildEvaluationPrompt, parseDecisionJson } from '../prompt-builder.js';

export class OpenAiAdapter implements ILlmProvider {
  readonly provider = 'openai' as const;
  readonly model: string;
  private client: OpenAI;
  private maxTokens: number;

  constructor(cfg: LlmProviderConfig) {
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens ?? 512;
    this.client = new OpenAI({
      apiKey: cfg.apiKey ?? process.env['OPENAI_API_KEY'],
      baseURL: cfg.baseUrl,  // optional: override for Azure or proxy
    });
  }

  async evaluateSignal(
    signal: StrategySignal,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<AiDecision> {
    const prompt = buildEvaluationPrompt(signal, snapshot, memory);
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    });

    const raw = response.choices[0]?.message.content ?? '';
    const parsed = parseDecisionJson(raw);

    if (!parsed) {
      logger.warn('[openai] Failed to parse response', { raw });
      return this.safeReject('Failed to parse OpenAI response');
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
