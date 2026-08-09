#!/usr/bin/env python3
# louie规则回放（20260806版本）
"""Resolve review signal specs (date/close) into exact bar_time + close."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "outputs" / "xagusd_review_signals_spec.json"
OUT = ROOT / "outputs" / "xagusd_review_signals_20260805.json"
DB = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TVFloat" / "market.db"
BEIJING = timezone(timedelta(hours=8))


def main() -> int:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    resolved = []
    missing = []
    for item in spec:
        target = datetime.strptime(f"2026 {item['date']}", "%Y %m-%d %H:%M").replace(
            tzinfo=BEIJING
        )
        target_ts = int(target.timestamp())
        row = con.execute(
            """
            SELECT open_time, close, high, low
            FROM candles
            WHERE vendor='OANDA' AND symbol='XAGUSD' AND timeframe='5'
              AND open_time=?
            """,
            (target_ts,),
        ).fetchone()
        if row is None:
            missing.append(item["date"])
            continue
        resolved.append(
            {
                "vendor": "OANDA",
                "symbol": "XAGUSD",
                "timeframe": "5",
                "bar_time": int(row["open_time"]),
                "direction": item["direction"],
                "setup_type": item["setup"],
                "reason": item["reason"],
                "signal_price": round(float(row["close"]), 3),
            }
        )
    con.close()
    OUT.write_text(
        json.dumps(resolved, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"resolved": len(resolved), "missing": missing}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
