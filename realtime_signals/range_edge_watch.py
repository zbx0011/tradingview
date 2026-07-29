"""Plan and persist deterministic 15-minute range-edge warnings.

An active orange TradingView rectangle defines a horizontal range.  Its lower
and upper eighths are warning zones.  Every newly closed candle that intersects
either zone creates one unacknowledged signal row so TVFloat flashes.  The
companion Node reconciler keeps one TradingView price alert armed for each zone
until a candle closes outside the range.
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, connect, save_signal, utc_now


WATCHLIST = (
    ("BYBIT", "BTCUSDT.P"),
    ("OANDA", "XAGUSD"),
    ("OANDA", "XAUUSD"),
    ("ICMARKETS", "US500"),
)
TIMEFRAME = "15"
BAR_SECONDS = 15 * 60
RULES_VERSION = "louie-codex-v5"
MODEL_VERSION = "deterministic-range-edge"


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", delete=False, dir=path.parent
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        temporary = Path(handle.name)
    temporary.replace(path)


def active_ranges(conn: Any, vendor: str, symbol: str, bar_time: int) -> list[Any]:
    return conn.execute(
        """
        SELECT id,entity_id,start_time,end_time,upper,lower,source,locked,updated_at
        FROM chart_ranges
        WHERE vendor=? AND symbol=? AND timeframe=? AND status='active'
          AND start_time<=? AND end_time>=?
        ORDER BY locked DESC,source='manual' DESC,start_time DESC,
                 (upper-lower) ASC,id DESC
        """,
        (vendor, symbol, TIMEFRAME, bar_time, bar_time + BAR_SECONDS),
    ).fetchall()


def latest_bar(conn: Any, vendor: str, symbol: str) -> Any | None:
    return conn.execute(
        """
        SELECT open_time,open,high,low,close
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
        ORDER BY open_time DESC LIMIT 1
        """,
        (vendor, symbol, TIMEFRAME),
    ).fetchone()


def edge_definition(
    vendor: str, symbol: str, row: Any, side: str
) -> dict[str, Any]:
    upper = float(row["upper"])
    lower = float(row["lower"])
    width = upper - lower
    if side == "lower":
        threshold = lower + width / 8.0
        condition = "less_than"
        zone_low, zone_high = lower, threshold
        direction = "long"
        setup_type = "震荡下八分之一触碰"
    else:
        threshold = upper - width / 8.0
        condition = "greater_than"
        zone_low, zone_high = threshold, upper
        direction = "short"
        setup_type = "震荡上八分之一触碰"
    return {
        "range_id": int(row["id"]),
        "entity_id": str(row["entity_id"]),
        "vendor": vendor,
        "symbol": symbol,
        "full_symbol": f"{vendor}:{symbol}",
        "timeframe": TIMEFRAME,
        "side": side,
        "direction": direction,
        "setup_type": setup_type,
        "threshold": threshold,
        "condition": condition,
        "zone_low": zone_low,
        "zone_high": zone_high,
        "upper": upper,
        "lower": lower,
        "range_updated_at": int(row["updated_at"]),
    }


def was_touched(bar: Any, edge: dict[str, Any]) -> bool:
    return (
        float(bar["low"]) <= float(edge["zone_high"])
        and float(bar["high"]) >= float(edge["zone_low"])
    )


def save_touch(
    conn: Any, bar: Any, edge: dict[str, Any], dry_run: bool
) -> dict[str, Any]:
    payload = {
        "vendor": edge["vendor"],
        "symbol": edge["symbol"],
        "timeframe": TIMEFRAME,
        "bar_time": int(bar["open_time"]),
        "signal_price": float(bar["close"]),
        "direction": edge["direction"],
        "setup_type": edge["setup_type"],
        "grade": "边缘预警",
        "reasons": [
            (
                f"上一根15分钟K线触及震荡区间"
                f"{'下' if edge['side'] == 'lower' else '上'}八分之一区域"
                f" {edge['zone_low']:.8g}–{edge['zone_high']:.8g}"
            )
        ],
        "context": {
            "alert_class": "range_edge_touch",
            "range_id": edge["range_id"],
            "range_entity_id": edge["entity_id"],
            "range_lower": edge["lower"],
            "range_upper": edge["upper"],
            "zone_low": edge["zone_low"],
            "zone_high": edge["zone_high"],
            "threshold": edge["threshold"],
        },
        "rules_version": RULES_VERSION,
        "model_version": MODEL_VERSION,
    }
    if dry_run:
        return {"inserted": None, "signal_id": None, "payload": payload}
    result = save_signal(conn, payload)
    return {**result, "payload": payload}


def build_plan(conn: Any, dry_run: bool) -> dict[str, Any]:
    desired: list[dict[str, Any]] = []
    touches: list[dict[str, Any]] = []
    markets: list[dict[str, Any]] = []
    for vendor, symbol in WATCHLIST:
        bar = latest_bar(conn, vendor, symbol)
        if bar is None:
            markets.append(
                {"vendor": vendor, "symbol": symbol, "status": "no_closed_bar"}
            )
            continue
        ranges = active_ranges(conn, vendor, symbol, int(bar["open_time"]))
        market_touches = 0
        signaled_sides: set[str] = set()
        for row in ranges:
            lower = float(row["lower"])
            upper = float(row["upper"])
            if upper <= lower:
                continue
            broke_range = float(bar["close"]) < lower or float(bar["close"]) > upper
            for side in ("lower", "upper"):
                edge = edge_definition(vendor, symbol, row, side)
                if was_touched(bar, edge) and side not in signaled_sides:
                    result = save_touch(conn, bar, edge, dry_run)
                    touches.append(
                        {
                            **edge,
                            "bar_time": int(bar["open_time"]),
                            "bar_close": float(bar["close"]),
                            "inserted": result["inserted"],
                            "signal_id": result["signal_id"],
                        }
                    )
                    signaled_sides.add(side)
                    market_touches += 1
                if not broke_range:
                    desired.append(edge)
        markets.append(
            {
                "vendor": vendor,
                "symbol": symbol,
                "bar_time": int(bar["open_time"]),
                "close": float(bar["close"]),
                "active_ranges": len(ranges),
                "touches": market_touches,
                "status": "ok",
            }
        )
    tracked = [
        dict(row)
        for row in conn.execute(
            """
            SELECT range_id,side,vendor,symbol,timeframe,threshold,condition,
                   range_updated_at,tradingview_alert_id,status,created_at,updated_at
            FROM range_edge_alerts
            ORDER BY vendor,symbol,range_id,side
            """
        ).fetchall()
    ]
    return {
        "generated_at": utc_now(),
        "timeframe": TIMEFRAME,
        "desired": desired,
        "tracked": tracked,
        "touches": touches,
        "markets": markets,
        "dry_run": dry_run,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_DB.parent / "range_edge_alert_plan.json",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    conn = connect(args.db)
    try:
        plan = build_plan(conn, args.dry_run)
        atomic_json(args.output, plan)
        print(
            json.dumps(
                {
                    "success": True,
                    "output": str(args.output),
                    "desired_alerts": len(plan["desired"]),
                    "touches": len(plan["touches"]),
                    "inserted": sum(
                        1 for item in plan["touches"] if item["inserted"] is True
                    ),
                    "markets": plan["markets"],
                    "dry_run": args.dry_run,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
