"""Momentum strategy using MACD + Rate of Change.

Logic:
  - MACD line crosses above signal line + positive histogram → BUY
  - MACD line crosses below signal line + negative histogram → SELL
  - Rate of Change (ROC) confirms momentum direction
  - Volume surge required to validate momentum
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, macd, volume_above_avg, atr
from strategies.base import BaseStrategy


class MomentumStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        fast_p = self.config.get("indicators", {}).get("macd_fast", 12)
        slow_p = self.config.get("indicators", {}).get("macd_slow", 26)
        signal_p = self.config.get("indicators", {}).get("macd_signal", 9)
        roc_period = self.config.get("indicators", {}).get("roc_period", 10)
        rsi_period = self.config.get("indicators", {}).get("rsi_period", 14)
        atr_period = self.config.get("indicators", {}).get("atr_period", 14)

        min_roc_pct = self.config.get("signals", {}).get("min_roc_pct", 2.0) / 100
        vol_multiplier = self.config.get("signals", {}).get("volume_multiplier", 1.2)
        require_volume = self.config.get("signals", {}).get("require_volume", True)
        rsi_min = self.config.get("signals", {}).get("rsi_min", 40)
        rsi_max = self.config.get("signals", {}).get("rsi_max", 75)
        min_histogram = self.config.get("signals", {}).get("min_histogram_pct", 0.001)

        min_confidence = self.config.get("rules", {}).get("min_confidence", 0.65)
        base_amt = self.config.get("rules", {}).get("base_amount_usd", 75.0)
        max_amt = self.config.get("rules", {}).get("max_amount_usd", 300.0)
        sell_pct = self.config.get("rules", {}).get("sell_pct_of_position", 60) / 100

        min_bars = slow_p + signal_p + roc_period + 2

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            candles = mkt.candles1h
            if len(candles) < min_bars:
                continue

            c = closes(candles)
            macd_line, signal_line, histogram = macd(c, fast_p, slow_p, signal_p)
            rsi_vals = rsi(c, rsi_period)

            cur_macd = float(macd_line[-1]) if not np.isnan(macd_line[-1]) else None
            cur_signal = float(signal_line[-1]) if not np.isnan(signal_line[-1]) else None
            cur_hist = float(histogram[-1]) if not np.isnan(histogram[-1]) else None
            prev_macd = float(macd_line[-2]) if not np.isnan(macd_line[-2]) else None
            prev_signal = float(signal_line[-2]) if not np.isnan(signal_line[-2]) else None
            cur_rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None

            if any(v is None for v in [cur_macd, cur_signal, cur_hist, prev_macd, prev_signal, cur_rsi]):
                continue

            # Rate of change
            if len(c) > roc_period and c[-roc_period - 1] != 0:
                roc = (c[-1] - c[-roc_period - 1]) / c[-roc_period - 1]
            else:
                continue

            # Volume check
            if require_volume and not volume_above_avg(candles, lookback=20, multiplier=vol_multiplier):
                continue

            # Histogram as % of price (normalise across assets)
            hist_pct = abs(cur_hist) / mkt.price

            # ── BUY: MACD bullish crossover ───────────────────────────────
            bullish_cross = prev_macd <= prev_signal and cur_macd > cur_signal
            if (
                bullish_cross
                and cur_hist > 0
                and hist_pct >= min_histogram
                and roc >= min_roc_pct
                and rsi_min <= cur_rsi <= rsi_max
            ):
                # Confidence from histogram strength + ROC
                hist_score = min(hist_pct / (min_histogram * 5), 1.0)
                roc_score = min(roc / (min_roc_pct * 5), 1.0)
                confidence = 0.60 + 0.20 * hist_score + 0.15 * roc_score
                confidence = min(confidence, 0.95)

                if confidence < min_confidence:
                    continue

                amount = base_amt + (max_amt - base_amt) * hist_score

                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Momentum BUY: MACD crossover ({prev_macd:.4f}->{cur_macd:.4f}), "
                        f"hist={cur_hist:.4f}, ROC={roc*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=confidence < 0.72,
                ))

            # ── SELL: MACD bearish crossover ──────────────────────────────
            bearish_cross = prev_macd >= prev_signal and cur_macd < cur_signal
            if (
                bearish_cross
                and cur_hist < 0
                and hist_pct >= min_histogram
                and roc <= -min_roc_pct
            ):
                position = next((p for p in portfolio.positions if p.token == token), None)
                if not position or position.currentValueUsd <= 0:
                    continue

                sell_usd = position.currentValueUsd * sell_pct

                hist_score = min(hist_pct / (min_histogram * 5), 1.0)
                roc_score = min(abs(roc) / (min_roc_pct * 5), 1.0)
                confidence = 0.60 + 0.20 * hist_score + 0.15 * roc_score
                confidence = min(confidence, 0.95)

                if confidence < min_confidence:
                    continue

                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Momentum SELL: MACD crossover ({prev_macd:.4f}->{cur_macd:.4f}), "
                        f"hist={cur_hist:.4f}, ROC={roc*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=confidence < 0.72,
                ))

        return signals
