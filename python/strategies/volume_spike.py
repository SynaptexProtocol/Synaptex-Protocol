"""Volume spike momentum strategy.

A sudden volume spike (≥ N× the recent average) with a clear price direction
is a strong short-term signal.  On 15m candles this resolves within 1-3 bars,
making it ideal for 5-minute polling sessions.

Logic:
  - volume_spike: current bar volume > avg(last lookback bars) × spike_multiplier
  - direction confirmed by: close > open (bullish spike) or close < open (bearish)
  - Additional filter: price moved by >= min_move_pct in the spike bar
  - Scales amount with spike magnitude (how many × above average)
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from signals.technical import closes, volumes, rsi
from strategies.base import BaseStrategy


class VolumeSpikeStrategy(BaseStrategy):

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        vol_lookback   = self.config.get("indicators", {}).get("volume_lookback", 10)
        rsi_period     = self.config.get("indicators", {}).get("rsi_period", 7)

        spike_mult     = self.config.get("signals", {}).get("spike_multiplier", 2.0)
        min_move_pct   = self.config.get("signals", {}).get("min_move_pct", 0.2) / 100
        rsi_max_buy    = self.config.get("signals", {}).get("rsi_max_buy", 75)
        rsi_min_sell   = self.config.get("signals", {}).get("rsi_min_sell", 25)

        base_amt       = self.config.get("rules", {}).get("base_amount_usd", 200.0)
        max_amt        = self.config.get("rules", {}).get("max_amount_usd", 600.0)
        sell_pct       = self.config.get("rules", {}).get("sell_pct_of_position", 50) / 100
        max_alloc_pct  = self.config.get("rules", {}).get("max_allocation_pct", 40) / 100

        min_candles = vol_lookback + rsi_period + 2

        for token in self.config.get("tokens", []):
            if token not in snapshot.tokens:
                continue
            mkt = snapshot.tokens[token]
            candles = mkt.candles15m if len(mkt.candles15m) >= min_candles else mkt.candles1h
            if len(candles) < min_candles:
                continue

            c = closes(candles)
            vols = volumes(candles)
            rsi_vals = rsi(c, rsi_period)

            cur_vol  = float(vols[-1])
            cur_rsi  = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else None
            if cur_rsi is None or cur_vol == 0:
                continue

            avg_vol = float(np.mean(vols[-vol_lookback - 1: -1]))
            if avg_vol == 0:
                continue

            spike_ratio = cur_vol / avg_vol
            if spike_ratio < spike_mult:
                continue  # not a spike

            last_candle = candles[-1]
            bar_move = abs(last_candle.close - last_candle.open) / last_candle.open if last_candle.open else 0
            if bar_move < min_move_pct:
                continue  # high volume but no price movement (indecision)

            bullish_bar = last_candle.close > last_candle.open
            bearish_bar = last_candle.close < last_candle.open

            total_val = portfolio.totalValueUsd
            position = next((p for p in portfolio.positions if p.token == token), None)
            current_alloc = (position.currentValueUsd / total_val) if (position and total_val > 0) else 0.0

            # Scale amount: 2× spike = base, 5× spike = max
            size_factor = min((spike_ratio - spike_mult) / (spike_mult * 1.5), 1.0)
            amount = base_amt + (max_amt - base_amt) * size_factor
            confidence = min(0.68 + size_factor * 0.22, 0.92)

            # ── BUY: bullish volume spike ──────────────────────────────────
            if bullish_bar and cur_rsi < rsi_max_buy and current_alloc < max_alloc_pct:
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=round(amount, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"VolumeSpike BUY: vol={spike_ratio:.1f}× avg, "
                        f"bar_move={bar_move*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

            # ── SELL: bearish volume spike ─────────────────────────────────
            elif bearish_bar and cur_rsi > rsi_min_sell and position and position.currentValueUsd > 10:
                sell_usd = position.currentValueUsd * sell_pct
                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=round(sell_usd, 2),
                    confidence=round(confidence, 3),
                    rationale=(
                        f"VolumeSpike SELL: vol={spike_ratio:.1f}× avg, "
                        f"bar_move={bar_move*100:.2f}%, RSI={cur_rsi:.1f}"
                    ),
                    requires_ai_approval=False,
                ))

        return signals
