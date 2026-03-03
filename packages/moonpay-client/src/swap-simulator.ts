import type { SimulationResult, SwapRequest } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { MoonpayMcpClient } from './moonpay-mcp.js';

export class SwapSimulator {
  constructor(private readonly client: MoonpayMcpClient) {}

  /**
   * Always called BEFORE any swap execution.
   * Returns simulation result with validity check.
   */
  async simulate(req: SwapRequest): Promise<SimulationResult> {
    try {
      const quote = await this.client.quoteSwap({
        chain: req.chain,
        fromToken: req.fromToken,
        toToken: req.toToken,
        fromAmount: req.fromAmountUsd,
      });

      const priceImpactBps = quote.priceImpactBps;
      const valid = priceImpactBps <= req.maxSlippageBps;

      logger.info('Swap simulation', {
        from: req.fromToken,
        to: req.toToken,
        amount: req.fromAmountUsd,
        priceImpactBps,
        valid,
      });

      return {
        fromToken: req.fromToken,
        toToken: req.toToken,
        fromAmount: req.fromAmountUsd,
        expectedToAmount: parseFloat(quote.toAmount),
        priceImpactBps,
        estimatedGasUsd: quote.gasCostUsd,
        route: quote.route,
        valid,
        invalidReason: valid ? undefined : `Price impact ${priceImpactBps}bps > max ${req.maxSlippageBps}bps`,
      };
    } catch (err) {
      return {
        fromToken: req.fromToken,
        toToken: req.toToken,
        fromAmount: req.fromAmountUsd,
        expectedToAmount: 0,
        priceImpactBps: 9999,
        estimatedGasUsd: 0,
        route: 'unknown',
        valid: false,
        invalidReason: `Simulation failed: ${String(err)}`,
      };
    }
  }
}
