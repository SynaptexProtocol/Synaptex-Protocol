"""RSI extreme reversal strategy — fast RSI for 5-minute cycles.

Uses a very short RSI (period=5 or 6) on 15m candles.
Extreme oversold/overbought on a short timeframe resolves quickly,
making this suitable for hourly sessions.

Logic:
  - RSI < oversold_level  AND price just ticked up (close > prev close) → BUY
  - RSI > overbought_level AND price just ticked down (close < prev close) → SELL
  - Confirmation: consecutive bars in extreme zone increases confidence
  - Requires holding a position before allowing SELL
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, atr
from strategies.base import BaseStrategy


class RsiExtremeStrategy(BaseStrategy):

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        rsi_period     = self.config.get("indicators", {}).get("rsi_period", 5)
        atr_period     = self.config.get("indicators", {}).get("atr_period", 7)

        oversold       = self.config.get("signals", {}).get("oversold_level", 22)
        overbought     = self.config.get("signals", {}).get("overbought_level", 78)
        min_extreme_bars = self.config.get("signals", {}).get("min_extreme_bars", 1)
        require_reversal = self.config.get("signals", {}).get("require_price_reversal", True)

        base_amt       = self.config.get("rules", {}).get("base_amount_usd", 200.0)
        max_amt        = self.config.get("rules", {}).get("max_amount_usd", 500.0)
        sell_pct       = self.config.get("rules", {}).get("sell_pct_of_position", 50) / 100
        max_alloc_pct  = self.config.get("rules", {}).get("max_allocation_pct", 40) / 100

        min_candles = rsi_period + min_extreme_bars + 3

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue
            mkt = snapshot.tokens[token]
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

            # Require minimum volatility
            if cur_atr / mkt.price < 0.001:
                continue

            # Count consecutive bars in extreme zone
            extreme_buy_bars = 0
            extreme_sell_bars = 0
            for i in range(1, min_extreme_bars + 3):
                v = rsi_vals[-i] if len(rsi_vals) >= i and not np.isnan(rsi_vals[-i]) else None
                if v is None:
                    break
                if v < oversold:
                    extreme_buy_bars += 1
                if v > overbought:
                    extreme_sell_bars += 1

            price_reversed_up   = len(c) >= 2 and c[-1] > c[-2]
            price_reversed_down = len(c) >= 2 and c[-1] < c[-2]

            total_val = portfolio.totalValueUsd
            position = next((p for p in portfolio.positions if p.token == token), None)
            current_alloc = (position.currentValueUsd / total_val) if (position and total_val > 0) else 0.0

            # ── BUY: RSI oversold ──────────────────────────────────────────
            if (
                cur_rsi < oversold
                and extreme_buy_bars >= min_extreme_bars
                and (not require_reversal or price_reversed_up)
                and current_alloc < max_alloc_pct
            ):
                depth = (oversold - cur_rsi) / oversold  # 0→1 as RSI goes 0
                amount = base_amt + (max_amt - base_amt) * depth
                confidence = min(0.68 + depth * 0.22, 0.92)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"RSI Extreme BUY: RSI({rsi_period})={cur_rsi:.1f} < {oversold}, "
                        f"{extreme_buy_bars} extreme bars, reversal={price_reversed_up}"
                    ),
                    requires_ai_approval=False,
                ))

            # ── SELL: RSI overbought ───────────────────────────────────────
            elif (
                cur_rsi > overbought
                and extreme_sell_bars >= min_extreme_bars
                and (not require_reversal or price_reversed_down)
                and position is not None
                and position.currentValueUsd > 10
            ):
                height = (cur_rsi - overbought) / (100 - overbought)
                sell_usd = position.currentValueUsd * sell_pct
                confidence = min(0.68 + height * 0.22, 0.92)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"RSI Extreme SELL: RSI({rsi_period})={cur_rsi:.1f} > {overbought}, "
                        f"{extreme_sell_bars} extreme bars, reversal={price_reversed_down}"
                    ),
                    requires_ai_approval=False,
                ))

        return signals
