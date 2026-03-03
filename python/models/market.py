from __future__ import annotations
from typing import Any
from pydantic import BaseModel


class Candle(BaseModel):
    timestamp: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class OrderBookLevel(BaseModel):
    price: float
    size: float


class OrderBook(BaseModel):
    bids: list[OrderBookLevel]
    asks: list[OrderBookLevel]
    timestamp: str


class TokenMarketData(BaseModel):
    symbol: str
    price: float
    change24h: float
    volume24h: float
    high24h: float
    low24h: float
    candles1h: list[Candle] = []
    candles15m: list[Candle] = []
    orderBook: OrderBook | None = None
    timestamp: str


class PortfolioPosition(BaseModel):
    token: str
    amount: float
    avgCostUsd: float
    currentValueUsd: float


class PortfolioState(BaseModel):
    walletAddress: str
    nativeBalance: float
    stableBalance: float
    positions: list[PortfolioPosition] = []
    totalValueUsd: float
    dailyPnlUsd: float
    timestamp: str


class MarketSnapshot(BaseModel):
    timestamp: str
    tokens: dict[str, TokenMarketData]
    portfolio: PortfolioState
    activeStrategies: list[str]
    strategyWeights: dict[str, float] | None = None
    cycleId: str
