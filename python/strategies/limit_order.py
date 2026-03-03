"""Limit order strategy.

Monitors target prices from config and fires BUY/SELL signals
when the current price crosses the target within tolerance.
"""
from __future__ import annotations
from datetime import datetime, timezone
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from strategies.base import BaseStrategy


class LimitOrderStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []
        now = datetime.now(timezone.utc)
        tolerance_pct = self.config.get("execution", {}).get("price_tolerance_pct", 0.5) / 100

        for order in self.config.get("orders", []):
            if not order.get("enabled", True):
                continue

            expires_at = datetime.fromisoformat(order["expires_at"]).replace(tzinfo=timezone.utc)
            if now > expires_at:
                continue

            token = order["token"]
            if token not in snapshot.tokens:
                continue

            mkt = snapshot.tokens[token]
            target = float(order["target_price_usd"])
            action = order["action"]

            in_range = abs(mkt.price - target) / target <= tolerance_pct

            if action == "BUY" and mkt.price <= target and in_range:
                signals.append(Signal(
                    strategy_id=self.id,
                    action="BUY",
                    token=token,
                    amount_usd=float(order["amount_usd"]),
                    target_price=target,
                    confidence=0.9,
                    rationale=f"Limit buy triggered: price={mkt.price:.4f} <= target={target:.4f}",
                    requires_ai_approval=False,
                ))
            elif action == "SELL" and mkt.price >= target and in_range:
                signals.append(Signal(
                    strategy_id=self.id,
                    action="SELL",
                    token=token,
                    amount_usd=float(order["amount_usd"]),
                    target_price=target,
                    confidence=0.9,
                    rationale=f"Limit sell triggered: price={mkt.price:.4f} >= target={target:.4f}",
                    requires_ai_approval=False,
                ))

        return signals
