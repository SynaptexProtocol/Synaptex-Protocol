import type { TokenMarketData } from '@synaptex/core';

const TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  data: TokenMarketData;
  expiresAt: number;
}

export class MarketCache {
  private store = new Map<string, CacheEntry>();

  set(token: string, data: TokenMarketData): void {
    this.store.set(token, { data, expiresAt: Date.now() + TTL_MS });
  }

  get(token: string): TokenMarketData | undefined {
    const entry = this.store.get(token);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(token);
      return undefined;
    }
    return entry.data;
  }

  getAll(): Record<string, TokenMarketData> {
    const result: Record<string, TokenMarketData> = {};
    for (const [token, entry] of this.store) {
      if (Date.now() <= entry.expiresAt) {
        result[token] = entry.data;
      }
    }
    return result;
  }

  isStale(token: string): boolean {
    const entry = this.store.get(token);
    return !entry || Date.now() > entry.expiresAt;
  }
}
