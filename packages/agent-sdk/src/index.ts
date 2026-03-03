export type SdkAction = 'BUY' | 'SELL' | 'HOLD';
export type SdkToken = 'ETH' | 'cbBTC' | 'USDC';

export interface SdkSignal {
  action: SdkAction;
  token: SdkToken;
  amount_usd?: number;
  confidence?: number;
  reason?: string;
}

export interface SdkMarketToken {
  price: number;
  change24h: number;
  candles1h: unknown[];
}

export interface SdkSnapshot {
  schema_version: '2.0';
  trace_id: string;
  idempotency_key: string;
  agent_id: string;
  season_id: string;
  cycle_id: string;
  timestamp: string;
  snapshot: {
    tokens: Record<string, SdkMarketToken>;
  };
  portfolio: {
    cash_usd: number;
    positions: Array<{ token: string; amount: number; avg_cost_usd: number; current_value_usd: number }>;
    total_value_usd: number;
    roi: number;
  };
}

export interface SdkDecisionResult {
  schema_version?: string;
  trace_id?: string;
  idempotency_key?: string;
  signals: SdkSignal[];
}

export type DecideFunction = (input: SdkSnapshot) => Promise<SdkDecisionResult | SdkSignal[] | null | undefined>;

export abstract class ArenaAgent {
  abstract decide(input: SdkSnapshot): Promise<SdkDecisionResult | SdkSignal[] | null | undefined>;
}

export function defineAgent(decide: DecideFunction): { decide: DecideFunction } {
  return { decide };
}

