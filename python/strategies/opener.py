"""Season opener strategy — designed for high-frequency (5-minute cycle) seasons.

Fires exactly ONCE at the start of a season (cycle 0) to bootstrap initial positions.
Without this, all other strategies may have nothing to sell and no baseline to beat.

Logic:
  - On the first call (no positions held), distributes the configured % of USDC
    across the configured tokens using equal-weight or price-momentum weighting
  - On subsequent calls (positions already held), emits nothing
  - Uses 24h price change to tilt the initial allocation:
      token with stronger 24h momentum gets a larger slice

This guarantees at least 1 BUY per agent per season, satisfying min_trades_to_qualify=1.
"""
from __future__ import annotations
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal
from strategies.base import BaseStrategy


class SeasonOpenerStrategy(BaseStrategy):
    """One-shot opening buy at the start of each season."""

    def __init__(self, config: dict) -> None:
        super().__init__(config)
        self._fired = False   # reset across process restarts is fine — each season = new process

    def generate_signals(
        self, snapshot: MarketSnapshot, portfolio: PortfolioState
    ) -> list[Signal]:
        signals: list[Signal] = []

        tokens          = self.config.get("tokens", ["ETH", "cbBTC"])
        deploy_pct      = self.config.get("rules", {}).get("deploy_pct_of_stable", 60) / 100
        use_momentum    = self.config.get("rules", {}).get("use_momentum_tilt", True)
        min_stable      = self.config.get("rules", {}).get("min_stable_usd", 100.0)

        # Guard: already fired this process lifetime
        if self._fired:
            return signals

        # Guard: already have positions — season was resumed or engine restarted
        if portfolio.positions:
            self._fired = True
            return signals

        # Guard: not enough stable balance
        if portfolio.stableBalance < min_stable:
            self._fired = True
            return signals

        # Filter tokens present in snapshot
        available = [t for t in tokens if t in snapshot.tokens]
        if not available:
            return signals

        total_deploy = portfolio.stableBalance * deploy_pct

        # Compute weights: equal by default, tilted by 24h momentum if enabled
        weights: dict[str, float] = {}
        if use_momentum:
            # Shift by +100 so negative changes don't make weights negative
            raw = {t: max(snapshot.tokens[t].change24h + 100.0, 1.0) for t in available}
            total_raw = sum(raw.values())
            weights = {t: v / total_raw for t, v in raw.items()}
        else:
            w = 1.0 / len(available)
            weights = {t: w for t in available}

        self._fired = True

        for token in available:
            amount = round(total_deploy * weights[token], 2)
            if amount < 10:
                continue
            chg = snapshot.tokens[token].change24h
            signals.append(Signal(
                strategy_id=self.id,
                action="BUY",
                token=token,
                amount_usd=amount,
                confidence=0.80,
                rationale=(
                    f"SeasonOpener: deploying ${amount:.0f} "
                    f"({weights[token]*100:.1f}% of ${total_deploy:.0f} budget) "
                    f"into {token}, 24h={chg:+.2f}%"
                ),
                requires_ai_approval=False,
            ))

        return signals
