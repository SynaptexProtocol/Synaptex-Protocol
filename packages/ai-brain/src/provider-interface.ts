import type { LlmProvider, AiDecision, StrategySignal, MarketSnapshot, AgentMemoryEntry } from '@synaptex/core';

/**
 * Unified LLM provider interface.
 * Every provider adapter must implement this.
 */
export interface ILlmProvider {
  readonly provider: LlmProvider;
  readonly model: string;

  /**
   * Evaluate a trading signal and return a structured decision.
   * All providers must return the same AiDecision shape.
   */
  evaluateSignal(
    signal: StrategySignal,
    snapshot: MarketSnapshot,
    memory: AgentMemoryEntry[],
  ): Promise<AiDecision>;
}

/** Config shape for a single provider in agent.yaml */
export interface LlmProviderConfig {
  provider: LlmProvider;
  model: string;
  apiKey?: string;    // falls back to env var if omitted
  baseUrl?: string;   // for Ollama or custom OpenAI-compatible endpoints
  maxTokens?: number;
  temperature?: number;
}
