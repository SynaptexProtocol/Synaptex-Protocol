import type { ArenaSignal, ArenaToken } from './types/arena-signal.js';
import type { VirtualPortfolio, VirtualPosition } from './types/virtual-portfolio.js';

export interface VirtualTrade {
  id: string;
  agent_id: string;
  season_id: string;
  cycle_id: string;
  token: ArenaToken;
  action: 'BUY' | 'SELL';
  amount_usd: number;
  price_usd: number;
  token_amount: number;
  timestamp: string;
}

export class VirtualPortfolioManager {
  private portfolio: VirtualPortfolio;
  private trades: VirtualTrade[] = [];

  constructor(agentId: string, seasonId: string, startingUsd: number) {
    this.portfolio = {
      agent_id: agentId,
      season_id: seasonId,
      cash_usd: startingUsd,
      positions: [],
      total_value_usd: startingUsd,
      roi: 0,
      starting_value_usd: startingUsd,
      updated_at: new Date().toISOString(),
    };
  }

  getPortfolio(): VirtualPortfolio {
    return { ...this.portfolio };
  }

  getTrades(): VirtualTrade[] {
    return [...this.trades];
  }

  /**
   * Apply an ArenaSignal to the virtual portfolio.
   * Returns the VirtualTrade if executed, null if skipped.
   */
  applySignal(signal: ArenaSignal, currentPrices: Record<string, number>): VirtualTrade | null {
    if (signal.action === 'HOLD' || signal.amount_usd === null) return null;

    const price = currentPrices[signal.token];
    if (!price || price <= 0) return null;

    if (signal.action === 'BUY') {
      return this.executeBuy(signal, price);
    } else {
      return this.executeSell(signal, price);
    }
  }

  private executeBuy(signal: ArenaSignal, price: number): VirtualTrade | null {
    const amount = signal.amount_usd!;
    if (this.portfolio.cash_usd < amount) {
      // Partial fill — use all available cash if > $1
      const available = this.portfolio.cash_usd;
      if (available < 1) return null;
      return this._buy(signal, price, available);
    }
    return this._buy(signal, price, amount);
  }

  private _buy(signal: ArenaSignal, price: number, amountUsd: number): VirtualTrade {
    const tokenAmount = amountUsd / price;

    // Update cash
    this.portfolio.cash_usd -= amountUsd;

    // Update or create position
    const existing = this.portfolio.positions.find(p => p.token === signal.token);
    if (existing) {
      const newTotalUsd = existing.avg_cost_usd * existing.amount + amountUsd;
      const newAmount = existing.amount + tokenAmount;
      existing.avg_cost_usd = newTotalUsd / newAmount;
      existing.amount = newAmount;
      existing.current_value_usd = newAmount * price;
    } else {
      this.portfolio.positions.push({
        token: signal.token as ArenaToken,
        amount: tokenAmount,
        avg_cost_usd: price,
        current_value_usd: amountUsd,
      });
    }

    const trade: VirtualTrade = {
      id: `${signal.agent_id}-${signal.cycle_id}-${signal.token}-BUY`,
      agent_id: signal.agent_id,
      season_id: this.portfolio.season_id,
      cycle_id: signal.cycle_id,
      token: signal.token,
      action: 'BUY',
      amount_usd: amountUsd,
      price_usd: price,
      token_amount: tokenAmount,
      timestamp: signal.timestamp,
    };
    this.trades.push(trade);
    return trade;
  }

  private executeSell(signal: ArenaSignal, price: number): VirtualTrade | null {
    const position = this.portfolio.positions.find(p => p.token === signal.token);
    if (!position || position.amount <= 0) return null;

    const amountUsd = signal.amount_usd!;
    const tokenAmount = Math.min(amountUsd / price, position.amount);
    const proceeds = tokenAmount * price;

    // Update position
    position.amount -= tokenAmount;
    position.current_value_usd = position.amount * price;
    if (position.amount < 0.000001) {
      this.portfolio.positions = this.portfolio.positions.filter(p => p.token !== signal.token);
    }

    // Update cash
    this.portfolio.cash_usd += proceeds;

    const trade: VirtualTrade = {
      id: `${signal.agent_id}-${signal.cycle_id}-${signal.token}-SELL`,
      agent_id: signal.agent_id,
      season_id: this.portfolio.season_id,
      cycle_id: signal.cycle_id,
      token: signal.token,
      action: 'SELL',
      amount_usd: proceeds,
      price_usd: price,
      token_amount: tokenAmount,
      timestamp: signal.timestamp,
    };
    this.trades.push(trade);
    return trade;
  }

  /**
   * Refresh current_value_usd for all positions and recalculate totals.
   */
  updatePrices(currentPrices: Record<string, number>): void {
    for (const pos of this.portfolio.positions) {
      const price = currentPrices[pos.token];
      if (price) pos.current_value_usd = pos.amount * price;
    }
    const positionValue = this.portfolio.positions.reduce((sum, p) => sum + p.current_value_usd, 0);
    this.portfolio.total_value_usd = this.portfolio.cash_usd + positionValue;
    this.portfolio.roi = (this.portfolio.total_value_usd / this.portfolio.starting_value_usd) - 1;
    this.portfolio.updated_at = new Date().toISOString();
  }

  toJSON(): { portfolio: VirtualPortfolio; trades: VirtualTrade[] } {
    return { portfolio: this.getPortfolio(), trades: this.getTrades() };
  }
}
