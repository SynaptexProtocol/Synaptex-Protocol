"""RSI Divergence strategy.

Logic:
  Bullish divergence:  price makes lower low, RSI makes higher low → BUY
  Bearish divergence:  price makes higher high, RSI makes lower high → SELL

  Divergences signal that momentum is weakening before price reverses.
  Higher confidence signal than pure RSI because it requires two conditions.
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, atr, rsi_divergence, volume_above_avg
from strategies.base import BaseStrategy


class RSIDivergenceStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        rsi_period = self.config.get("indicators", {}).get("rsi_period", 14)
        lookback = self.config.get("indicators", {}).get("divergence_lookback", 20)
        atr_period = self.config.get("indicators", {}).get("atr_period", 14)

        rsi_oversold = self.config.get("signals", {}).get("rsi_oversold_threshold", 45)
        rsi_overbought = self.config.get("signals", {}).get("rsi_overbought_threshold", 55)
        min_atr_pct = self.config.get("signals", {}).get("min_atr_pct", 0.008)
        require_volume = self.config.get("signals", {}).get("require_volume_confirm", False)

        base_amt = self.config.get("rules", {}).get("base_amount_usd", 100.0)
        max_amt = self.config.get("rules", {}).get("max_amount_usd", 400.0)
        sell_pct = self.config.get("rules", {}).get("sell_pct_of_position", 50) / 100
        min_confidence = self.config.get("rules", {}).get("min_confidence", 0.68)

        min_bars = rsi_period + lookback + 2

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            candles = mkt.candles1h
            if len(candles) < min_bars:
                continue

            c = closes(candles)
            rsi_vals = rsi(c, rsi_period)
            atr_vals = atr(candles, atr_period)

            cur_rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None
            cur_atr = float(atr_vals[-1]) if not np.isnan(atr_vals[-1]) else None

            if cur_rsi is None or cur_atr is None:
                continue

            # Skip low-volatility markets
            if cur_atr / mkt.price < min_atr_pct:
                continue

            if require_volume and not volume_above_avg(candles, lookback=20, multiplier=1.15):
                continue

            bullish, bearish = rsi_divergence(candles, rsi_vals, lookback)

            # ── BUY: bullish divergence ───────────────────────────────────
            if bullish and cur_rsi <= rsi_oversold:
                # How far RSI recovered from its low
                rsi_window = rsi_vals[-lookback:]
                valid_rsi = rsi_window[~np.isnan(rsi_window)]
                rsi_low = float(np.min(valid_rsi)) if len(valid_rsi) > 0 else cur_rsi
                rsi_recovery = max(0.0, cur_rsi - rsi_low)
                recovery_score = min(rsi_recovery / 10.0, 1.0)

                confidence = 0.68 + 0.22 * recovery_score
                confidence = min(confidence, 0.92)

                if confidence < min_confidence:
                    continue

                amount = base_amt + (max_amt - base_amt) * recovery_score

                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Bullish RSI divergence: price lower low but RSI={cur_rsi:.1f} "
                        f"(low was {rsi_low:.1f}), recovery={rsi_recovery:.1f}pts, "
                        f"price={mkt.price:.4f}"
                    ),
                    requires_ai_approval=confidence < 0.75,
                ))

            # ── SELL: bearish divergence ──────────────────────────────────
            elif bearish and cur_rsi >= rsi_overbought:
                position = next((p for p in portfolio.positions if p.token == token), None)
                if not position or position.currentValueUsd <= 0:
                    continue

                rsi_window = rsi_vals[-lookback:]
                valid_rsi = rsi_window[~np.isnan(rsi_window)]
                rsi_high = float(np.max(valid_rsi)) if len(valid_rsi) > 0 else cur_rsi
                rsi_weakness = max(0.0, rsi_high - cur_rsi)
                weakness_score = min(rsi_weakness / 10.0, 1.0)

                confidence = 0.68 + 0.22 * weakness_score
                confidence = min(confidence, 0.92)

                if confidence < min_confidence:
                    continue

                sell_usd = position.currentValueUsd * sell_pct

                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Bearish RSI divergence: price higher high but RSI={cur_rsi:.1f} "
                        f"(high was {rsi_high:.1f}), weakness={rsi_weakness:.1f}pts, "
                        f"price={mkt.price:.4f}"
                    ),
                    requires_ai_approval=confidence < 0.75,
                ))

        return signals
