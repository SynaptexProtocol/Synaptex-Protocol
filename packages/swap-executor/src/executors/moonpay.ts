import type { ApprovedDecision, SwapReceipt, SwapRequest, ISwapExecutor, SwapExecutorConfig } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { MoonpayMcpClient, SwapSimulator } from '@synaptex/moonpay-client';
import { logTrade } from '../utils/trade-logger.js';

export class MoonpaySwapExecutor implements ISwapExecutor {
  private readonly client: MoonpayMcpClient;
  private readonly simulator: SwapSimulator;

  constructor(private readonly config: SwapExecutorConfig) {
    this.client = new MoonpayMcpClient(process.env['WALLET_NAME'] ?? 'main');
    this.simulator = new SwapSimulator(this.client);
  }

  async execute(decision: ApprovedDecision): Promise<SwapReceipt | null> {
    const { signal } = decision;
    if (!signal.amountUsd) {
      logger.warn('No amountUsd on signal, skipping', { strategyId: signal.strategyId });
      return null;
    }

    const req: SwapRequest = {
      walletName: process.env['WALLET_NAME'] ?? 'main',
      chain: 'base',
      fromToken: signal.action === 'BUY' ? 'USDC' : signal.token,
      toToken: signal.action === 'BUY' ? signal.token : 'USDC',
      fromAmountUsd: decision.finalAmountUsd,
      maxSlippageBps: (this.config.options?.['slippageBps'] as number | undefined) ?? 100,
    };

    const sim = await this.simulator.simulate(req);
    if (!sim.valid) {
      logger.warn('Swap simulation failed, aborting', { reason: sim.invalidReason });
      return null;
    }

    const result = await this.client.executeSwap({
      chain: req.chain,
      fromToken: req.fromToken,
      toToken: req.toToken,
      fromAmount: req.fromAmountUsd,
      maxSlippageBps: req.maxSlippageBps,
    });

    const receipt: SwapReceipt = {
      txHash: result.txHash,
      fromToken: req.fromToken,
      toToken: req.toToken,
      fromAmount: parseFloat(result.fromAmount),
      toAmount: parseFloat(result.toAmount),
      gasPaidUsd: sim.estimatedGasUsd,
      timestamp: new Date().toISOString(),
      chain: 'base',
    };

    logTrade(this.config.tradesLogPath, signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt, false);
    logger.info('[MOONPAY] Swap executed', { txHash: receipt.txHash });
    return receipt;
  }
}
