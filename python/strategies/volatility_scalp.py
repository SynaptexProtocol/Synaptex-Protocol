"""Volatility scalping strategy — Bollinger Band squeeze breakout.

Logic per cycle (uses candles15m):
  - Detect BB squeeze: band_width / price < squeeze_threshold (low volatility coiling)
  - When price breaks OUT of the squeeze (closes above upper or below lower band),
    enter in the direction of the breakout
  - ATR-based position sizing: wider ATR → smaller size (more risk per unit)
  - Exit (partial SELL) when %B reverts toward midpoint after a long position
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, bollinger_bands, percent_b, atr
from strategies.base import BaseStrategy


class VolatilityScalpStrategy(BaseStrategy):

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        bb_period      = self.config.get("indicators", {}).get("bb_period", 10)
        bb_std         = self.config.get("indicators", {}).get("bb_std", 2.0)
        atr_period     = self.config.get("indicators", {}).get("atr_period", 7)
        rsi_period     = self.config.get("indicators", {}).get("rsi_period", 7)

        squeeze_thresh = self.config.get("signals", {}).get("squeeze_threshold_pct", 1.5) / 100
        min_breakout   = self.config.get("signals", {}).get("min_breakout_pct", 0.2) / 100
        rsi_max_buy    = self.config.get("signals", {}).get("rsi_max_buy", 75)
        rsi_min_sell   = self.config.get("signals", {}).get("rsi_min_sell", 25)

        base_amt       = self.config.get("rules", {}).get("base_amount_usd", 250.0)
        max_amt        = self.config.get("rules", {}).get("max_amount_usd", 700.0)
        sell_pct       = self.config.get("rules", {}).get("sell_pct_of_position", 40) / 100
        max_alloc_pct  = self.config.get("rules", {}).get("max_allocation_pct", 45) / 100

        min_candles = bb_period + rsi_period + 2

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue
            mkt = snapshot.tokens[token]
            candles = mkt.candles15m if len(mkt.candles15m) >= min_candles else mkt.candles1h
            if len(candles) < min_candles:
                continue

            c = closes(candles)
            upper, middle, lower = bollinger_bands(c, bb_period, bb_std)
            pct_b_vals = percent_b(c, bb_period, bb_std)
            atr_vals   = atr(candles, atr_period)
            rsi_vals   = rsi(c, rsi_period)

            if any(np.isnan(x[-1]) for x in [upper, lower, middle, pct_b_vals, atr_vals, rsi_vals]):
                continue

            cur_upper  = float(upper[-1])
            cur_lower  = float(lower[-1])
            cur_middle = float(middle[-1])
            cur_pct_b  = float(pct_b_vals[-1])
            cur_atr    = float(atr_vals[-1])
            cur_rsi    = float(rsi_vals[-1])
            price      = mkt.price

            band_width_pct = (cur_upper - cur_lower) / price

            # Was there a squeeze in the previous N bars?
            recent_bw = []
            for i in range(2, min(bb_period, len(candles))):
                if not np.isnan(upper[-i]) and not np.isnan(lower[-i]):
                    recent_bw.append((float(upper[-i]) - float(lower[-i])) / float(c[-i]))
            was_squeezed = len(recent_bw) > 0 and min(recent_bw) < squeeze_thresh

            total_val = portfolio.totalValueUsd
            position = next((p for p in portfolio.positions if p.token == token), None)
            current_alloc = (position.currentValueUsd / total_val) if (position and total_val > 0) else 0.0

            # ATR-based sizing: normalize around 1% ATR
            atr_pct = cur_atr / price
            if atr_pct < 0.001:
                continue  # no volatility at all
            size_factor = min(0.01 / atr_pct, 2.0)  # bigger position when ATR is smaller
            amount = min(base_amt * size_factor, max_amt)

            # ── BUY: breakout above upper band after squeeze ───────────────
            breakout_up = price > cur_upper and (price - cur_upper) / price >= min_breakout
            if breakout_up and was_squeezed and cur_rsi < rsi_max_buy and current_alloc < max_alloc_pct:
                confidence = min(0.70 + (price - cur_upper) / cur_upper * 5, 0.92)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"VolScalp BUY breakout: price={price:.4f} > BB_upper={cur_upper:.4f}, "
                        f"squeeze={min(recent_bw)*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

            # ── SELL: breakdown below lower band after squeeze ─────────────
            breakout_dn = price < cur_lower and (cur_lower - price) / price >= min_breakout
            if breakout_dn and was_squeezed and cur_rsi > rsi_min_sell and position and position.currentValueUsd > 10:
                sell_usd = position.currentValueUsd * sell_pct
                confidence = min(0.70 + (cur_lower - price) / cur_lower * 5, 0.92)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"VolScalp SELL breakdown: price={price:.4f} < BB_lower={cur_lower:.4f}, "
                        f"squeeze={min(recent_bw)*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

            # ── TAKE PROFIT: %B reverts from extreme back to midpoint ──────
            if position and position.currentValueUsd > 10 and 0.45 <= cur_pct_b <= 0.55:
                prev_pct_b = float(pct_b_vals[-2]) if not np.isnan(pct_b_vals[-2]) else None
                if prev_pct_b is not None and prev_pct_b > 0.85:
                    # Was near upper band, now back to mid → take partial profit
                    sell_usd = position.currentValueUsd * 0.30
                    signals.append(Signal(
                        strategy_id=self.id,
                        action="SELL",
                        token=token,
                        amount_usd=round(sell_usd, 2),
                        confidence=0.72,
                        rationale=(
                            f"VolScalp take-profit: %B reverted {prev_pct_b:.2f}→{cur_pct_b:.2f}, "
                            f"price={price:.4f} mid={cur_middle:.4f}"
                        ),
                        requires_ai_approval=False,
                    ))

        return signals
