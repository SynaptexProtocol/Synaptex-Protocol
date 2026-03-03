import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiDecision, StrategySignal, MarketSnapshot, AgentMemoryEntry } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import type { ILlmProvider, LlmProviderConfig } from '../provider-interface.js';
import { SYSTEM_PROMPT, buildEvaluationPrompt, parseDecisionJson } from '../prompt-builder.js';

export class GeminiAdapter implements ILlmProvider {
  readonly provider = 'gemini' as const;
  readonly model: string;
  private client: GoogleGenerativeAI;
  private maxTokens: number;

  constructor(cfg: LlmProviderConfig) {
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens ?? 512;
    this.client = new GoogleGenerativeAI(cfg.apiKey ?? process.env['GEMINI_API_KEY'] ?? '');
  }

  async evaluateSignal(
    signal: StrategySignal,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<AiDecision> {
    const genModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: { maxOutputTokens: this.maxTokens },
    });

    const prompt = buildEvaluationPrompt(signal, snapshot, memory);
    const result = await genModel.generateContent(prompt);
    const raw = result.response.text();
    const parsed = parseDecisionJson(raw);

    if (!parsed) {
      logger.warn('[gemini] Failed to parse response', { raw });
      return this.safeReject('Failed to parse Gemini response');
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
