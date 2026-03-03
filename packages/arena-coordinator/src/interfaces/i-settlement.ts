export interface AgentSeasonResult {
  agent_id: string;
  agent_name: string;
  roi: number;             // e.g. 0.15 = +15%
  signal_count: number;
  trade_count: number;
  status: 'valid' | 'invalid' | 'disqualified';
}

export interface SettlementParams {
  temperature: number;    // Softmax temperature, default 2.0
}

export interface ISettlementAlgorithm {
  readonly algorithm_id: string;  // e.g. "softmax_v1"

  // Returns agent_id → weight (0-1), must sum to 1.0
  // Only called with valid agents (signal_count >= 3, trade_count >= 1)
  calculate_weights(
    results: AgentSeasonResult[],
    params: SettlementParams,
  ): Record<string, number>;
}
