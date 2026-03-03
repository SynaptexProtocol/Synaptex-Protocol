"""IPC server: listens for MarketSnapshot from TypeScript, returns SignalBatch."""
from __future__ import annotations
import asyncio
import json
import traceback
from datetime import datetime, timezone
from models.market import MarketSnapshot
from models.signal import SignalBatch, Signal
from risk.manager import RiskManager, RiskLimits
from strategies.base import BaseStrategy
from strategies.mixer import WeightedStrategyMixer


class StrategyEngine:
    def __init__(self, strategies: list[BaseStrategy], risk: RiskManager) -> None:
        self.strategies = strategies
        self.risk = risk

    def process(self, snapshot: MarketSnapshot) -> SignalBatch:
        all_signals = self._generate_signals(snapshot)

        # Risk filter
        approved: list[Signal] = []
        veto_reason: str | None = None
        for signal in all_signals:
            ok, reason = self.risk.check_pre_trade(signal, snapshot.portfolio)
            if ok:
                approved.append(signal)
            else:
                veto_reason = reason
                print(f"[risk] vetoed {signal.strategy_id}/{signal.token}: {reason}")

        return SignalBatch(
            cycle_id=snapshot.cycleId,
            timestamp=datetime.now(timezone.utc).isoformat(),
            signals=approved,
            risk_vetoed=len(approved) < len(all_signals),
            veto_reason=veto_reason if len(approved) < len(all_signals) else None,
        )

    def _generate_signals(self, snapshot: MarketSnapshot) -> list[Signal]:
        selected: list[BaseStrategy] = []
        for strategy in self.strategies:
            if not strategy.enabled:
                continue
            if strategy.id not in snapshot.activeStrategies:
                continue
            selected.append(strategy)

        if not selected:
            return []

        weights = snapshot.strategyWeights or {}
        weighted: list[tuple[BaseStrategy, float]] = []
        for strategy in selected:
            weight = float(weights.get(strategy.id, 0))
            if weight > 0:
                weighted.append((strategy, weight))

        if len(weighted) >= 2:
            try:
                return WeightedStrategyMixer(weighted).generate_signals(snapshot, snapshot.portfolio)
            except Exception as e:
                print(f"[mixer] fallback to sequential mode: {e}")

        all_signals: list[Signal] = []
        for strategy in selected:
            try:
                signals = strategy.generate_signals(snapshot, snapshot.portfolio)
                all_signals.extend(signals)
            except Exception as e:
                print(f"[strategy:{strategy.id}] error: {e}")
        return all_signals


class IPCServer:
    def __init__(self, engine: StrategyEngine, host: str = "127.0.0.1", port: int = 7890) -> None:
        self.engine = engine
        self.host = host
        self.port = port

    async def handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                request = json.loads(line.decode())
                response = await self._dispatch(request)
                writer.write((json.dumps(response) + "\n").encode())
                await writer.drain()
        except Exception as e:
            print(f"[ipc] client error: {e}")
        finally:
            writer.close()

    async def _dispatch(self, request: dict) -> dict:
        method = request.get("method")
        rid = request.get("id", "unknown")

        if method == "process_snapshot":
            try:
                snapshot = MarketSnapshot.model_validate(request["params"]["snapshot"])
                batch = self.engine.process(snapshot)
                return {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": batch.model_dump(),
                }
            except Exception as e:
                return {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32603, "message": str(e), "trace": traceback.format_exc()},
                }

        elif method == "get_health":
            return {
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "status": "ok",
                    "strategies": [s.id for s in self.engine.strategies if s.enabled],
                },
            }
        elif method == "record_trade":
            try:
                token = request["params"]["token"]
                if not isinstance(token, str) or not token:
                    raise ValueError("token must be a non-empty string")
                self.engine.risk.record_trade(token)
                return {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {"ok": True},
                }
            except Exception as e:
                return {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32602, "message": str(e)},
                }

        return {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32601, "message": f"Unknown method: {method}"},
        }

    async def start(self) -> None:
        server = await asyncio.start_server(self.handle_client, self.host, self.port)
        print(f"[ipc] listening on {self.host}:{self.port}")
        async with server:
            await server.serve_forever()
