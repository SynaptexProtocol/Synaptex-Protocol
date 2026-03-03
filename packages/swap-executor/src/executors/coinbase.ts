import type { ApprovedDecision, SwapReceipt, ISwapExecutor, SwapExecutorConfig } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { createHmac } from 'crypto';
import { logTrade } from '../utils/trade-logger.js';

const COINBASE_API_BASE = 'https://api.coinbase.com/api/v3/brokerage';

const PRODUCT_IDS: Record<string, string> = {
  ETH: 'ETH-USDC',
  cbBTC: 'CBBTC-USDC',
};

export class CoinbaseSwapExecutor implements ISwapExecutor {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseSizeDecimals: number;

  constructor(private readonly config: SwapExecutorConfig) {
    this.apiKey = (config.options?.['apiKey'] as string | undefined)
      || process.env['COINBASE_API_KEY']
      || '';
    this.apiSecret = (config.options?.['apiSecret'] as string | undefined)
      || process.env['COINBASE_API_SECRET']
      || '';
    this.baseSizeDecimals = (config.options?.['baseSizeDecimals'] as number | undefined) ?? 8;

    if (!this.apiKey) throw new Error('CoinbaseSwapExecutor: apiKey is required (set COINBASE_API_KEY or config.options.apiKey)');
    if (!this.apiSecret) throw new Error('CoinbaseSwapExecutor: apiSecret is required (set COINBASE_API_SECRET or config.options.apiSecret)');
  }

  async execute(decision: ApprovedDecision): Promise<SwapReceipt | null> {
    const { signal } = decision;
    if (!signal.amountUsd) {
      logger.warn('No amountUsd on signal, skipping', { strategyId: signal.strategyId });
      return null;
    }

    const productId = PRODUCT_IDS[signal.token];
    if (!productId) throw new Error(`CoinbaseSwapExecutor: no product ID for token ${signal.token}`);

    const isBuy = signal.action === 'BUY';
    const side = isBuy ? 'BUY' : 'SELL';
    const marketCfg = isBuy
      ? { quote_size: decision.finalAmountUsd.toFixed(2) }
      : { base_size: (await this.estimateSellBaseSize(productId, decision.finalAmountUsd)).toFixed(this.baseSizeDecimals) };

    const body = JSON.stringify({
      client_order_id: `arena-${Date.now()}`,
      product_id: productId,
      side,
      order_configuration: {
        market_market_ioc: {
          // BUY uses quote_size in USDC; SELL must use base_size in token units.
          ...marketCfg,
        },
      },
    });

    const response = await this.signedPost('/orders', body);

    const sr = response['success_response'] as Record<string, string> | undefined;
    const orderId = (sr?.['order_id'] ?? response['order_id'] ?? 'unknown') as string;
    const filledSize = parseFloat(sr?.['filled_size'] ?? '0');
    const filledValue = parseFloat(sr?.['filled_value'] ?? String(decision.finalAmountUsd));

    const fromToken = isBuy ? 'USDC' : signal.token;
    const toToken = isBuy ? signal.token : 'USDC';

    const receipt: SwapReceipt = {
      txHash: orderId,
      fromToken,
      toToken,
      fromAmount: decision.finalAmountUsd,
      toAmount: isBuy ? filledSize : filledValue,
      gasPaidUsd: 0,
      timestamp: new Date().toISOString(),
      chain: 'base',
    };

    logTrade(this.config.tradesLogPath, signal.strategyId, signal.action as 'BUY' | 'SELL', signal.token, decision, receipt, false);
    logger.info('[COINBASE] Order placed', { orderId, side, productId });
    return receipt;
  }

  private async estimateSellBaseSize(productId: string, targetUsd: number): Promise<number> {
    if (!Number.isFinite(targetUsd) || targetUsd <= 0) {
      throw new Error(`CoinbaseSwapExecutor: invalid SELL targetUsd=${targetUsd}`);
    }
    const product = await this.signedGet(`/products/${productId}`);
    const priceRaw = String(product['price'] ?? '');
    const price = Number(priceRaw);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`CoinbaseSwapExecutor: invalid product price=${priceRaw} for ${productId}`);
    }
    const baseSize = targetUsd / price;
    if (!Number.isFinite(baseSize) || baseSize <= 0) {
      throw new Error(`CoinbaseSwapExecutor: computed invalid base_size=${baseSize} for ${productId}`);
    }
    return baseSize;
  }

  private async signedPost(path: string, body: string): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = 'POST';
    const message = timestamp + method + `/api/v3/brokerage${path}` + body;
    const signature = createHmac('sha256', this.apiSecret).update(message).digest('hex');

    const res = await fetch(`${COINBASE_API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'CB-ACCESS-KEY': this.apiKey,
        'CB-ACCESS-SIGN': signature,
        'CB-ACCESS-TIMESTAMP': timestamp,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Coinbase API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async signedGet(path: string): Promise<Record<string, unknown>> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = 'GET';
    const message = timestamp + method + `/api/v3/brokerage${path}`;
    const signature = createHmac('sha256', this.apiSecret).update(message).digest('hex');

    const res = await fetch(`${COINBASE_API_BASE}${path}`, {
      method,
      headers: {
        'CB-ACCESS-KEY': this.apiKey,
        'CB-ACCESS-SIGN': signature,
        'CB-ACCESS-TIMESTAMP': timestamp,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Coinbase API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }
}
