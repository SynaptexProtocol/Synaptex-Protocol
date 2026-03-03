import type { ISwapExecutor, SwapExecutorConfig } from '@synaptex/core';
import { PaperSwapExecutor } from './executors/paper.js';
import { MoonpaySwapExecutor } from './executors/moonpay.js';
import { UniswapV3SwapExecutor } from './executors/uniswap-v3.js';
import { ZeroXSwapExecutor } from './executors/zerox.js';
import { CoinbaseSwapExecutor } from './executors/coinbase.js';

export function createSwapExecutor(config: SwapExecutorConfig): ISwapExecutor {
  if (config.isPaper) return new PaperSwapExecutor(config.tradesLogPath);
  switch (config.provider) {
    case 'uniswap_v3': return new UniswapV3SwapExecutor(config);
    case 'zerox':      return new ZeroXSwapExecutor(config);
    case 'coinbase':   return new CoinbaseSwapExecutor(config);
    case 'moonpay':    return new MoonpaySwapExecutor(config);
    default:           return new PaperSwapExecutor(config.tradesLogPath);
  }
}
