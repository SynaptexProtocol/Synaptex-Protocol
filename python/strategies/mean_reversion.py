"""Mean reversion strategy using Bollinger Bands.

Logic:
  - Price touches/breaks lower band → oversold → BUY
  - Price touches/breaks upper band → overbought → SELL
  - %B position determines confidence and position size
  - ATR used to filter low-volatility (boring) markets
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, ema, rsi, bollinger_bands, percent_b, atr, volume_above_avg
from strategies.base import BaseStrategy


class MeanReversionStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        bb_period = self.config.get("indicators", {}).get("bb_period", 20)
        bb_std = self.config.get("indicators", {}).get("bb_std_dev", 2.0)
        atr_period = self.config.get("indicators", {}).get("atr_period", 14)
        rsi_period = self.config.get("indicators", {}).get("rsi_period", 14)

        buy_threshold = self.config.get("signals", {}).get("buy_percent_b", 0.05)
        sell_threshold = self.config.get("signals", {}).get("sell_percent_b", 0.95)
        min_atr_pct = self.config.get("signals", {}).get("min_atr_pct", 0.005)
        rsi_oversold = self.config.get("signals", {}).get("rsi_oversold", 35)
        rsi_overbought = self.config.get("signals", {}).get("rsi_overbought", 65)
        require_rsi_confirm = self.config.get("signals", {}).get("require_rsi_confirm", True)
        require_volume = self.config.get("signals", {}).get("require_volume_confirm", False)

        min_confidence = self.config.get("rules", {}).get("min_confidence", 0.60)
        max_position_pct = self.config.get("rules", {}).get("max_position_pct_of_portfolio", 20) / 100

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            candles = mkt.candles1h
            min_bars = bb_period + rsi_period + 2
            if len(candles) < min_bars:
                continue

            c = closes(candles)
            upper, middle, lower = bollinger_bands(c, bb_period, bb_std)
            pct_b = percent_b(c, bb_period, bb_std)
            rsi_vals = rsi(c, rsi_period)
            atr_vals = atr(candles, atr_period)

            cur_pct_b = float(pct_b[-1]) if not np.isnan(pct_b[-1]) else None
            cur_rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None
            cur_atr = float(atr_vals[-1]) if not np.isnan(atr_vals[-1]) else None
            cur_upper = float(upper[-1]) if not np.isnan(upper[-1]) else None
            cur_lower = float(lower[-1]) if not np.isnan(lower[-1]) else None

            if cur_pct_b is None or cur_rsi is None or cur_atr is None:
                continue

            # Filter: skip low-volatility markets
            atr_pct = cur_atr / mkt.price
            if atr_pct < min_atr_pct:
                continue

            # Optional volume filter
            if require_volume and not volume_above_avg(candles, lookback=20, multiplier=1.1):
                continue

            # ── BUY: price near/below lower band ─────────────────────────
            if cur_pct_b <= buy_threshold:
                rsi_ok = cur_rsi <= rsi_oversold if require_rsi_confirm else True
                if not rsi_ok:
                    continue

                # Confidence: lower %B = more oversold = higher confidence
                # 0.0 %B → conf 0.90, 0.05 %B → conf 0.70
                confidence = max(min_confidence, 0.90 - cur_pct_b * 4.0)

                # Position size based on how far price is below band
                band_width = (cur_upper - cur_lower) if (cur_upper and cur_lower) else mkt.price * 0.04
                overshoot = max(0.0, cur_lower - mkt.price) if cur_lower else 0.0
                overshoot_factor = min(overshoot / (band_width * 0.5 + 1e-9), 1.0)

                base_amt = self.config.get("rules", {}).get("base_amount_usd", 50.0)
                max_amt = self.config.get("rules", {}).get("max_amount_usd", 200.0)
                amount = base_amt + (max_amt - base_amt) * overshoot_factor

                if confidence < min_confidence:
                    continue

                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Mean reversion BUY: %B={cur_pct_b:.3f} (oversold), "
                        f"RSI={cur_rsi:.1f}, price={mkt.price:.4f} near lower BB={cur_lower:.4f}"
                    ),
                    requires_ai_approval=confidence < 0.70,
                ))

            # ── SELL: price near/above upper band ────────────────────────
            elif cur_pct_b >= sell_threshold:
                rsi_ok = cur_rsi >= rsi_overbought if require_rsi_confirm else True
                if not rsi_ok:
                    continue

                # Find current position value
                position = next((p for p in portfolio.positions if p.token == token), None)
                if not position or position.currentValueUsd <= 0:
                    continue

                sell_pct = self.config.get("rules", {}).get("sell_pct_of_position", 50) / 100
                sell_usd = position.currentValueUsd * sell_pct

                # Confidence: higher %B = more overbought = higher confidence
                confidence = max(min_confidence, 0.70 + (cur_pct_b - sell_threshold) * 4.0)
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
                        f"Mean reversion SELL: %B={cur_pct_b:.3f} (overbought), "
                        f"RSI={cur_rsi:.1f}, price={mkt.price:.4f} near upper BB={cur_upper:.4f}"
                    ),
                    requires_ai_approval=confidence < 0.70,
                ))

        return signals
