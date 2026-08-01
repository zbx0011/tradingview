"""Low-cost, deterministic candidate gate for the 5-minute monitor.

This program never creates a trading signal.  It only emits a compact queue of
bars worth sending to a reasoning model, so ordinary bars consume no model
tokens.  The thresholds are deliberately permissive: missing a subjective
setup is worse than asking Terra to review an extra candidate.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, ema


WATCHLIST = (
    ("BYBIT", "BTCUSDT.P"),
    ("OANDA", "XAGUSD"),
    ("OANDA", "XAUUSD"),
    ("CAPITALCOM", "SPX500"),
)


def atr(rows: list[sqlite3.Row], length: int = 14) -> float:
    if len(rows) < 2:
        return 0.0
    values: list[float] = []
    previous = float(rows[0]["close"])
    for row in rows[1:]:
        high, low = float(row["high"]), float(row["low"])
        values.append(max(high - low, abs(high - previous), abs(low - previous)))
        previous = float(row["close"])
    sample = values[-length:]
    return sum(sample) / len(sample) if sample else 0.0


def candidate_for(rows: list[sqlite3.Row], vendor: str, symbol: str) -> dict[str, Any] | None:
    if len(rows) < 35:
        return None
    current = rows[-1]
    prior = rows[:-1]
    close, open_ = float(current["close"]), float(current["open"])
    high, low = float(current["high"]), float(current["low"])
    body = abs(close - open_)
    atr14 = atr(rows)
    if atr14 <= 0:
        return None

    closes = [float(row["close"]) for row in rows]
    ema20 = ema(closes, 20)[-1]
    recent12 = prior[-12:]
    recent24 = prior[-24:]
    top12 = max(float(row["high"]) for row in recent12)
    bottom12 = min(float(row["low"]) for row in recent12)
    top24 = max(float(row["high"]) for row in recent24)
    bottom24 = min(float(row["low"]) for row in recent24)
    time = int(current["open_time"])

    base = {
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": "5",
        "bar_time": time,
        "close": close,
        "atr14": round(atr14, 8),
        "ema20": round(ema20, 8),
        "window": {"high": top24, "low": bottom24},
        "recent_ohlc": [
            [int(row["open_time"]), float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])]
            for row in rows[-24:]
        ],
    }

    if body >= 1.05 * atr14 and close > top12:
        return {
            **base,
            "direction_hint": "long",
            "setup_hint": "向上位移候选（需复核外层状态）",
            "reason": "bull_displacement_above_12_bar_high",
            "needs_sol": True,
        }
    if body >= 1.05 * atr14 and close < bottom12:
        return {
            **base,
            "direction_hint": "short",
            "setup_hint": "向下位移候选（需复核外层状态）",
            "reason": "bear_displacement_below_12_bar_low",
            "needs_sol": True,
        }

    upper_wick = high - max(open_, close)
    lower_wick = min(open_, close) - low
    if high >= top24 - 0.20 * atr14 and upper_wick >= 0.45 * atr14 and close <= high - 0.60 * atr14:
        return {
            **base,
            "direction_hint": "short",
            "setup_hint": "上沿扫取候选（需复核是否确有通道或震荡边缘）",
            "reason": "upper_edge_sweep_rejection",
            "needs_sol": True,
        }
    if low <= bottom24 + 0.20 * atr14 and lower_wick >= 0.45 * atr14 and close >= low + 0.60 * atr14:
        return {
            **base,
            "direction_hint": "long",
            "setup_hint": "下沿扫取候选（需复核是否确有通道或震荡边缘）",
            "reason": "lower_edge_sweep_rejection",
            "needs_sol": True,
        }

    # A pullback to EMA20 after three same-direction closes is a Terra review,
    # never an autonomous signal and never escalates to Sol by itself.
    last4 = closes[-4:]
    if all(last4[index] > last4[index - 1] for index in range(1, 4)) and abs(low - ema20) <= 0.30 * atr14:
        return {**base, "direction_hint": "long", "setup_hint": "上升趋势回踩候选（需复核通道类型）", "reason": "bull_pullback_to_ema20", "needs_sol": False}
    if all(last4[index] < last4[index - 1] for index in range(1, 4)) and abs(high - ema20) <= 0.30 * atr14:
        return {**base, "direction_hint": "short", "setup_hint": "下降趋势回踩候选（需复核通道类型）", "reason": "bear_pullback_to_ema20", "needs_sol": False}
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_DB.parent / "candidate_queue.json")
    args = parser.parse_args()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    candidates: list[dict[str, Any]] = []
    for vendor, symbol in WATCHLIST:
        rows = conn.execute(
            """SELECT open_time,open,high,low,close,volume FROM candles
               WHERE vendor=? AND symbol=? AND timeframe='5' AND is_final=1
               ORDER BY open_time DESC LIMIT 96""",
            (vendor, symbol),
        ).fetchall()
        found = candidate_for(list(reversed(rows)), vendor, symbol)
        if found:
            recent_rows = conn.execute(
                """SELECT id,bar_time,signal_price,direction,setup_type,grade,
                          reasons_json,context_json,created_at
                   FROM signals
                   WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time<?
                   ORDER BY bar_time DESC,id DESC LIMIT 3""",
                (vendor, symbol, int(found["bar_time"])),
            ).fetchall()
            found["recent_signals"] = []
            for row in recent_rows:
                try:
                    context = json.loads(row["context_json"] or "{}")
                except json.JSONDecodeError:
                    context = {}
                found["recent_signals"].append(
                    {
                        "id": row["id"],
                        "bar_time": row["bar_time"],
                        "signal_price": row["signal_price"],
                        "direction": row["direction"],
                        "setup_type": row["setup_type"],
                        "grade": row["grade"],
                        "reasons": json.loads(row["reasons_json"] or "[]"),
                        "confirmation_price": context.get("confirmation_price"),
                        "invalidation_price": context.get("invalidation_price"),
                        "created_at": row["created_at"],
                    }
                )
            candidates.append(found)
    payload = {"version": 1, "candidates": candidates}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=args.output.parent) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        temp = Path(handle.name)
    temp.replace(args.output)
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    # Historical helpers remain importable for offline replay only.  Direct
    # execution must follow the unique production policy.
    from candidate_filter_production import main as production_main

    raise SystemExit(production_main())
