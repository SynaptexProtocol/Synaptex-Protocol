"""Abstract base class for all trading strategies."""
from __future__ import annotations
from abc import ABC, abstractmethod
from models.market import MarketSnapshot, PortfolioState
from models.signal import Signal


class BaseStrategy(ABC):
    def __init__(self, config: dict) -> None:
        self.config = config
        self.id: str = config["id"]
        self.enabled: bool = config.get("enabled", True)

    @abstractmethod
    def generate_signals(
        self,
        snapshot: MarketSnapshot,
        portfolio: PortfolioState,
    ) -> list[Signal]:
        """Core strategy logic. Must return a list of Signal objects."""
        ...

    def validate_config(self) -> bool:
        return True
