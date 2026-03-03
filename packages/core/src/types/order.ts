export type OrderStatus = 'pending' | 'open' | 'filled' | 'cancelled' | 'expired';
export type OrderSide = 'BUY' | 'SELL';

export interface SwapRequest {
  walletName: string;
  chain: 'base';
  fromToken: string;
  toToken: string;
  fromAmountUsd: number;
  maxSlippageBps: number;
}

export interface SimulationResult {
  fromToken: string;
  toToken: string;
  fromAmount: number;
  expectedToAmount: number;
  priceImpactBps: number;
  estimatedGasUsd: number;
  route: string;
  valid: boolean;
  invalidReason?: string;
}

export interface SwapReceipt {
  txHash: string;
  fromToken: string;
  toToken: string;
  fromAmount: number;
  toAmount: number;
  gasPaidUsd: number;
  timestamp: string;
  chain: string;
}

export interface LimitOrder {
  id: string;
  token: string;
  side: OrderSide;
  targetPriceUsd: number;
  amountUsd: number;
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  filledAt?: string;
  txHash?: string;
}

export interface Trade {
  id: string;
  strategyId: string;
  action: OrderSide;
  token: string;
  amountUsd: number;
  priceUsd: number;
  txHash?: string;
  chain: 'base';
  approvedBy: 'auto' | 'ai' | 'user';
  timestamp: string;
  isPaper: boolean;
}
