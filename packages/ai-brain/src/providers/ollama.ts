/**
 * Ollama adapter — runs local models (llama3, mistral, qwen, etc.)
 * Ollama exposes an OpenAI-compatible REST API at localhost:11434.
 */
import OpenAI from 'openai';
import type { AiDecision, StrategySignal, MarketSnapshot, AgentMemoryEntry } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import type { ILlmProvider, LlmProviderConfig } from '../provider-interface.js';
import { SYSTEM_PROMPT, buildEvaluationPrompt, parseDecisionJson } from '../prompt-builder.js';

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export class OllamaAdapter implements ILlmProvider {
  readonly provider = 'ollama' as const;
  readonly model: string;
  private client: OpenAI;
  private maxTokens: number;

  constructor(cfg: LlmProviderConfig) {
    this.model = cfg.model;  // e.g. "llama3.2", "qwen2.5", "mistral"
    this.maxTokens = cfg.maxTokens ?? 512;
    // Ollama doesn't require an API key but OpenAI SDK needs a placeholder
    this.client = new OpenAI({
      apiKey: 'ollama',
      baseURL: cfg.baseUrl ?? OLLAMA_BASE_URL,
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
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    });

    const raw = response.choices[0]?.message.content ?? '';
    const parsed = parseDecisionJson(raw);

    if (!parsed) {
      logger.warn('[ollama] Failed to parse response', { model: this.model, raw });
      return this.safeReject(`Failed to parse Ollama (${this.model}) response`);
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
