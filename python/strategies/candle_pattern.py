"""Candle pattern recognition strategy — hammer, engulfing, doji.

Pure price-action patterns on 15m candles.  These work on any timeframe
but are particularly useful for short sessions where indicator-based
strategies lack enough bars to warm up.

Patterns detected:
  - Bullish Hammer:      small body near top, long lower wick (≥2× body)
  - Bullish Engulfing:   current bullish bar completely engulfs previous bearish bar
  - Bearish Shooting Star: small body near bottom, long upper wick
  - Bearish Engulfing:   current bearish bar completely engulfs previous bullish bar
  - Doji near support:   open ≈ close (indecision), followed by directional move
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, atr
from strategies.base import BaseStrategy


def _body(candle) -> float:         # type: ignore[return]
    return abs(candle.close - candle.open)

def _upper_wick(candle) -> float:   # type: ignore[return]
    return candle.high - max(candle.close, candle.open)

def _lower_wick(candle) -> float:   # type: ignore[return]
    return min(candle.close, candle.open) - candle.low

def _range(candle) -> float:        # type: ignore[return]
    return candle.high - candle.low if candle.high != candle.low else 1e-9


class CandlePatternStrategy(BaseStrategy):

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        rsi_period       = self.config.get("indicators", {}).get("rsi_period", 7)
        atr_period       = self.config.get("indicators", {}).get("atr_period", 7)

        wick_ratio       = self.config.get("signals", {}).get("min_wick_body_ratio", 2.0)
        engulf_margin    = self.config.get("signals", {}).get("engulfing_margin_pct", 0.0) / 100
        doji_max_body    = self.config.get("signals", {}).get("doji_max_body_pct", 0.1) / 100
        rsi_max_buy      = self.config.get("signals", {}).get("rsi_max_buy", 70)
        rsi_min_sell     = self.config.get("signals", {}).get("rsi_min_sell", 30)

        base_amt         = self.config.get("rules", {}).get("base_amount_usd", 180.0)
        max_amt          = self.config.get("rules", {}).get("max_amount_usd", 450.0)
        sell_pct         = self.config.get("rules", {}).get("sell_pct_of_position", 45) / 100
        max_alloc_pct    = self.config.get("rules", {}).get("max_allocation_pct", 40) / 100

        min_candles = max(rsi_period, atr_period) + 3

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
            if cur_atr / mkt.price < 0.001:
                continue

            cur = candles[-1]
            prev = candles[-2]

            body_cur   = _body(cur)
            range_cur  = _range(cur)
            upper_cur  = _upper_wick(cur)
            lower_cur  = _lower_wick(cur)
            body_prev  = _body(prev)

            total_val = portfolio.totalValueUsd
            position = next((p for p in portfolio.positions if p.token == token), None)
            current_alloc = (position.currentValueUsd / total_val) if (position and total_val > 0) else 0.0

            pattern_name = None
            is_bullish   = False

            # ── Bullish Hammer ─────────────────────────────────────────────
            # Small body in upper third, long lower wick ≥ wick_ratio × body
            if (
                body_cur > 0
                and lower_cur >= wick_ratio * body_cur
                and upper_cur <= 0.3 * range_cur
                and cur.close > cur.open  # green bar
            ):
                pattern_name = "Hammer"
                is_bullish   = True

            # ── Bullish Engulfing ──────────────────────────────────────────
            elif (
                cur.close > cur.open          # current is green
                and prev.close < prev.open    # previous is red
                and cur.open <= prev.close * (1 + engulf_margin)
                and cur.close >= prev.open * (1 - engulf_margin)
            ):
                pattern_name = "BullEngulf"
                is_bullish   = True

            # ── Bearish Shooting Star ──────────────────────────────────────
            elif (
                body_cur > 0
                and upper_cur >= wick_ratio * body_cur
                and lower_cur <= 0.3 * range_cur
                and cur.close < cur.open  # red bar
            ):
                pattern_name = "ShootingStar"
                is_bullish   = False

            # ── Bearish Engulfing ──────────────────────────────────────────
            elif (
                cur.close < cur.open          # current is red
                and prev.close > prev.open    # previous is green
                and cur.open >= prev.close * (1 - engulf_margin)
                and cur.close <= prev.open * (1 + engulf_margin)
            ):
                pattern_name = "BearEngulf"
                is_bullish   = False

            # ── Doji (indecision followed by confirmation) ─────────────────
            elif body_cur / range_cur < doji_max_body:
                # Doji itself is neutral; look at previous bar for context
                if prev.close < prev.open:  # previous was bearish → doji = reversal signal → BUY
                    pattern_name = "DojiBullRev"
                    is_bullish   = True
                elif prev.close > prev.open:  # previous was bullish → doji = reversal → SELL
                    pattern_name = "DojiBearRev"
                    is_bullish   = False

            if pattern_name is None:
                continue

            # ATR-scaled confidence boost
            atr_boost = min(cur_atr / mkt.price / 0.01, 0.15)
            confidence = round(min(0.68 + atr_boost, 0.88), 3)

            # ── Emit signal ────────────────────────────────────────────────
            if is_bullish and cur_rsi < rsi_max_buy and current_alloc < max_alloc_pct:
                amount = base_amt + (max_amt - base_amt) * min(body_cur / (cur_atr + 1e-9), 1.0)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=confidence,
                    rationale=(
                        f"CandlePattern BUY [{pattern_name}]: "
                        f"open={cur.open:.4f} close={cur.close:.4f}, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))
            elif not is_bullish and cur_rsi > rsi_min_sell and position and position.currentValueUsd > 10:
                sell_usd = position.currentValueUsd * sell_pct
                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=confidence,
                    rationale=(
                        f"CandlePattern SELL [{pattern_name}]: "
                        f"open={cur.open:.4f} close={cur.close:.4f}, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

        return signals
