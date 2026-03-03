from __future__ import annotations
from typing import Literal
from pydantic import BaseModel

SignalAction = Literal["BUY", "SELL", "HOLD", "REBALANCE"]


class Signal(BaseModel):
    strategy_id: str
    action: SignalAction
    token: str
    amount_usd: float | None = None
    target_price: float | None = None
    confidence: float          # 0.0 - 1.0
    rationale: str
    requires_ai_approval: bool = False


class SignalBatch(BaseModel):
    cycle_id: str
    timestamp: str
    signals: list[Signal]
    risk_vetoed: bool = False
    veto_reason: str | None = None
