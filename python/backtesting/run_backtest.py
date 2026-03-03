"""
Backtesting engine for BNB Trading Agent strategies.

Usage:
    python python/backtesting/run_backtest.py --strategy dca --token BNB --days 90
    python python/backtesting/run_backtest.py --strategy trend_swap --token BNB --days 60
    python python/backtesting/run_backtest.py --strategy all --token BNB --days 90 --report
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from backtesting.data_feed import fetch_candles_rest, load_candles_file
from backtesting.engine import BacktestEngine
from backtesting.report import print_report, save_report


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest trading strategies on historical data")
    parser.add_argument("--strategy", default="dca",
                        choices=["dca", "trend_swap", "limit_orders", "all"],
                        help="Strategy to backtest")
    parser.add_argument("--token",   default="BNB",  help="Token symbol (e.g. BNB)")
    parser.add_argument("--days",    type=int, default=90, help="Lookback days")
    parser.add_argument("--capital", type=float, default=1000.0, help="Initial USDT capital")
    parser.add_argument("--config",  default="config/agent.yaml", help="Agent config path")
    parser.add_argument("--candles-file", default=None,
                        help="Load candles from JSON file instead of API (for offline use)")
    parser.add_argument("--report",  action="store_true", help="Save HTML report to logs/")
    parser.add_argument("--output",  default=None, help="Save results to JSON file")
    args = parser.parse_args()

    print(f"[backtest] strategy={args.strategy}  token={args.token}  days={args.days}  capital=${args.capital:.0f}")

    # Load candle data
    if args.candles_file:
        print(f"[backtest] loading candles from {args.candles_file}")
        candles_1h = load_candles_file(args.candles_file)
    else:
        print(f"[backtest] fetching {args.days}d of 1h candles from Crypto.com REST…")
        candles_1h = fetch_candles_rest(args.token, timeframe="1h", days=args.days)

    if len(candles_1h) < 50:
        print(f"[backtest] ERROR: not enough candles ({len(candles_1h)}), need ≥50")
        sys.exit(1)

    print(f"[backtest] loaded {len(candles_1h)} candles  "
          f"({candles_1h[0].timestamp[:10]} → {candles_1h[-1].timestamp[:10]})")

    # Determine which strategies to run
    config_dir = Path(args.config).parent
    strategies_to_run = (
        ["dca", "trend_swap", "limit_orders"] if args.strategy == "all" else [args.strategy]
    )

    all_results = {}
    for strat_name in strategies_to_run:
        cfg_path = config_dir / "strategies" / f"{strat_name}.yaml"
        if not cfg_path.exists():
            print(f"[backtest] skipping {strat_name}: config not found at {cfg_path}")
            continue

        print(f"\n[backtest] running {strat_name}…")
        engine = BacktestEngine(
            strategy_name=strat_name,
            strategy_config_path=str(cfg_path),
            token=args.token,
            initial_capital=args.capital,
        )
        result = engine.run(candles_1h)
        all_results[strat_name] = result
        print_report(result, strat_name, args.token)

    # Save outputs
    if args.output:
        out = {k: v.to_dict() for k, v in all_results.items()}
        Path(args.output).write_text(json.dumps(out, indent=2))
        print(f"\n[backtest] results saved to {args.output}")

    if args.report:
        log_dir = Path("logs")
        log_dir.mkdir(exist_ok=True)
        for strat_name, result in all_results.items():
            html_path = log_dir / f"backtest_{strat_name}_{args.token}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M')}.html"
            save_report(result, strat_name, args.token, str(html_path))
            print(f"[backtest] HTML report saved to {html_path}")


if __name__ == "__main__":
    main()
