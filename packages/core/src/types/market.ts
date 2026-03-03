// Candle (OHLCV) data point
export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Order book level
export interface OrderBookLevel {
  price: number;
  size: number;
}

// Order book snapshot
export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: string;
}

// Single token market data
export interface TokenMarketData {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  candles1h: Candle[];
  candles15m: Candle[];
  orderBook?: OrderBook;
  timestamp: string;
}

// Full market snapshot sent to Python each cycle
export interface MarketSnapshot {
  timestamp: string;
  tokens: Record<string, TokenMarketData>;
  portfolio: PortfolioState;
  activeStrategies: string[];
  strategyWeights?: Record<string, number>;
  cycleId: string;
}

export interface PortfolioPosition {
  token: string;
  amount: number;
  avgCostUsd: number;
  currentValueUsd: number;
}

export interface PortfolioState {
  walletAddress: string;
  nativeBalance: number;       // ETH
  stableBalance: number;       // USDC
  positions: PortfolioPosition[];
  totalValueUsd: number;
  dailyPnlUsd: number;
  timestamp: string;
}
