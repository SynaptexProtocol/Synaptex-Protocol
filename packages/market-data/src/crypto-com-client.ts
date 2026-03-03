/**
 * Market data client — Binance REST API (no API key required for public endpoints).
 *
 * Symbol mapping for BNB Chain arena:
 *   BNB  → BNBUSDT
 *   BTCB → BTCUSDT   (BTCB price tracks BTC 1:1)
 *   USDT → USDCUSDT  (stable reference pair)
 */

import type { Candle, OrderBook, OrderBookLevel } from '@synaptex/core';
import { retry } from '@synaptex/core/utils/retry.js';

/** Maps our arena symbol → Binance trading pair */
const BINANCE_SYMBOL: Record<string, string> = {
  BNB:  'BNBUSDT',
  BTCB: 'BTCUSDT',   // BTCB tracks BTC 1:1
  USDT: 'USDCUSDT',  // stablecoin reference
  // Legacy Base Chain symbols (kept for backward compat)
  ETH:   'ETHUSDT',
  BTC:   'BTCUSDT',
  cbBTC: 'BTCUSDT',
  USDC:  'USDCUSDT',
};

/** Maps our timeframe → Binance interval string */
const BINANCE_INTERVAL: Record<string, string> = {
  '1h':  '1h',
  '15m': '15m',
  '4h':  '4h',
  '1d':  '1d',
};

const REST_BASE = 'https://api.binance.com/api/v3';

export class CryptoComClient {
  /** Returns the Binance symbol for a given token */
  resolveMcpInstrument(token: string): string {
    return BINANCE_SYMBOL[token] ?? `${token}USDT`;
  }

  resolveRestInstrument(token: string): string {
    return BINANCE_SYMBOL[token] ?? `${token}USDT`;
  }

  async getTicker(token: string): Promise<{
    price: number;
    change24h: number;
    volume24h: number;
    high24h: number;
    low24h: number;
  }> {
    return retry(() => this._getTickerRest(token));
  }

  async getCandlesticks(token: string, timeframe: '1h' | '15m'): Promise<Candle[]> {
    return retry(() => this._getCandlesticksRest(token, timeframe));
  }

  async getOrderBook(token: string, depth = 10): Promise<OrderBook> {
    return retry(() => this._getOrderBookRest(token, depth));
  }

  // ─── REST implementations ─────────────────────────────────────────────────

  private async _getTickerRest(token: string) {
    const symbol = this.resolveRestInstrument(token);
    const res = await fetch(`${REST_BASE}/ticker/24hr?symbol=${symbol}`);
    if (!res.ok) throw new Error(`Ticker REST failed: ${res.status}`);
    const d = await res.json() as {
      lastPrice: string;
      priceChangePercent: string;
      volume: string;
      highPrice: string;
      lowPrice: string;
    };
    return {
      price:     parseFloat(d.lastPrice),
      change24h: parseFloat(d.priceChangePercent) / 100,
      volume24h: parseFloat(d.volume),
      high24h:   parseFloat(d.highPrice),
      low24h:    parseFloat(d.lowPrice),
    };
  }

  private async _getCandlesticksRest(token: string, timeframe: '1h' | '15m'): Promise<Candle[]> {
    const symbol = this.resolveRestInstrument(token);
    const interval = BINANCE_INTERVAL[timeframe] ?? '1h';
    const res = await fetch(
      `${REST_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=50`
    );
    if (!res.ok) throw new Error(`Candlestick REST failed: ${res.status}`);
    // Binance kline: [openTime, open, high, low, close, volume, closeTime, ...]
    const raw = await res.json() as [number, string, string, string, string, string, ...unknown[]][];
    return raw.map((c) => ({
      timestamp: new Date(c[0]).toISOString(),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  private async _getOrderBookRest(token: string, depth: number): Promise<OrderBook> {
    const symbol = this.resolveRestInstrument(token);
    const limit = Math.min(depth, 100);
    const res = await fetch(`${REST_BASE}/depth?symbol=${symbol}&limit=${limit}`);
    if (!res.ok) throw new Error(`OrderBook REST failed: ${res.status}`);
    const json = await res.json() as {
      bids: [string, string][];
      asks: [string, string][];
    };
    return {
      bids: json.bids.map(([p, s]): OrderBookLevel => ({ price: parseFloat(p), size: parseFloat(s) })),
      asks: json.asks.map(([p, s]): OrderBookLevel => ({ price: parseFloat(p), size: parseFloat(s) })),
      timestamp: new Date().toISOString(),
    };
  }
}
