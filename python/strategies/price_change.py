"""Price change momentum strategy — designed for high-frequency (5-minute cycle) seasons.

Logic per cycle:
  - Uses candles15m as primary data source (available within minutes of season start)
  - BUY  when: short-term price gained >= buy_threshold_pct over lookback candles
               AND RSI not overbought AND not already over-allocated
  - SELL when: short-term price dropped >= sell_threshold_pct over lookback candles
               AND RSI not oversold AND we hold a position
  - Each cycle tracks per-token cycle_count to avoid hammering the same direction
    more than max_trades_per_direction times in a row without reversal
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, atr
from strategies.base import BaseStrategy


class PriceChangeStrategy(BaseStrategy):
    """High-frequency momentum strategy using 15m candles."""

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        # Per-token state: track last direction to avoid repeating same side
        self._last_action: dict[str, str] = {}
        self._consecutive: dict[str, int] = {}

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        lookback       = self.config.get("indicators", {}).get("lookback_candles", 3)
        rsi_period     = self.config.get("indicators", {}).get("rsi_period", 7)
        atr_period     = self.config.get("indicators", {}).get("atr_period", 7)

        buy_thresh     = self.config.get("signals", {}).get("buy_threshold_pct", 0.3) / 100
        sell_thresh    = self.config.get("signals", {}).get("sell_threshold_pct", 0.3) / 100
        rsi_overbought = self.config.get("signals", {}).get("rsi_overbought", 72)
        rsi_oversold   = self.config.get("signals", {}).get("rsi_oversold", 28)
        min_atr_pct    = self.config.get("signals", {}).get("min_atr_pct", 0.001)
        max_consecutive= self.config.get("signals", {}).get("max_consecutive_same_side", 2)

        base_amt       = self.config.get("rules", {}).get("base_amount_usd", 200.0)
        max_amt        = self.config.get("rules", {}).get("max_amount_usd", 600.0)
        sell_pct       = self.config.get("rules", {}).get("sell_pct_of_position", 50) / 100
        max_alloc_pct  = self.config.get("rules", {}).get("max_allocation_pct", 40) / 100

        min_candles = lookback + rsi_period + 2

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            # Prefer 15m candles for responsiveness; fall back to 1h
            candles = mkt.candles15m if len(mkt.candles15m) >= min_candles else mkt.candles1h
            if len(candles) < min_candles:
                continue

            c = closes(candles)
            rsi_vals = rsi(c, rsi_period)
            atr_vals = atr(candles, atr_period)

            cur_rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None
            cur_atr = float(atr_vals[-1]) if not np.isnan(atr_vals[-1]) else None

            if cur_rsi is None or cur_atr is None:
                continue

            # Require minimum volatility — skip boring flat markets
            if cur_atr / mkt.price < min_atr_pct:
                continue

            # Price change over lookback candles
            if len(c) < lookback + 1:
                continue
            price_change = (c[-1] - c[-lookback - 1]) / c[-lookback - 1]

            # Current portfolio allocation for this token
            total_val = portfolio.totalValueUsd
            position = next((p for p in portfolio.positions if p.token == token), None)
            current_alloc = (position.currentValueUsd / total_val) if (position and total_val > 0) else 0.0

            consecutive = self._consecutive.get(token, 0)
            last_action = self._last_action.get(token, "")

            # ── BUY signal ────────────────────────────────────────────────
            if (
                price_change >= buy_thresh
                and cur_rsi < rsi_overbought
                and current_alloc < max_alloc_pct
            ):
                # Throttle: don't buy more than max_consecutive times in a row
                if last_action == "BUY" and consecutive >= max_consecutive:
                    continue

                # Scale amount by how strong the move is (up to 3× threshold = max)
                strength = min(price_change / (buy_thresh * 3), 1.0)
                amount = base_amt + (max_amt - base_amt) * strength
                confidence = min(0.65 + 0.25 * strength, 0.92)

                self._last_action[token] = "BUY"
                self._consecutive[token] = consecutive + 1 if last_action == "BUY" else 1

                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"PriceChange BUY: +{price_change*100:.2f}% over {lookback} candles, "
                        f"RSI={cur_rsi:.1f}, ATR%={cur_atr/mkt.price*100:.3f}%"
                    ),
                    requires_ai_approval=False,
                ))

            # ── SELL signal ───────────────────────────────────────────────
            elif (
                price_change <= -sell_thresh
                and cur_rsi > rsi_oversold
                and position is not None
                and position.currentValueUsd > 10
            ):
                # Throttle: don't sell more than max_consecutive times in a row
                if last_action == "SELL" and consecutive >= max_consecutive:
                    continue

                strength = min(abs(price_change) / (sell_thresh * 3), 1.0)
                sell_usd = position.currentValueUsd * sell_pct
                confidence = min(0.65 + 0.25 * strength, 0.92)

                self._last_action[token] = "SELL"
                self._consecutive[token] = consecutive + 1 if last_action == "SELL" else 1

                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"PriceChange SELL: {price_change*100:.2f}% over {lookback} candles, "
                        f"RSI={cur_rsi:.1f}, position=${position.currentValueUsd:.0f}"
                    ),
                    requires_ai_approval=False,
                ))

        return signals
