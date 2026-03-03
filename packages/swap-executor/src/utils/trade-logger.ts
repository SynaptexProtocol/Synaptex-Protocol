import type { Trade, SwapReceipt, ApprovedDecision } from '@synaptex/core';
import { appendJsonLine } from '@synaptex/core/utils/file-state.js';
import { randomUUID } from 'crypto';

export function logTrade(
  tradesLogPath: string,
  strategyId: string,
  action: 'BUY' | 'SELL',
  token: string,
  decision: ApprovedDecision,
  receipt: SwapReceipt,
  isPaper: boolean,
): void {
  const trade: Trade = {
    id: randomUUID(),
    strategyId,
    action,
    token,
    amountUsd: decision.finalAmountUsd,
    priceUsd: receipt.fromAmount > 0 ? receipt.toAmount / receipt.fromAmount : 0,
    txHash: receipt.txHash,
    chain: 'base',
    approvedBy: decision.approvedBy,
    timestamp: receipt.timestamp,
    isPaper,
  };
  appendJsonLine(tradesLogPath, trade);
}
