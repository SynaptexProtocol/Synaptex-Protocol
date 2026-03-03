"""Market cap rebalancing strategy.

Compares actual portfolio allocation against target and generates
BUY/SELL signals to rebalance toward target percentages.
"""
from __future__ import annotations
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from strategies.base import BaseStrategy


class RebalanceStrategy(BaseStrategy):
    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []
        target_alloc: dict[str, float] = self.config.get("target_allocation", {})
        drift_threshold = self.config.get("rebalance_trigger", {}).get("drift_threshold_pct", 5.0)
        min_trade = self.config.get("rebalance_trigger", {}).get("min_trade_usd", 20.0)

        total = portfolio.totalValueUsd
        if total <= 0:
            return signals

        # Compute current allocation %
        current_alloc: dict[str, float] = {}
        # Native token (ETH on Base)
        eth_val = portfolio.nativeBalance * snapshot.tokens.get("ETH", snapshot.tokens.get(list(snapshot.tokens.keys())[0])).price if "ETH" in snapshot.tokens else 0
        current_alloc["ETH"] = eth_val / total * 100
        # Stable
        current_alloc["USDC"] = portfolio.stableBalance / total * 100
        # Positions
        for pos in portfolio.positions:
            current_alloc[pos.token] = pos.currentValueUsd / total * 100

        for token, target_pct in target_alloc.items():
            current_pct = current_alloc.get(token, 0.0)
            drift = current_pct - target_pct

            if abs(drift) < drift_threshold:
                continue

            trade_usd = abs(drift / 100) * total
            if trade_usd < min_trade:
                continue

            action = "SELL" if drift > 0 else "BUY"
            signals.append(Signal(
                strategy_id=self.id,
                action=action,  # type: ignore[arg-type]
                token=token,
                amount_usd=round(trade_usd, 2),
                confidence=0.75,
                rationale=(
                    f"Rebalance {token}: current={current_pct:.1f}% target={target_pct:.1f}% "
                    f"drift={drift:+.1f}%"
                ),
                requires_ai_approval=trade_usd > 200,
            ))

        return signals
