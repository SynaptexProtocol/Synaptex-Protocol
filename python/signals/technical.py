"""Technical indicator calculations using plain numpy for speed."""
from __future__ import annotations
import numpy as np
from models.market import Candle


def closes(candles: list[Candle]) -> np.ndarray:
    return np.array([c.close for c in candles], dtype=float)


def volumes(candles: list[Candle]) -> np.ndarray:
    return np.array([c.volume for c in candles], dtype=float)


def ema(values: np.ndarray, period: int) -> np.ndarray:
    """Exponential moving average."""
    result = np.full_like(values, np.nan)
    if len(values) < period:
        return result
    k = 2.0 / (period + 1)
    result[period - 1] = np.mean(values[:period])
    for i in range(period, len(values)):
        result[i] = values[i] * k + result[i - 1] * (1 - k)
    return result


def sma(values: np.ndarray, period: int) -> np.ndarray:
    result = np.full_like(values, np.nan)
    for i in range(period - 1, len(values)):
        result[i] = np.mean(values[i - period + 1 : i + 1])
    return result


def rsi(values: np.ndarray, period: int = 14) -> np.ndarray:
    result = np.full_like(values, np.nan)
    if len(values) < period + 1:
        return result
    deltas = np.diff(values)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            result[i + 1] = 100.0
        else:
            rs = avg_gain / avg_loss
            result[i + 1] = 100.0 - 100.0 / (1.0 + rs)
    return result


def ema_crossover(fast: np.ndarray, slow: np.ndarray) -> tuple[bool, bool]:
    """Returns (golden_cross, death_cross) at the latest bar."""
    if len(fast) < 2 or len(slow) < 2:
        return False, False
    # Both current and previous must be valid
    if np.isnan(fast[-1]) or np.isnan(slow[-1]) or np.isnan(fast[-2]) or np.isnan(slow[-2]):
        return False, False
    was_below = fast[-2] < slow[-2]
    is_above = fast[-1] > slow[-1]
    was_above = fast[-2] > slow[-2]
    is_below = fast[-1] < slow[-1]
    return (was_below and is_above), (was_above and is_below)


def volume_above_avg(candles: list[Candle], lookback: int, multiplier: float = 1.3) -> bool:
    vols = volumes(candles)
    if len(vols) < lookback + 1:
        return False
    avg = np.mean(vols[-lookback - 1 : -1])
    return float(vols[-1]) > avg * multiplier


def bollinger_bands(
    values: np.ndarray, period: int = 20, std_dev: float = 2.0
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (upper, middle, lower) Bollinger Bands."""
    middle = sma(values, period)
    upper = np.full_like(values, np.nan)
    lower = np.full_like(values, np.nan)
    for i in range(period - 1, len(values)):
        std = np.std(values[i - period + 1 : i + 1], ddof=0)
        upper[i] = middle[i] + std_dev * std
        lower[i] = middle[i] - std_dev * std
    return upper, middle, lower


def macd(
    values: np.ndarray,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Returns (macd_line, signal_line, histogram)."""
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def atr(candles: list[Candle], period: int = 14) -> np.ndarray:
    """Average True Range."""
    n = len(candles)
    tr = np.full(n, np.nan)
    for i in range(1, n):
        high = candles[i].high
        low = candles[i].low
        prev_close = candles[i - 1].close
        tr[i] = max(high - low, abs(high - prev_close), abs(low - prev_close))
    result = np.full(n, np.nan)
    if n < period + 1:
        return result
    result[period] = np.mean(tr[1 : period + 1])
    for i in range(period + 1, n):
        result[i] = (result[i - 1] * (period - 1) + tr[i]) / period
    return result


def percent_b(values: np.ndarray, period: int = 20, std_dev: float = 2.0) -> np.ndarray:
    """Bollinger %B: position of price within the bands (0=lower, 1=upper)."""
    upper, middle, lower = bollinger_bands(values, period, std_dev)
    result = np.full_like(values, np.nan)
    for i in range(len(values)):
        band_width = upper[i] - lower[i]
        if not np.isnan(band_width) and band_width > 0:
            result[i] = (values[i] - lower[i]) / band_width
    return result


def rsi_divergence(
    candles: list[Candle], rsi_vals: np.ndarray, lookback: int = 14
) -> tuple[bool, bool]:
    """
    Detect RSI divergence over last `lookback` bars.
    Returns (bullish_divergence, bearish_divergence).
    Bullish:  price makes lower low, RSI makes higher low  → BUY
    Bearish:  price makes higher high, RSI makes lower high → SELL
    """
    if len(candles) < lookback + 1:
        return False, False

    prices = np.array([c.close for c in candles])
    recent_prices = prices[-lookback:]
    recent_rsi = rsi_vals[-lookback:]

    valid = ~np.isnan(recent_rsi)
    if valid.sum() < lookback // 2:
        return False, False

    price_low_idx = int(np.argmin(recent_prices))
    price_high_idx = int(np.argmax(recent_prices))

    # Bullish: last bar price near low AND RSI higher than at that low
    last_price = recent_prices[-1]
    last_rsi = recent_rsi[-1]
    price_at_low = recent_prices[price_low_idx]
    rsi_at_low = recent_rsi[price_low_idx]

    bullish = (
        not np.isnan(last_rsi)
        and not np.isnan(rsi_at_low)
        and last_price <= price_at_low * 1.005   # price near/below prior low
        and last_rsi > rsi_at_low + 3            # RSI meaningfully higher
    )

    # Bearish: last bar price near high AND RSI lower than at that high
    price_at_high = recent_prices[price_high_idx]
    rsi_at_high = recent_rsi[price_high_idx]

    bearish = (
        not np.isnan(last_rsi)
        and not np.isnan(rsi_at_high)
        and last_price >= price_at_high * 0.995  # price near/above prior high
        and last_rsi < rsi_at_high - 3           # RSI meaningfully lower
    )

    return bullish, bearish
