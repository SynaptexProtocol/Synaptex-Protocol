"""Python process entry point."""
from __future__ import annotations
import asyncio
import argparse
import sys
import yaml
from pathlib import Path

from strategies import (
    TrendDCAStrategy, LimitOrderStrategy, RebalanceStrategy, TrendSwapStrategy,
    MeanReversionStrategy, MomentumStrategy, RSIDivergenceStrategy,
    PriceChangeStrategy, SpreadArbStrategy, SeasonOpenerStrategy,
    VolatilityScalpStrategy, RsiExtremeStrategy, VolumeSpikeStrategy,
    CandlePatternStrategy, HiLoBreakoutStrategy, TakeProfitStrategy,
    load_plugin,
)
from strategies.base import BaseStrategy
from risk.manager import RiskManager, RiskLimits
from ipc.server import IPCServer, StrategyEngine


def load_config(config_path: str) -> dict:
    with open(config_path, encoding='utf-8') as f:
        return yaml.safe_load(f)


def build_strategies(agent_cfg: dict, base_dir: Path) -> list[BaseStrategy]:
    strategies: list[BaseStrategy] = []
    strat_cfgs: dict = agent_cfg.get("strategies", {})

    strategy_classes = {
        "dca": TrendDCAStrategy,
        "limit_orders": LimitOrderStrategy,
        "rebalance": RebalanceStrategy,
        "trend_swap": TrendSwapStrategy,
        "mean_reversion": MeanReversionStrategy,
        "momentum": MomentumStrategy,
        "rsi_divergence": RSIDivergenceStrategy,
        # High-frequency strategies
        "price_change": PriceChangeStrategy,
        "spread_arb": SpreadArbStrategy,
        "opener": SeasonOpenerStrategy,
        "volatility_scalp": VolatilityScalpStrategy,
        "rsi_extreme": RsiExtremeStrategy,
        "volume_spike": VolumeSpikeStrategy,
        "candle_pattern": CandlePatternStrategy,
        "hi_lo_breakout": HiLoBreakoutStrategy,
        "take_profit": TakeProfitStrategy,
    }

    for strat_id, meta in strat_cfgs.items():
        if not meta.get("enabled", False):
            continue
        cfg_file = base_dir / meta["config_file"]
        if not cfg_file.exists():
            print(f"[warn] strategy config not found: {cfg_file}")
            continue
        strat_cfg = load_config(str(cfg_file))

        if strat_id in strategy_classes:
            strategies.append(strategy_classes[strat_id](strat_cfg))
        elif strat_cfg.get("plugin_file"):
            try:
                plugin = load_plugin(
                    str(base_dir / strat_cfg["plugin_file"]),
                    strat_cfg["plugin_class"],
                    strat_cfg,
                )
                strategies.append(plugin)
            except Exception as e:
                print(f"[warn] failed to load plugin {strat_id}: {e}")

    return strategies


def build_risk(agent_cfg: dict) -> RiskManager:
    rc = agent_cfg.get("risk", {})
    return RiskManager(RiskLimits(
        max_position_size_usd=rc.get("max_position_size_usd", 500),
        max_total_exposure_usd=rc.get("max_total_exposure_usd", 3000),
        max_daily_loss_usd=rc.get("max_daily_loss_usd", 150),
        max_drawdown_pct=rc.get("max_drawdown_pct", 15.0),
        max_slippage_bps=rc.get("max_slippage_bps", 100),
        cooldown_minutes=rc.get("cooldown_minutes", 5),
    ))


async def main() -> None:
    parser = argparse.ArgumentParser(description="Base Trading Agent - Python Strategy Engine")
    parser.add_argument("--config", default="config/agent.yaml", help="Path to agent.yaml")
    parser.add_argument("--ipc-port", type=int, default=7890)
    parser.add_argument("--ipc-host", default="127.0.0.1")
    args = parser.parse_args()

    config_path = Path(args.config)
    base_dir = config_path.parent.parent  # project root

    print(f"[main] loading config: {config_path}")
    agent_cfg = load_config(str(config_path))

    strategies = build_strategies(agent_cfg, base_dir / "config")
    print(f"[main] loaded {len(strategies)} strategies: {[s.id for s in strategies]}")

    risk = build_risk(agent_cfg)
    engine = StrategyEngine(strategies, risk)
    server = IPCServer(engine, host=args.ipc_host, port=args.ipc_port)

    print("[main] Python strategy engine ready")
    await server.start()


if __name__ == "__main__":
    asyncio.run(main())
