import type { SwapRequest, SimulationResult, SwapReceipt, Trade, ApprovedDecision } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { appendJsonLine } from '@synaptex/core/utils/file-state.js';
import { randomUUID } from 'crypto';
import { MoonpayMcpClient } from './moonpay-mcp.js';
import { SwapSimulator } from './swap-simulator.js';

export class SwapExecutor {
  private simulator: SwapSimulator;

  constructor(
    private readonly client: MoonpayMcpClient,
    private readonly isPaper: boolean,
    private readonly tradesLogPath: string,
  ) {
    this.simulator = new SwapSimulator(client);
  }

  /**
   * Full simulate-then-execute flow.
   * Simulation ALWAYS runs first; execution only happens if simulation passes.
   */
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
      maxSlippageBps: 100,
    };

    // Step 1: Simulate (mandatory — skipped in paper mode, always passes)
    const sim = this.isPaper
      ? { valid: true, expectedToAmount: decision.finalAmountUsd, estimatedGasUsd: 0, invalidReason: undefined }
      : await this.simulator.simulate(req);
    if (!sim.valid) {
      logger.warn('Swap simulation failed, aborting', { reason: sim.invalidReason });
      return null;
    }

    // Step 2: Paper mode — log only, no real execution
    if (this.isPaper) {
      const receipt: SwapReceipt = {
        txHash: `paper-${randomUUID()}`,
        fromToken: req.fromToken,
        toToken: req.toToken,
        fromAmount: req.fromAmountUsd,
        toAmount: sim.expectedToAmount,
        gasPaidUsd: 0,
        timestamp: new Date().toISOString(),
        chain: 'base',
      };
      this.logTrade(signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt);
      logger.info('[PAPER] Swap executed', { receipt });
      return receipt;
    }

    // Step 3: Live execution via MoonPay MCP
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

    this.logTrade(signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt);
    logger.info('Swap executed', { txHash: receipt.txHash });
    return receipt;
  }

  private logTrade(
    strategyId: string,
    action: 'BUY' | 'SELL',
    token: string,
    decision: ApprovedDecision,
    receipt: SwapReceipt,
  ): void {
    const trade: Trade = {
      id: randomUUID(),
      strategyId,
      action,
      token,
      amountUsd: decision.finalAmountUsd,
      priceUsd: receipt.toAmount / receipt.fromAmount,
      txHash: receipt.txHash,
      chain: 'base',
      approvedBy: decision.approvedBy,
      timestamp: receipt.timestamp,
      isPaper: this.isPaper,
    };
    appendJsonLine(this.tradesLogPath, trade);
  }
}
