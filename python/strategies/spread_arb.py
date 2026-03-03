"""Spread arbitrage strategy — designed for high-frequency (5-minute cycle) seasons.

Monitors the price ratio between two correlated assets (default: ETH and cbBTC).
When the ratio deviates significantly from its short-term moving average,
it sells the relatively expensive one and buys the relatively cheap one.

Logic per cycle:
  - Compute ratio = price_A / price_B using the latest snapshot prices
  - Maintain a rolling mean of the ratio (via candles15m close prices as proxy)
  - If ratio is Z-score > threshold  → A is expensive vs B → SELL A / BUY B
  - If ratio is Z-score < -threshold → B is expensive vs A → SELL B / BUY A
  - Uses only current snapshot data (no external state), so safe with stateless engine
"""
from __future__ import annotations
import numpy as np
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from strategies.base import BaseStrategy


class SpreadArbStrategy(BaseStrategy):
    """High-frequency spread-mean-reversion between two correlated tokens."""

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        token_a   = self.config.get("token_a", "ETH")
        token_b   = self.config.get("token_b", "cbBTC")
        lookback  = self.config.get("indicators", {}).get("lookback_candles", 20)
        z_thresh  = self.config.get("signals", {}).get("z_score_threshold", 1.5)
        min_ratio_move = self.config.get("signals", {}).get("min_ratio_move_pct", 0.5) / 100

        trade_usd     = self.config.get("rules", {}).get("trade_amount_usd", 300.0)
        min_confidence= self.config.get("rules", {}).get("min_confidence", 0.65)
        max_alloc_pct = self.config.get("rules", {}).get("max_allocation_pct", 45) / 100

        if token_a not in snapshot.tokens or token_b not in snapshot.tokens:
            return signals

        mkt_a = snapshot.tokens[token_a]
        mkt_b = snapshot.tokens[token_b]

        price_a = mkt_a.price
        price_b = mkt_b.price
        if price_b == 0:
            return signals

        current_ratio = price_a / price_b

        # Build a ratio series from the shorter of the two 15m candle sets
        candles_a = mkt_a.candles15m if mkt_a.candles15m else mkt_a.candles1h
        candles_b = mkt_b.candles15m if mkt_b.candles15m else mkt_b.candles1h

        n = min(len(candles_a), len(candles_b), lookback)
        if n < 5:
            # Not enough history yet — still emit a signal based on 24h change spread
            # as a simple bootstrap fallback
            change_spread = mkt_a.change24h - mkt_b.change24h
            if abs(change_spread) < 2.0:
                return signals
            # A outperformed B by >2% → buy B, sell A (or vice versa)
            self._emit_rebalance(
                signals, token_a, token_b,
                buy_a=(change_spread < 0),
                confidence=0.65,
                trade_usd=trade_usd,
                portfolio=portfolio,
                max_alloc_pct=max_alloc_pct,
                rationale=f"Bootstrap spread: 24h change_spread={change_spread:+.2f}%",
            )
            return signals

        closes_a = np.array([c.close for c in candles_a[-n:]], dtype=float)
        closes_b = np.array([c.close for c in candles_b[-n:]], dtype=float)

        # Guard: avoid division by zero in ratio series
        safe_b = np.where(closes_b == 0, np.nan, closes_b)
        ratio_series = closes_a / safe_b
        valid = ratio_series[~np.isnan(ratio_series)]
        if len(valid) < 5:
            return signals

        ratio_mean = float(np.mean(valid))
        ratio_std  = float(np.std(valid, ddof=1))

        if ratio_std < 1e-12:
            return signals

        z_score = (current_ratio - ratio_mean) / ratio_std

        # Require minimum actual price movement, not just noise
        ratio_deviation = abs(current_ratio - ratio_mean) / ratio_mean
        if ratio_deviation < min_ratio_move:
            return signals

        abs_z = abs(z_score)
        if abs_z < z_thresh:
            return signals

        # Scale confidence with z-score (caps at 0.90)
        confidence = min(min_confidence + (abs_z - z_thresh) * 0.08, 0.90)

        if z_score > z_thresh:
            # A is expensive relative to B → sell A, buy B
            rationale = (
                f"SpreadArb: ratio={current_ratio:.4f} z={z_score:.2f} "
                f"(mean={ratio_mean:.4f}) → {token_a} overpriced vs {token_b}"
            )
            self._emit_rebalance(
                signals, token_a, token_b,
                buy_a=False,
                confidence=round(confidence, 3),
                trade_usd=trade_usd,
                portfolio=portfolio,
                max_alloc_pct=max_alloc_pct,
                rationale=rationale,
            )
        else:
            # B is expensive relative to A → sell B, buy A
            rationale = (
                f"SpreadArb: ratio={current_ratio:.4f} z={z_score:.2f} "
                f"(mean={ratio_mean:.4f}) → {token_b} overpriced vs {token_a}"
            )
            self._emit_rebalance(
                signals, token_a, token_b,
                buy_a=True,
                confidence=round(confidence, 3),
                trade_usd=trade_usd,
                portfolio=portfolio,
                max_alloc_pct=max_alloc_pct,
                rationale=rationale,
            )

        return signals

    def _emit_rebalance(
        self,
        signals: list[Signal],
        token_a: str,
        token_b: str,
        buy_a: bool,
        confidence: float,
        trade_usd: float,
        portfolio: PortfolioState,
        max_alloc_pct: float,
        rationale: str,
    ) -> None:
        total = portfolio.totalValueUsd
        buy_token  = token_a if buy_a else token_b
        sell_token = token_b if buy_a else token_a

        # BUY side — only if under allocation cap
        buy_pos = next((p for p in portfolio.positions if p.token == buy_token), None)
        buy_alloc = (buy_pos.currentValueUsd / total) if (buy_pos and total > 0) else 0.0
        if buy_alloc < max_alloc_pct:
            signals.append(Signal(
                strategy_id=self.id,
                action="BUY",
                token=buy_token,
                amount_usd=round(trade_usd, 2),
                confidence=confidence,
                rationale=rationale,
                requires_ai_approval=False,
            ))

        # SELL side — only if we hold a position
        sell_pos = next((p for p in portfolio.positions if p.token == sell_token), None)
        if sell_pos and sell_pos.currentValueUsd > 10:
            sell_usd = min(trade_usd, sell_pos.currentValueUsd * 0.5)
            signals.append(Signal(
                strategy_id=self.id,
                action="SELL",
                token=sell_token,
                amount_usd=round(sell_usd, 2),
                confidence=confidence,
                rationale=rationale,
                requires_ai_approval=False,
            ))
