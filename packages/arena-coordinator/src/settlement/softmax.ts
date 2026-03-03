import type { ISettlementAlgorithm, AgentSeasonResult, SettlementParams } from '../interfaces/i-settlement.js';

/**
 * Softmax settlement algorithm.
 * w_i = exp(ROI_i × T) / Σ exp(ROI_j × T)
 *
 * T (temperature) controls winner-take-all intensity:
 *  - T=1.0: mild redistribution
 *  - T=2.0: moderate (default)
 *  - T=5.0: strong winner-take-all
 */
export class SoftmaxSettlement implements ISettlementAlgorithm {
  readonly algorithm_id = 'softmax_v1';

  calculate_weights(
    results: AgentSeasonResult[],
    params: SettlementParams,
  ): Record<string, number> {
    const T = params.temperature ?? 2.0;

    if (results.length === 0) return {};
    if (results.length === 1) return { [results[0].agent_id]: 1.0 };

    // Compute exp(ROI * T) for each agent
    const exps = results.map(r => ({
      agent_id: r.agent_id,
      exp: Math.exp(r.roi * T),
    }));

    const sum = exps.reduce((s, e) => s + e.exp, 0);

    const weights: Record<string, number> = {};
    for (const { agent_id, exp } of exps) {
      weights[agent_id] = exp / sum;
    }

    return weights;
  }
}
