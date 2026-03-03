import type { LlmProvider } from '@synaptex/core';
import type { ILlmProvider, LlmProviderConfig } from './provider-interface.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { OpenAiAdapter } from './providers/openai.js';
import { GeminiAdapter } from './providers/gemini.js';
import { DeepSeekAdapter } from './providers/deepseek.js';
import { OllamaAdapter } from './providers/ollama.js';

export function createProvider(cfg: LlmProviderConfig): ILlmProvider {
  switch (cfg.provider) {
    case 'anthropic': return new AnthropicAdapter(cfg);
    case 'openai':    return new OpenAiAdapter(cfg);
    case 'gemini':    return new GeminiAdapter(cfg);
    case 'deepseek':  return new DeepSeekAdapter(cfg);
    case 'ollama':    return new OllamaAdapter(cfg);
    default: {
      const p: never = cfg.provider;
      throw new Error(`Unknown LLM provider: ${p}`);
    }
  }
}
