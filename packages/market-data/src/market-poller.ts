import type { TokenMarketData } from '@synaptex/core';
import { logger } from '@synaptex/core/utils/logger.js';
import { CryptoComClient } from './crypto-com-client.js';
import { MarketCache } from './market-cache.js';

export class MarketPoller {
  private client = new CryptoComClient();
  private cache = new MarketCache();

  constructor(private readonly tokens: string[]) {}

  async poll(): Promise<Record<string, TokenMarketData>> {
    const results: Record<string, TokenMarketData> = {};

    await Promise.allSettled(
      this.tokens.map(async (token) => {
        try {
          const [ticker, candles1h, candles15m] = await Promise.all([
            this.client.getTicker(token),
            this.client.getCandlesticks(token, '1h'),
            this.client.getCandlesticks(token, '15m'),
          ]);

          const data: TokenMarketData = {
            symbol: token,
            price: ticker.price,
            change24h: ticker.change24h,
            volume24h: ticker.volume24h,
            high24h: ticker.high24h,
            low24h: ticker.low24h,
            candles1h,
            candles15m,
            timestamp: new Date().toISOString(),
          };

          this.cache.set(token, data);
          results[token] = data;
        } catch (err) {
          logger.warn(`Failed to poll ${token}, using cached data`, { error: String(err) });
          const cached = this.cache.get(token);
          if (cached) results[token] = cached;
        }
      })
    );

    return results;
  }

  getCache(): MarketCache {
    return this.cache;
  }
}
