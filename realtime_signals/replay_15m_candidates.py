"""Causal 15-minute candidate replay.

Every bar is evaluated with data ending at that bar. Current TradingView
drawings, production chart_ranges, production signal history, and future bars
are deliberately excluded.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from candidate_filter_v2 import WATCHLIST, candidate_for, should_emit_candidate
from kline_store import DEFAULT_DB


BEIJING = timezone(timedelta(hours=8))
TIMEFRAME = "15"
WARMUP_BARS = 144


def parse_bj(value: str) -> int:
    return int(
        datetime.strptime(value.replace("T", " "), "%Y-%m-%d %H:%M")
        .replace(tzinfo=BEIJING)
        .timestamp()
    )


def bj_text(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, BEIJING).strftime("%Y-%m-%d %H:%M")


def emission_state(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "bar_time": candidate["bar_time"],
        "direction_hint": candidate["direction_hint"],
        "reason_codes": candidate["reason_codes"],
        "reason_families": candidate["reason_families"],
        "candidate_score": candidate["candidate_score"],
        "candidate_lifecycle": candidate["candidate_lifecycle"],
    }


def replay_symbol(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    start: int,
    end: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    all_rows = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
          AND open_time<=?
        ORDER BY open_time
        """,
        (vendor, symbol, TIMEFRAME, end),
    ).fetchall()
    start_index = next(
        (index for index, row in enumerate(all_rows) if int(row["open_time"]) >= start),
        len(all_rows),
    )
    warmup_index = max(0, start_index - WARMUP_BARS)
    memories: list[dict[str, Any]] = []
    previous_emission: dict[str, Any] | None = None
    output: list[dict[str, Any]] = []
    processed = 0

    for index in range(warmup_index, len(all_rows)):
        current_time = int(all_rows[index]["open_time"])
        if current_time > end:
            break
        visible_rows = all_rows[max(0, index - 119) : index + 1]
        candidate, memories = candidate_for(
            visible_rows,
            vendor,
            symbol,
            memories,
            chart_ranges=[],
        )
        emitted = bool(
            candidate and should_emit_candidate(candidate, previous_emission)
        )
        if emitted and candidate:
            previous_emission = emission_state(candidate)
        if current_time < start:
            continue
        processed += 1
        if not emitted or not candidate:
            continue
        candidate["recent_signals"] = []
        candidate["replay_guard"] = {
            "mode": "strict_causal",
            "visible_through_bar_time": current_time,
            "visible_through_beijing": bj_text(current_time),
            "future_bar_count": 0,
            "production_chart_ranges_used": False,
            "production_signals_used": False,
        }
        output.append(candidate)

    metadata = {
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": TIMEFRAME,
        "bars_scored": processed,
        "warmup_bars_available": start_index - warmup_index,
        "candidates": len(output),
    }
    return output, metadata


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--start-bj", required=True)
    parser.add_argument("--end-bj", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--market",
        action="append",
        help="Optional exact VENDOR:SYMBOL filter; may be supplied repeatedly.",
    )
    args = parser.parse_args()
    start = parse_bj(args.start_bj)
    end = parse_bj(args.end_bj)
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    candidates: list[dict[str, Any]] = []
    markets: list[dict[str, Any]] = []
    requested = set(args.market or [])
    watchlist = [
        (vendor, symbol)
        for vendor, symbol in WATCHLIST
        if not requested or f"{vendor}:{symbol}" in requested
    ]
    for vendor, symbol in watchlist:
        items, metadata = replay_symbol(conn, vendor, symbol, start, end)
        candidates.extend(items)
        markets.append(metadata)
    payload = {
        "version": 1,
        "mode": "strict_causal_15m_replay",
        "window_beijing": [bj_text(start), bj_text(end)],
        "chart_drawings_used": False,
        "production_chart_ranges_used": False,
        "production_signals_used": False,
        "markets": markets,
        "candidates": candidates,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "success": True,
                "window_beijing": payload["window_beijing"],
                "markets": markets,
                "total_candidates": len(candidates),
                "output": str(args.output.resolve()),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
