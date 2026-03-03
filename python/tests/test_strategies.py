"""Basic smoke tests for the strategy engine."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from datetime import datetime, timezone
from models.market import MarketSnapshot, TokenMarketData, PortfolioState, Candle
from strategies.dca import TrendDCAStrategy
from strategies.limit_order import LimitOrderStrategy
from strategies.trend_swap import TrendSwapStrategy
from risk.manager import RiskManager, RiskLimits


def make_candles(count: int = 30, trend: str = "up") -> list[Candle]:
    """Generate synthetic candles with realistic noise so RSI stays in range."""
    import math
    candles = []
    price = 580.0
    for i in range(count):
        # Add oscillation to avoid RSI saturation: sine wave ±0.3% on top of trend
        noise = math.sin(i * 0.8) * 0.003
        if trend == "up":
            price *= (1.001 + noise)
        elif trend == "down":
            price *= (0.999 + noise)
        else:
            price *= (1.0 + noise)
        candles.append(Candle(
            timestamp=datetime.now(timezone.utc).isoformat(),
            open=price * 0.999,
            high=price * 1.002,
            low=price * 0.997,
            close=price,
            volume=1_000_000 + i * 10_000,
        ))
    return candles


def make_snapshot(token="BNB", price: float | None = None, trend="up") -> MarketSnapshot:
    candles = make_candles(50, trend)
    # Use the last candle's close as the live price so it's consistent with EMA
    actual_price = price if price is not None else candles[-1].close
    return MarketSnapshot(
        timestamp=datetime.now(timezone.utc).isoformat(),
        cycleId="test-cycle",
        activeStrategies=["dca", "limit_orders", "trend_swap"],
        tokens={
            token: TokenMarketData(
                symbol=token,
                price=actual_price,
                change24h=0.032,
                volume24h=1_200_000_000,
                high24h=actual_price * 1.05,
                low24h=actual_price * 0.95,
                candles1h=candles,
                candles15m=candles[:25],
                timestamp=datetime.now(timezone.utc).isoformat(),
            )
        },
        portfolio=PortfolioState(
            walletAddress="0xtest",
            nativeBalance=2.0,
            stableBalance=500.0,
            positions=[],
            totalValueUsd=1700.0,
            dailyPnlUsd=10.0,
            timestamp=datetime.now(timezone.utc).isoformat(),
        ),
    )


def test_dca_uptrend():
    """DCA should generate BUY signal in uptrend."""
    strategy = TrendDCAStrategy({
        "id": "dca",
        "enabled": True,
        "tokens": {
            "BNB": {
                "enabled": True,
                "base_amount_usd": 25.0,
                "max_amount_usd": 100.0,
                "trend_multiplier": True,
                "min_rsi": 30,
                "max_rsi": 85,          # realistic upper bound; pure uptrend RSI ~75-80
                "ema_period": 20,
                "require_volume_increase": False,
            }
        },
        "trend_confirmation": {"require_above_ema": True, "min_trend_bars": 3, "min_confidence": 0.6},
    })
    snapshot = make_snapshot("BNB", trend="up")  # price auto-set to last candle close
    signals = strategy.generate_signals(snapshot, snapshot.portfolio)
    assert len(signals) > 0, "Expected BUY signal in uptrend"
    assert signals[0].action == "BUY"
    assert signals[0].token == "BNB"
    print(f"  DCA uptrend: PASS - {signals[0].rationale}")


def test_limit_order_trigger():
    """Limit order should trigger when price hits target."""
    strategy = LimitOrderStrategy({
        "id": "limit_orders",
        "enabled": True,
        "orders": [{
            "id": "test-buy",
            "token": "BNB",
            "action": "BUY",
            "target_price_usd": 600.0,
            "amount_usd": 50.0,
            "expires_at": "2027-01-01",
            "enabled": True,
        }],
        "execution": {"price_tolerance_pct": 1.0},
    })
    snapshot = make_snapshot("BNB", 599.5, "up")  # price below target
    signals = strategy.generate_signals(snapshot, snapshot.portfolio)
    assert len(signals) > 0, "Expected limit BUY to trigger"
    assert signals[0].action == "BUY"
    print(f"  Limit order: PASS - {signals[0].rationale}")


def test_risk_manager_daily_loss():
    """Risk manager should block trades when daily loss exceeded."""
    risk = RiskManager(RiskLimits(max_daily_loss_usd=100.0))
    from models.signal import Signal
    signal = Signal(
        strategy_id="dca",
        action="BUY",
        token="BNB",
        amount_usd=50.0,
        confidence=0.8,
        rationale="test",
    )
    portfolio = PortfolioState(
        walletAddress="0xtest",
        nativeBalance=1.0,
        stableBalance=100.0,
        positions=[],
        totalValueUsd=1000.0,
        dailyPnlUsd=-150.0,  # exceeds max_daily_loss
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    approved, reason = risk.check_pre_trade(signal, portfolio)
    assert not approved, "Risk manager should block trade on daily loss exceeded"
    print(f"  Risk daily loss: PASS - blocked: {reason}")


if __name__ == "__main__":
    print("Running strategy smoke tests...")
    test_dca_uptrend()
    test_limit_order_trigger()
    test_risk_manager_daily_loss()
    print("\nAll tests passed!")
