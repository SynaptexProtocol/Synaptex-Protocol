"""Trend swap strategy.

Detects EMA crossovers (golden cross / death cross) and generates
SELL signals on bearish tokens, BUY signals on bullish tokens.
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, ema, ema_crossover, volume_above_avg
from strategies.base import BaseStrategy


class TrendSwapStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []
        cfg = self.config
        fast_p = cfg.get("indicators", {}).get("fast_ema_period", 9)
        slow_p = cfg.get("indicators", {}).get("slow_ema_period", 21)
        vol_mult = cfg.get("signals", {}).get("volume_threshold_multiplier", 1.3)
        req_vol = cfg.get("signals", {}).get("require_volume_confirmation", True)
        min_conf = cfg.get("swap_rules", {}).get("min_confidence", 0.70)
        max_swap_pct = cfg.get("swap_rules", {}).get("max_swap_pct_of_holding", 50) / 100

        for token in cfg.get("tokens_to_monitor", []):
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            candles = mkt.candles1h
            if len(candles) < slow_p + 2:
                continue

            c = closes(candles)
            fast_ema = ema(c, fast_p)
            slow_ema = ema(c, slow_p)
            golden, death = ema_crossover(fast_ema, slow_ema)

            if not golden and not death:
                continue

            if req_vol and not volume_above_avg(candles, lookback=20, multiplier=vol_mult):
                continue

            # Confidence based on how far EMAs have separated
            separation = abs(float(fast_ema[-1]) - float(slow_ema[-1])) / float(slow_ema[-1])
            confidence = min(0.7 + separation * 10, 0.95)
            if confidence < min_conf:
                continue

            if golden and cfg.get("signals", {}).get("buy_on_golden_cross", True):
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Golden cross: EMA{fast_p}={fast_ema[-1]:.4f} crossed above "
                        f"EMA{slow_p}={slow_ema[-1]:.4f}"
                    ),
                    requires_ai_approval=confidence < 0.75,
                ))
            elif death and cfg.get("signals", {}).get("sell_on_death_cross", True):
                # Calculate how much to sell (% of holding)
                position = next((p for p in portfolio.positions if p.token == token), None)
                sell_usd = (position.currentValueUsd * max_swap_pct) if position else None

                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2) if sell_usd else None,
                    confidence=round(confidence, 3),
                    rationale=(
                        f"Death cross: EMA{fast_p}={fast_ema[-1]:.4f} crossed below "
                        f"EMA{slow_p}={slow_ema[-1]:.4f}"
                    ),
                    requires_ai_approval=confidence < 0.75,
                ))

        return signals
