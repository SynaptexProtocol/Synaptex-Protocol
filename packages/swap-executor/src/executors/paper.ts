import type { ApprovedDecision, SwapReceipt, ISwapExecutor } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { randomUUID } from 'crypto';
import { logTrade } from '../utils/trade-logger.js';

export class PaperSwapExecutor implements ISwapExecutor {
  constructor(private readonly tradesLogPath: string) {}

  async execute(decision: ApprovedDecision): Promise<SwapReceipt | null> {
    const { signal } = decision;
    if (!signal.amountUsd) {
      logger.warn('No amountUsd on signal, skipping', { strategyId: signal.strategyId });
      return null;
    }

    const fromToken = signal.action === 'BUY' ? 'USDC' : signal.token;
    const toToken = signal.action === 'BUY' ? signal.token : 'USDC';

    const receipt: SwapReceipt = {
      txHash: `paper-${randomUUID()}`,
      fromToken,
      toToken,
      fromAmount: decision.finalAmountUsd,
      toAmount: decision.finalAmountUsd,
      gasPaidUsd: 0,
      timestamp: new Date().toISOString(),
      chain: 'base',
    };

    logTrade(this.tradesLogPath, signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt, true);
    logger.info('[PAPER] Swap executed', { receipt });
    return receipt;
  }
}
