"""Export all durable TVFloat signal records as normalized JSON for Excel."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any
from urllib.parse import quote

from kline_store import DEFAULT_DB


DISPLAY_SYMBOLS = {"SPX500": "US500"}


def parse_json(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def export_records(db: Path) -> dict[str, Any]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        signal_rows = conn.execute(
            """
            SELECT
              s.*,
              r.verdict AS review_verdict,
              r.correction_json AS review_correction
            FROM signals AS s
            LEFT JOIN reviews AS r ON r.signal_id=s.id
            ORDER BY s.bar_time DESC, s.id DESC
            """
        ).fetchall()
        alert_rows = conn.execute(
            """
            SELECT signal_id,alert_kind,price,condition,status,tradingview_alert_id
            FROM tv_alerts
            ORDER BY signal_id,alert_kind
            """
        ).fetchall()
    finally:
        conn.close()

    alerts_by_signal: dict[int, list[dict[str, Any]]] = {}
    for row in alert_rows:
        alerts_by_signal.setdefault(int(row["signal_id"]), []).append(
            {
                "kind": row["alert_kind"],
                "price": float(row["price"]),
                "condition": row["condition"],
                "status": row["status"],
                "tradingview_alert_id": row["tradingview_alert_id"] or "",
            }
        )

    records: list[dict[str, Any]] = []
    for row in signal_rows:
        context = parse_json(row["context_json"], {})
        reasons = parse_json(row["reasons_json"], [])
        correction = parse_json(row["review_correction"], {})
        symbol = str(row["symbol"])
        vendor = str(row["vendor"])
        records.append(
            {
                "id": int(row["id"]),
                "bar_time_ms": int(row["bar_time"]) * 1000,
                "signal_time_ms": (int(row["bar_time"]) + int(row["timeframe"]) * 60)
                * 1000,
                "created_at_ms": int(row["created_at"]) * 1000,
                "symbol": DISPLAY_SYMBOLS.get(symbol, symbol),
                "raw_symbol": symbol,
                "vendor": vendor,
                "timeframe": str(row["timeframe"]),
                "direction": "多" if row["direction"] == "long" else "空",
                "direction_raw": str(row["direction"]),
                "setup_type": str(row["setup_type"]),
                "grade": str(row["grade"]),
                "signal_price": float(row["signal_price"]),
                "confirmation_price": float(
                    context.get("confirmation_price", row["signal_price"])
                ),
                "invalidation_price": float(
                    context.get("invalidation_price", row["signal_price"])
                ),
                "market_state": str(context.get("market_state", "")),
                "levels_reason": str(context.get("levels_reason", "")),
                "state_transition": str(context.get("state_transition", "")),
                "transition_evidence": str(
                    context.get("transition_evidence", "")
                ),
                "reasons": "\n".join(str(item) for item in reasons),
                "anchors": "\n".join(
                    str(item) for item in context.get("range_or_channel_anchors", [])
                ),
                "model_version": str(row["model_version"]),
                "rules_version": str(row["rules_version"]),
                "ack_status": "已查看" if row["acknowledged_at"] else "未查看",
                "acknowledged_at_ms": (
                    int(row["acknowledged_at"]) * 1000
                    if row["acknowledged_at"]
                    else None
                ),
                "alerts": "\n".join(
                    f"{item['kind']} | {item['status']} | {item['condition']} {item['price']}"
                    for item in alerts_by_signal.get(int(row["id"]), [])
                ),
                "chart_url": (
                    "https://www.tradingview.com/chart/?symbol="
                    + quote(f"{vendor}:{symbol}", safe="")
                ),
                "review_verdict": str(row["review_verdict"] or ""),
                "review_correction": json.dumps(
                    correction, ensure_ascii=False, separators=(",", ":")
                )
                if correction
                else "",
            }
        )

    return {
        "db": str(db.resolve()),
        "record_count": len(records),
        "max_signal_id": max((item["id"] for item in records), default=0),
        "generated_at_ms": int(__import__("time").time() * 1000),
        "records": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--max-id-only", action="store_true")
    args = parser.parse_args()
    if args.max_id_only:
        conn = sqlite3.connect(args.db)
        try:
            max_id = int(
                conn.execute("SELECT COALESCE(MAX(id),0) FROM signals").fetchone()[0]
            )
        finally:
            conn.close()
        print(max_id)
        return 0
    print(
        json.dumps(
            export_records(args.db),
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
