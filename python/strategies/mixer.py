"""Weighted strategy mixer for Arena agents.

Each Arena agent runs multiple strategies simultaneously with configured weights.
Signals from different strategies are merged:
  - Same token + same action  → confidence weighted average, amounts summed (capped)
  - Same token + opposite actions → higher confidence wins, lower discarded
  - Different tokens → passed through independently
"""
from __future__ import annotations
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from strategies.base import BaseStrategy


class WeightedStrategyMixer:
    """
    Runs N strategies with per-strategy weights and merges their signals.

    Usage:
        mixer = WeightedStrategyMixer([
            (dca_strategy, 0.4),
            (trend_swap_strategy, 0.6),
        ])
        signals = mixer.generate_signals(snapshot, portfolio)
    """

    def __init__(self, weighted_strategies: list[tuple[BaseStrategy, float]]) -> None:
        total = sum(w for _, w in weighted_strategies)
        if total <= 0:
            raise ValueError("Total strategy weight must be > 0")
        # Normalise weights to sum to 1.0
        self.strategies: list[tuple[BaseStrategy, float]] = [
            (s, w / total) for s, w in weighted_strategies
        ]

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        # Collect all signals with their strategy weight
        weighted_signals: list[tuple[Signal, float]] = []
        for strategy, weight in self.strategies:
            if not strategy.enabled:
                continue
            try:
                sigs = strategy.generate_signals(snapshot, portfolio)
                for sig in sigs:
                    weighted_signals.append((sig, weight))
            except Exception as e:
                print(f"[mixer] strategy {strategy.id} error: {e}")

        if not weighted_signals:
            return []

        return self._merge(weighted_signals)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _merge(self, weighted: list[tuple[Signal, float]]) -> list[Signal]:
        # Group by (token, action)
        groups: dict[tuple[str, str], list[tuple[Signal, float]]] = {}
        for sig, w in weighted:
            key = (sig.token, sig.action)
            groups.setdefault(key, []).append((sig, w))

        # Detect conflicts: same token, opposite actions
        tokens_with_buy: set[str] = {t for t, a in groups if a == "BUY"}
        tokens_with_sell: set[str] = {t for t, a in groups if a == "SELL"}
        conflicted = tokens_with_buy & tokens_with_sell

        merged: list[Signal] = []

        for (token, action), items in groups.items():
            if token in conflicted:
                # Resolve conflict: keep the side with higher total weighted confidence
                buy_score = sum(
                    sig.confidence * w
                    for sig, w in groups.get((token, "BUY"), [])
                )
                sell_score = sum(
                    sig.confidence * w
                    for sig, w in groups.get((token, "SELL"), [])
                )
                winning_action = "BUY" if buy_score >= sell_score else "SELL"
                if action != winning_action:
                    continue  # discard the losing side

            merged_sig = self._combine(token, action, items)
            if merged_sig:
                merged.append(merged_sig)

        return merged

    def _combine(
        self,
        token: str,
        action: str,
        items: list[tuple[Signal, float]],
    ) -> Signal | None:
        if not items:
            return None

        # Weighted average confidence
        total_weight = sum(w for _, w in items)
        weighted_conf = sum(sig.confidence * w for sig, w in items) / total_weight

        # Sum amounts (each strategy contributes weight × its amount)
        total_amount: float | None = None
        amounts = [(sig.amount_usd, w) for sig, w in items if sig.amount_usd is not None]
        if amounts:
            total_amount = sum(amt * w for amt, w in amounts) / sum(w for _, w in amounts)
            # Scale by number of strategies agreeing (more agreement = larger position)
            agreement_factor = min(len(amounts) / len(self.strategies) * 1.5, 1.0)
            total_amount *= agreement_factor
            total_amount = round(total_amount, 2)

        # Requires AI approval if any contributing strategy requests it
        requires_ai = any(sig.requires_ai_approval for sig, _ in items)

        # Combine rationales
        rationales = [
            f"[{sig.strategy_id} w={w:.2f}] {sig.rationale}"
            for sig, w in items
        ]
        combined_rationale = " | ".join(rationales)

        # Use the first signal as base (for target_price etc.)
        base_sig = items[0][0]

        return Signal(
            strategy_id=f"mixer({'+'.join(sig.strategy_id for sig, _ in items)})",
            action=action,  # type: ignore[arg-type]
            token=token,
            amount_usd=total_amount,
            target_price=base_sig.target_price,
            confidence=round(weighted_conf, 3),
            rationale=combined_rationale,
            requires_ai_approval=requires_ai or weighted_conf < 0.70,
        )
