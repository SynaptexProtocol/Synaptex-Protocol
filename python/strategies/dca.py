"""Trend-tracking DCA strategy.

Buys configured tokens when they are in an uptrend (price > EMA20,
RSI not overbought, optional volume confirmation).
"""
from __future__ import annotations
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, ema, rsi, volume_above_avg
from strategies.base import BaseStrategy
import numpy as np


class TrendDCAStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        for token, tcfg in self.config.get("tokens", {}).items():
            if not tcfg.get("enabled", True):
                continue
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            candles = mkt.candles1h
            if len(candles) < 25:
                continue

            c = closes(candles)
            period = tcfg.get("ema_period", 20)
            ema_vals = ema(c, period)
            rsi_vals = rsi(c)

            current_ema = float(ema_vals[-1]) if not np.isnan(ema_vals[-1]) else None
            current_rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None

            if current_ema is None or current_rsi is None:
                continue

            min_rsi = tcfg.get("min_rsi", 30)
            max_rsi = tcfg.get("max_rsi", 70)

            price_above_ema = mkt.price > current_ema

            # Count consecutive bars above EMA
            min_bars = self.config.get("trend_confirmation", {}).get("min_trend_bars", 3)
            consecutive = sum(
                1
                for i in range(1, min_bars + 1)
                if i <= len(candles) and not np.isnan(ema_vals[-i]) and candles[-i].close > float(ema_vals[-i])
            )
            trend_confirmed = consecutive >= min_bars

            rsi_ok = min_rsi < current_rsi < max_rsi
            volume_ok = True
            if tcfg.get("require_volume_increase"):
                volume_ok = volume_above_avg(candles, lookback=20, multiplier=1.1)

            if not (price_above_ema and trend_confirmed and rsi_ok and volume_ok):
                continue

            # Confidence scales with trend strength
            trend_strength = min((mkt.price - current_ema) / current_ema, 0.05) / 0.05
            confidence = 0.6 + 0.3 * trend_strength

            base_amt = tcfg.get("base_amount_usd", 25.0)
            max_amt = tcfg.get("max_amount_usd", base_amt)
            if tcfg.get("trend_multiplier"):
                amount = base_amt + (max_amt - base_amt) * trend_strength
            else:
                amount = base_amt

            signals.append(
                Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"EMA{period} uptrend ({consecutive}/{min_bars} bars), "
                        f"RSI={current_rsi:.1f}, price={mkt.price:.4f} > EMA={current_ema:.4f}"
                    ),
                    requires_ai_approval=False,
                )
            )

        return signals
