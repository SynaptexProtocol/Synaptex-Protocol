"""High/Low range breakout strategy.

Tracks the highest high and lowest low over the last N candles.
A close above/below that range with momentum confirmation signals
a breakout worth following.

Ideal for short sessions: even 8-10 candles define a tradeable range.

Logic:
  - Compute range: high = max(high[-lookback:]), low = min(low[-lookback:])
  - BUY  when: price closes above `high` by >= min_breakout_pct
  - SELL when: price closes below `low`  by >= min_breakout_pct
  - Confirm with: RSI not extreme in the wrong direction
  - Prevent false breakout: require bar range >= min_bar_range_pct (ATR-based)
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, rsi, atr
from strategies.base import BaseStrategy


class HiLoBreakoutStrategy(BaseStrategy):

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        lookback       = self.config.get("indicators", {}).get("lookback_candles", 8)
        rsi_period     = self.config.get("indicators", {}).get("rsi_period", 7)
        atr_period     = self.config.get("indicators", {}).get("atr_period", 7)

        min_breakout   = self.config.get("signals", {}).get("min_breakout_pct", 0.15) / 100
        rsi_max_buy    = self.config.get("signals", {}).get("rsi_max_buy", 78)
        rsi_min_sell   = self.config.get("signals", {}).get("rsi_min_sell", 22)

        base_amt       = self.config.get("rules", {}).get("base_amount_usd", 250.0)
        max_amt        = self.config.get("rules", {}).get("max_amount_usd", 650.0)
        sell_pct       = self.config.get("rules", {}).get("sell_pct_of_position", 50) / 100
        max_alloc_pct  = self.config.get("rules", {}).get("max_allocation_pct", 40) / 100

        min_candles = lookback + rsi_period + 2

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

            # Build range from the lookback window (exclude current bar)
            window = candles[-(lookback + 1):-1]
            if len(window) < lookback:
                continue

            range_high = max(b.high for b in window)
            range_low  = min(b.low  for b in window)

            price = mkt.price
            cur_candle = candles[-1]

            # How far did price break out?
            break_up   = (price - range_high) / range_high if price > range_high else 0.0
            break_down = (range_low - price)  / range_low  if price < range_low  else 0.0

            total_val = portfolio.totalValueUsd
            position = next((p for p in portfolio.positions if p.token == token), None)
            current_alloc = (position.currentValueUsd / total_val) if (position and total_val > 0) else 0.0

            # ── BUY: upside breakout ───────────────────────────────────────
            if break_up >= min_breakout and cur_rsi < rsi_max_buy and current_alloc < max_alloc_pct:
                strength = min(break_up / (min_breakout * 4), 1.0)
                amount = base_amt + (max_amt - base_amt) * strength
                confidence = min(0.70 + strength * 0.20, 0.92)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"HiLoBreakout BUY: price={price:.4f} broke range_high={range_high:.4f} "
                        f"by +{break_up*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

            # ── SELL: downside breakout ────────────────────────────────────
            elif break_down >= min_breakout and cur_rsi > rsi_min_sell and position and position.currentValueUsd > 10:
                strength = min(break_down / (min_breakout * 4), 1.0)
                sell_usd = position.currentValueUsd * sell_pct
                confidence = min(0.70 + strength * 0.20, 0.92)
                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"HiLoBreakout SELL: price={price:.4f} broke range_low={range_low:.4f} "
                        f"by -{break_down*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

        return signals
