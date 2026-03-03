"""Take-profit / stop-loss manager strategy.

Monitors open positions every cycle and fires SELL signals when:
  1. TAKE PROFIT: position ROI >= take_profit_pct (lock in gains)
  2. STOP LOSS:   position ROI <= -stop_loss_pct  (cut losses)
  3. TRAILING STOP: price retreats from session high by >= trail_pct
                    (only triggers after position is already profitable)

This strategy is PURELY reactive — it never buys, only manages exits.
Run it alongside any momentum strategy to ensure positions don't ride
losses indefinitely in a 1-hour session.

Uses per-position entry cost from portfolio state for ROI calculation.
"""
from __future__ import annotations
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from strategies.base import BaseStrategy


class TakeProfitStrategy(BaseStrategy):

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        # Track session-high price for each token (for trailing stop)
        self._session_high: dict[str, float] = {}

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        tp_pct       = self.config.get("rules", {}).get("take_profit_pct", 1.5) / 100
        sl_pct       = self.config.get("rules", {}).get("stop_loss_pct", 1.0) / 100
        trail_pct    = self.config.get("rules", {}).get("trailing_stop_pct", 0.8) / 100
        trail_min_roi= self.config.get("rules", {}).get("trail_activate_roi_pct", 0.5) / 100
        partial_tp   = self.config.get("rules", {}).get("partial_take_profit_pct", 60) / 100
        full_sl      = self.config.get("rules", {}).get("full_stop_loss", True)

        for position in portfolio.positions:
            token = position.token
            if token not in snapshot.tokens:
                continue
            if position.avgCostUsd <= 0 or position.amount <= 0:
                continue

            price = snapshot.tokens[token].price

            # Update trailing high
            prev_high = self._session_high.get(token, price)
            self._session_high[token] = max(prev_high, price)
            session_high = self._session_high[token]

            # ROI from entry
            roi = (price - position.avgCostUsd) / position.avgCostUsd

            reason = None
            sell_pct = 1.0  # default: full sell

            # ── Stop Loss ─────────────────────────────────────────────────
            if roi <= -sl_pct:
                reason = f"StopLoss: ROI={roi*100:.2f}% <= -{sl_pct*100:.1f}%"
                sell_pct = 1.0 if full_sl else 0.75

            # ── Take Profit (partial) ──────────────────────────────────────
            elif roi >= tp_pct:
                reason = f"TakeProfit: ROI={roi*100:.2f}% >= +{tp_pct*100:.1f}%"
                sell_pct = partial_tp

            # ── Trailing Stop (only if already profitable) ─────────────────
            elif roi >= trail_min_roi and session_high > 0:
                trail_trigger = (session_high - price) / session_high
                if trail_trigger >= trail_pct:
                    reason = (
                        f"TrailingStop: price={price:.4f} retreated "
                        f"{trail_trigger*100:.2f}% from session_high={session_high:.4f}"
                    )
                    sell_pct = partial_tp

            if reason is None:
                continue

            sell_usd = position.currentValueUsd * sell_pct
            if sell_usd < 10:
                continue

            confidence = 0.88 if "StopLoss" in reason else 0.82

            signals.append(Signal(
                strategy_id=self.id,
                action="SELL",
                token=token,
                amount_usd=round(sell_usd, 2),
                confidence=confidence,
                rationale=f"TakeProfit [{reason}], pos=${position.currentValueUsd:.0f}",
                requires_ai_approval=False,
            ))

        return signals
