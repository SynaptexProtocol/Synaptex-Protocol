#!/usr/bin/env python3
import json
import sys


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"signals": []}))
        return 0

    try:
        payload = json.loads(raw)
    except Exception:
        print(json.dumps({"signals": []}))
        return 0

    tokens = payload.get("snapshot", {}).get("tokens", {})
    eth = tokens.get("ETH", {})
    change = float(eth.get("change24h", 0) or 0)

    signals = []
    if change > 0.01:
        signals.append({
            "action": "BUY",
            "token": "ETH",
            "amount_usd": 100,
            "confidence": 0.7,
            "reason": "mock stdio momentum long",
        })
    elif change < -0.01:
        signals.append({
            "action": "SELL",
            "token": "ETH",
            "amount_usd": 100,
            "confidence": 0.7,
            "reason": "mock stdio momentum short",
        })

    print(json.dumps({
        "schema_version": "2.0",
        "signals": signals,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

