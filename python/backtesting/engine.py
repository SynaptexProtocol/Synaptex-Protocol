"""
Core backtesting simulation engine.

Simulates strategy execution bar-by-bar on historical candles.
Uses the same strategy code as live trading — no special "backtest mode".

Architecture:
  - Feed candles one-by-one to the strategy (walk-forward simulation)
  - Build a minimal MarketSnapshot + PortfolioState for each bar
  - Collect signals, apply slippage & fee model, update paper portfolio
  - Record every trade and compute performance metrics
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import yaml
import numpy as np

from models.market import MarketSnapshot, TokenMarketData, PortfolioState, Candle
from models.signal import Signal
from strategies.base import BaseStrategy
from strategies.dca import TrendDCAStrategy
from strategies.trend_swap import TrendSwapStrategy
from strategies.limit_order import LimitOrderStrategy
from risk.manager import RiskManager, RiskLimits

# Minimum bars needed before we start evaluating (warm-up period)
WARMUP_BARS = 50

# Trade cost model
TAKER_FEE_PCT = 0.001   # 0.1% taker fee (Crypto.com exchange)
SLIPPAGE_PCT  = 0.001   # 0.1% average slippage

STRATEGY_CLASSES: dict[str, type[BaseStrategy]] = {
    "dca":          TrendDCAStrategy,
    "trend_swap":   TrendSwapStrategy,
    "limit_orders": LimitOrderStrategy,
}


@dataclass
class Trade:
    bar:         int
    timestamp:   str
    action:      str          # BUY | SELL
    token:       str
    price:       float
    amount_usd:  float
    quantity:    float        # tokens bought/sold
    fee_usd:     float
    strategy_id: str
    rationale:   str
    signal_conf: float


@dataclass
class BacktestResult:
    strategy_name:   str
    token:           str
    initial_capital: float
    final_capital:   float     # stableBalance + position value
    total_return_pct: float
    max_drawdown_pct: float
    sharpe_ratio:    float
    total_trades:    int
    win_trades:      int
    loss_trades:     int
    win_rate:        float
    avg_trade_pnl:   float
    best_trade_pnl:  float
    worst_trade_pnl: float
    total_fees_usd:  float
    bars_tested:     int
    signals_generated: int
    signals_vetoed:  int
    equity_curve:    list[float]
    trades:          list[Trade]

    def to_dict(self) -> dict:
        return {
            "strategy_name":    self.strategy_name,
            "token":            self.token,
            "initial_capital":  self.initial_capital,
            "final_capital":    round(self.final_capital, 2),
            "total_return_pct": round(self.total_return_pct, 2),
            "max_drawdown_pct": round(self.max_drawdown_pct, 2),
            "sharpe_ratio":     round(self.sharpe_ratio, 3),
            "total_trades":     self.total_trades,
            "win_trades":       self.win_trades,
            "loss_trades":      self.loss_trades,
            "win_rate":         round(self.win_rate, 3),
            "avg_trade_pnl":    round(self.avg_trade_pnl, 2),
            "best_trade_pnl":   round(self.best_trade_pnl, 2),
            "worst_trade_pnl":  round(self.worst_trade_pnl, 2),
            "total_fees_usd":   round(self.total_fees_usd, 2),
            "bars_tested":      self.bars_tested,
            "signals_generated": self.signals_generated,
            "signals_vetoed":   self.signals_vetoed,
            "trades": [
                {
                    "bar":       t.bar,
                    "timestamp": t.timestamp,
                    "action":    t.action,
                    "token":     t.token,
                    "price":     round(t.price, 4),
                    "amount_usd": round(t.amount_usd, 2),
                    "quantity":  round(t.quantity, 6),
                    "fee_usd":   round(t.fee_usd, 4),
                    "strategy_id": t.strategy_id,
                    "rationale": t.rationale,
                }
                for t in self.trades
            ],
        }


class BacktestEngine:
    """
    Walk-forward backtesting engine.

    Each bar we:
      1. Build a MarketSnapshot from [0..i] candles (strategy sees history up to now)
      2. Run strategy.generate_signals()
      3. Execute signals at next bar's open (realistic fill)
      4. Update paper portfolio
      5. Record equity
    """

    def __init__(
        self,
        strategy_name: str,
        strategy_config_path: str,
        token: str,
        initial_capital: float = 1000.0,
    ) -> None:
        self.strategy_name = strategy_name
        self.token = token
        self.initial_capital = initial_capital

        with open(strategy_config_path, encoding="utf-8") as f:
            strat_cfg = yaml.safe_load(f)

        cls = STRATEGY_CLASSES.get(strategy_name)
        if cls is None:
            raise ValueError(f"Unknown strategy: {strategy_name}")
        self.strategy: BaseStrategy = cls(strat_cfg)

        self.risk = RiskManager(RiskLimits(
            max_position_size_usd=initial_capital * 0.5,
            max_total_exposure_usd=initial_capital,
            max_daily_loss_usd=initial_capital * 0.10,
        ))

    def run(self, candles: list[Candle]) -> BacktestResult:
        """Execute walk-forward simulation and return metrics."""
        n = len(candles)
        if n < WARMUP_BARS + 1:
            raise ValueError(f"Need at least {WARMUP_BARS + 1} candles, got {n}")

        # Paper portfolio state
        stable_bal = self.initial_capital   # USDT
        token_qty   = 0.0                   # tokens held
        total_fees  = 0.0

        equity_curve: list[float] = []
        trades:        list[Trade] = []
        trade_pnls:    list[float] = []     # closed trade P&L

        signals_generated = 0
        signals_vetoed    = 0

        pending_signal: Signal | None = None  # execute at next bar open

        for i in range(WARMUP_BARS, n):
            bar      = candles[i]
            fill_price = candles[i].open  # fill at current bar open

            # --- Execute pending signal from previous bar ---
            if pending_signal is not None:
                sig    = pending_signal
                price  = fill_price * (1 + SLIPPAGE_PCT if sig.action == "BUY" else 1 - SLIPPAGE_PCT)

                if sig.action == "BUY":
                    amount = sig.amount_usd or (stable_bal * 0.1)  # default 10% of stable balance
                    fee    = amount * TAKER_FEE_PCT

                    if stable_bal >= amount + fee:
                        qty = (amount - fee) / price
                        stable_bal  -= (amount + fee)
                        token_qty   += qty
                        total_fees  += fee
                        trades.append(Trade(
                            bar=i, timestamp=bar.timestamp, action="BUY",
                            token=self.token, price=price, amount_usd=amount,
                            quantity=qty, fee_usd=fee,
                            strategy_id=sig.strategy_id,
                            rationale=sig.rationale, signal_conf=sig.confidence,
                        ))

                elif sig.action == "SELL" and token_qty > 0:
                    # SELL: amount_usd is the USD value to sell; if None, sell all
                    if sig.amount_usd:
                        sell_qty = min(token_qty, sig.amount_usd / price)
                    else:
                        sell_qty = token_qty   # sell full position
                    sell_qty  = max(sell_qty, 0.0)
                    proceeds  = sell_qty * price
                    fee       = proceeds * TAKER_FEE_PCT
                    pnl       = proceeds - fee - (sell_qty * _cost_basis(trades, self.token))
                    stable_bal += proceeds - fee
                    token_qty  -= sell_qty
                    total_fees += fee
                    trade_pnls.append(pnl)
                    trades.append(Trade(
                        bar=i, timestamp=bar.timestamp, action="SELL",
                        token=self.token, price=price, amount_usd=proceeds,
                        quantity=sell_qty, fee_usd=fee,
                        strategy_id=sig.strategy_id,
                        rationale=sig.rationale, signal_conf=sig.confidence,
                    ))

                pending_signal = None

            # --- Compute current equity ---
            position_value = token_qty * bar.close
            equity = stable_bal + position_value
            equity_curve.append(equity)

            # --- Generate signals for next bar (walk-forward) ---
            history = candles[max(0, i - 199): i + 1]   # up to 200 bars of history
            half    = len(history) // 2

            portfolio = PortfolioState(
                walletAddress="backtest",
                nativeBalance=token_qty,
                stableBalance=stable_bal,
                positions=[],
                totalValueUsd=equity,
                dailyPnlUsd=0.0,
                timestamp=bar.timestamp,
            )

            snapshot = MarketSnapshot(
                timestamp=bar.timestamp,
                cycleId=f"bt-{i}",
                activeStrategies=[self.strategy_name],
                tokens={
                    self.token: TokenMarketData(
                        symbol=self.token,
                        price=bar.close,
                        change24h=0.0,
                        volume24h=bar.volume * bar.close,
                        high24h=bar.high,
                        low24h=bar.low,
                        candles1h=history,
                        candles15m=history[half:],
                        timestamp=bar.timestamp,
                    )
                },
                portfolio=portfolio,
            )

            try:
                signals = self.strategy.generate_signals(snapshot, portfolio)
            except Exception as e:
                signals = []

            signals_generated += len(signals)

            for sig in signals:
                ok, reason = self.risk.check_pre_trade(sig, portfolio)
                if ok:
                    pending_signal = sig  # take first approved signal
                    break
                else:
                    signals_vetoed += 1

        # --- Final equity (liquidate position at last close) ---
        last_price  = candles[-1].close
        final_cap   = stable_bal + token_qty * last_price
        total_ret   = (final_cap - self.initial_capital) / self.initial_capital * 100

        # --- Metrics ---
        wins   = sum(1 for p in trade_pnls if p > 0)
        losses = sum(1 for p in trade_pnls if p <= 0)
        total_closed = len(trade_pnls)
        win_rate  = wins / total_closed if total_closed > 0 else 0.0
        avg_pnl   = float(np.mean(trade_pnls)) if trade_pnls else 0.0
        best_pnl  = float(max(trade_pnls)) if trade_pnls else 0.0
        worst_pnl = float(min(trade_pnls)) if trade_pnls else 0.0

        max_dd    = _max_drawdown(equity_curve)
        sharpe    = _sharpe(equity_curve)

        return BacktestResult(
            strategy_name=self.strategy_name,
            token=self.token,
            initial_capital=self.initial_capital,
            final_capital=round(final_cap, 2),
            total_return_pct=round(total_ret, 2),
            max_drawdown_pct=round(max_dd, 2),
            sharpe_ratio=round(sharpe, 3),
            total_trades=len(trades),
            win_trades=wins,
            loss_trades=losses,
            win_rate=round(win_rate, 3),
            avg_trade_pnl=round(avg_pnl, 2),
            best_trade_pnl=round(best_pnl, 2),
            worst_trade_pnl=round(worst_pnl, 2),
            total_fees_usd=round(total_fees, 2),
            bars_tested=n - WARMUP_BARS,
            signals_generated=signals_generated,
            signals_vetoed=signals_vetoed,
            equity_curve=equity_curve,
            trades=trades,
        )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _cost_basis(trades: list[Trade], token: str) -> float:
    """Simple average cost basis of current open position."""
    buys = [t for t in trades if t.action == "BUY" and t.token == token]
    if not buys:
        return 0.0
    total_cost = sum(t.amount_usd for t in buys)
    total_qty  = sum(t.quantity for t in buys)
    return total_cost / total_qty if total_qty > 0 else 0.0


def _max_drawdown(equity: list[float]) -> float:
    """Maximum peak-to-trough drawdown as a percentage."""
    if len(equity) < 2:
        return 0.0
    peak    = equity[0]
    max_dd  = 0.0
    for e in equity:
        if e > peak:
            peak = e
        dd = (peak - e) / peak * 100
        if dd > max_dd:
            max_dd = dd
    return max_dd


def _sharpe(equity: list[float], risk_free_annual: float = 0.05) -> float:
    """
    Annualised Sharpe ratio using hourly equity returns.
    Assumes 1h candles → 8760 bars/year.
    """
    if len(equity) < 2:
        return 0.0
    returns = np.diff(equity) / np.array(equity[:-1])
    if returns.std() == 0:
        return 0.0
    bars_per_year = 8760
    rf_per_bar    = risk_free_annual / bars_per_year
    excess        = returns - rf_per_bar
    return float(excess.mean() / excess.std() * math.sqrt(bars_per_year))
