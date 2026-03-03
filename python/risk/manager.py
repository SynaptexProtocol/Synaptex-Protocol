"""Risk management: pre-trade checks and circuit breakers."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from models.signal import Signal
from models.market import PortfolioState


@dataclass
class RiskLimits:
    max_position_size_usd: float = 500.0
    max_total_exposure_usd: float = 3000.0
    max_daily_loss_usd: float = 150.0
    max_drawdown_pct: float = 15.0
    max_slippage_bps: float = 100.0
    cooldown_minutes: int = 5


class RiskManager:
    def __init__(self, limits: RiskLimits) -> None:
        self.limits = limits
        self._last_trade_time: dict[str, datetime] = {}

    def check_pre_trade(
        self,
        signal: Signal,
        portfolio: PortfolioState,
    ) -> tuple[bool, str]:
        """Returns (approved, reason). All signals must pass through here."""

        # 1. Position size check
        if signal.amount_usd and signal.amount_usd > self.limits.max_position_size_usd:
            return False, (
                f"Position size ${signal.amount_usd:.0f} exceeds limit "
                f"${self.limits.max_position_size_usd:.0f}"
            )

        # 2. Total exposure check (only for BUY signals)
        if signal.action == "BUY":
            invested = portfolio.totalValueUsd - portfolio.stableBalance
            projected = invested + (signal.amount_usd or 0)
            if projected > self.limits.max_total_exposure_usd:
                return False, (
                    f"Projected exposure ${projected:.0f} exceeds limit "
                    f"${self.limits.max_total_exposure_usd:.0f}"
                )

        # 3. Daily loss limit
        if portfolio.dailyPnlUsd < -self.limits.max_daily_loss_usd:
            return False, (
                f"Daily loss ${abs(portfolio.dailyPnlUsd):.0f} exceeds limit "
                f"${self.limits.max_daily_loss_usd:.0f}"
            )

        # 4. Cooldown check
        last = self._last_trade_time.get(signal.token)
        if last:
            elapsed = (datetime.now(timezone.utc) - last).total_seconds() / 60
            if elapsed < self.limits.cooldown_minutes:
                return False, (
                    f"Cooldown active for {signal.token}: "
                    f"{elapsed:.1f}m < {self.limits.cooldown_minutes}m"
                )

        return True, "approved"

    def record_trade(self, token: str) -> None:
        self._last_trade_time[token] = datetime.now(timezone.utc)
