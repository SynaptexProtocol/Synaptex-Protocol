import type { ApprovedDecision } from './strategy.js';
import type { SwapReceipt } from './order.js';

export type SwapExecutorProvider = 'paper' | 'moonpay' | 'uniswap_v3' | 'zerox' | 'coinbase';

export interface ISwapExecutor {
  execute(decision: ApprovedDecision): Promise<SwapReceipt | null>;
}

export interface SwapExecutorConfig {
  provider: SwapExecutorProvider;
  isPaper?: boolean;
  tradesLogPath: string;
  options?: Record<string, unknown>;
}
