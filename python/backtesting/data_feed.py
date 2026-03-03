"""
Historical candle data feed for backtesting.

Sources:
  1. Crypto.com public REST API  (live fetch, no API key needed)
  2. Local JSON file             (for offline / reproducible runs)

Note on Crypto.com REST v1:
  The public/get-candlestick endpoint returns at most ~300 recent candles.
  It does NOT support start_ts/end_ts pagination.
  Supported instruments: ETHUSD, BTCUSD, SOLUSD, etc.
  cbBTC uses BTCUSD as it tracks BTC price 1:1.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from models.market import Candle


_REST_BASE  = "https://api.crypto.com/v2"   # v2 public API (works without API key)
_TIMEFRAMES = {"1h", "15m", "5m", "1d"}
_MAX_BARS   = 300  # approximate API cap

# cbBTC uses BTCUSD as it tracks BTC price 1:1.
# v2 API uses underscore-separated pairs: ETH_USDT, BTC_USDT, etc.
_INSTRUMENT: dict[str, str] = {
    "ETH":   "ETH_USDT",
    "cbBTC": "BTC_USDT",
    "BTC":   "BTC_USDT",
    "USDC":  "ETH_USDT",   # proxy for stable (no USDC candles)
    "SOL":   "SOL_USDT",
    "DOGE":  "DOGE_USDT",
    "ADA":   "ADA_USDT",
    "XRP":   "XRP_USDT",
}


def fetch_candles_rest(
    token: str,
    timeframe: str = "1h",
    days: int = 90,
    max_retries: int = 3,
) -> list[Candle]:
    """
    Fetch the most recent historical OHLCV candles from Crypto.com.

    Returns up to 300 bars (API hard cap). For longer backtests save candles
    to a file with save_candles_file() and reload with load_candles_file().
    """
    if timeframe not in _TIMEFRAMES:
        raise ValueError(f"Unsupported timeframe '{timeframe}'. Choose from {_TIMEFRAMES}")

    instrument  = _INSTRUMENT.get(token.upper(), f"{token.upper()}USD")
    interval_s  = _timeframe_to_ms(timeframe) // 1000
    bars_needed = min(int(days * 86400 / interval_s), _MAX_BARS)

    if token.upper() in ("CBBTC",):
        print(f"[data_feed] Note: {token} uses BTC_USDT data for backtesting")

    url = (
        f"{_REST_BASE}/public/get-candlestick"
        f"?instrument_name={instrument}"
        f"&timeframe={timeframe}"
    )

    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            resp = requests.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            last_err = None
            break
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(1.5 * (attempt + 1))

    if last_err:
        raise RuntimeError(
            f"Failed to fetch candles after {max_retries} attempts: {last_err}"
        ) from last_err

    # v1 wraps data in result.data
    raw = (data.get("result") or {}).get("data") or data.get("data") or []

    candles: list[Candle] = []
    for c in raw:
        ts = c.get("t") or c.get("timestamp")
        if isinstance(ts, int):
            ts = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
        candles.append(Candle(
            timestamp = ts,
            open      = float(c.get("o") or c.get("open")),
            high      = float(c.get("h") or c.get("high")),
            low       = float(c.get("l") or c.get("low")),
            close     = float(c.get("c") or c.get("close")),
            volume    = float(c.get("v") or c.get("volume")),
        ))

    candles.sort(key=lambda c: c.timestamp)
    return candles


def load_candles_file(path: str) -> list[Candle]:
    """Load candles from a JSON file (list of Candle dicts)."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    candles = [Candle(**item) for item in raw]
    candles.sort(key=lambda c: c.timestamp)
    return candles


def save_candles_file(candles: list[Candle], path: str) -> None:
    """Save candles to JSON for later offline / reproducible backtests."""
    Path(path).write_text(
        json.dumps([c.model_dump() for c in candles], indent=2),
        encoding="utf-8",
    )


def _timeframe_to_ms(timeframe: str) -> int:
    mapping = {
        "1m":  60_000,
        "5m":  300_000,
        "15m": 900_000,
        "1h":  3_600_000,
        "4h":  14_400_000,
        "1d":  86_400_000,
    }
    if timeframe not in mapping:
        raise ValueError(f"Unknown timeframe: {timeframe}")
    return mapping[timeframe]
