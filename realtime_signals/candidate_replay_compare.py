from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from candidate_filter import candidate_for as old_candidate_for
from candidate_filter_v2 import (
    WATCHLIST,
    candidate_for as new_candidate_for,
    should_emit_candidate,
)
from kline_store import DEFAULT_DB


BEIJING = timezone(timedelta(hours=8))


def parse_bj(value: str) -> int:
    return int(
        datetime.strptime(value.replace("T", " "), "%Y-%m-%d %H:%M")
        .replace(tzinfo=BEIJING)
        .timestamp()
    )


def bj_text(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(BEIJING).strftime(
        "%Y-%m-%d %H:%M"
    )


def final_ai_formal(conn: sqlite3.Connection, start: int, end: int) -> set[tuple[str, str, int]]:
    rows = conn.execute(
        """
        SELECT r.vendor,r.symbol,r.bar_time,
               COALESCE(h.verdict,r.verdict) AS final_verdict
        FROM ai_full_bar_reviews r
        LEFT JOIN ai_full_bar_rechecks h
          ON h.vendor=r.vendor AND h.symbol=r.symbol
         AND h.timeframe=r.timeframe AND h.bar_time=r.bar_time
        WHERE r.bar_time>=? AND r.bar_time<=?
        """,
        (start, end),
    ).fetchall()
    return {
        (row["vendor"], row["symbol"], int(row["bar_time"]))
        for row in rows
        if row["final_verdict"] in {"A", "B"}
    }


def replay(
    conn: sqlite3.Connection, start: int, end: int
) -> tuple[set[tuple[str, str, int]], set[tuple[str, str, int]], list[dict[str, Any]]]:
    old_hits: set[tuple[str, str, int]] = set()
    new_hits: set[tuple[str, str, int]] = set()
    details: list[dict[str, Any]] = []
    warmup_start = start - 6 * 300
    for vendor, symbol in WATCHLIST:
        memories: list[dict[str, Any]] = []
        last_emitted: dict[str, Any] | None = None
        times = [
            int(row["open_time"])
            for row in conn.execute(
                """
                SELECT open_time FROM candles
                WHERE vendor=? AND symbol=? AND timeframe='5' AND is_final=1
                  AND open_time>=? AND open_time<=?
                ORDER BY open_time
                """,
                (vendor, symbol, warmup_start, end),
            ).fetchall()
        ]
        for bar_time in times:
            rows = conn.execute(
                """
                SELECT open_time,open,high,low,close,volume FROM candles
                WHERE vendor=? AND symbol=? AND timeframe='5' AND is_final=1
                  AND open_time<=?
                ORDER BY open_time DESC LIMIT 120
                """,
                (vendor, symbol, bar_time),
            ).fetchall()
            rows = list(reversed(rows))
            old = old_candidate_for(rows[-96:], vendor, symbol)
            new, memories = new_candidate_for(rows, vendor, symbol, memories)
            emit_new = bool(new and should_emit_candidate(new, last_emitted))
            if emit_new and new:
                last_emitted = {
                    "bar_time": new["bar_time"],
                    "direction_hint": new["direction_hint"],
                    "reason_codes": new["reason_codes"],
                    "reason_families": new["reason_families"],
                    "candidate_score": new["candidate_score"],
                    "candidate_lifecycle": new["candidate_lifecycle"],
                }
            if bar_time < start:
                continue
            key = (vendor, symbol, bar_time)
            if old:
                old_hits.add(key)
            if emit_new and new:
                new_hits.add(key)
                details.append(
                    {
                        "vendor": vendor,
                        "symbol": symbol,
                        "bar_time": bar_time,
                        "beijing": bj_text(bar_time),
                        "reason_codes": new["reason_codes"],
                        "score": new["candidate_score"],
                        "lifecycle": new["candidate_lifecycle"],
                        "needs_sol": new["needs_sol"],
                    }
                )
    return old_hits, new_hits, details


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--start-bj", default="2026-07-27T11:30")
    parser.add_argument("--end-bj", default="2026-07-27T15:50")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_DB.parent / "candidate_replay_comparison.json",
    )
    args = parser.parse_args()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    start, end = parse_bj(args.start_bj), parse_bj(args.end_bj)
    target = final_ai_formal(conn, start, end)
    old_hits, new_hits, details = replay(conn, start, end)
    old_covered, new_covered = target & old_hits, target & new_hits
    report = {
        "window_beijing": [bj_text(start), bj_text(end)],
        "target_pure_ai_formal": len(target),
        "old_candidates": len(old_hits),
        "new_candidates": len(new_hits),
        "old_target_covered": len(old_covered),
        "new_target_covered": len(new_covered),
        "old_target_recall": len(old_covered) / len(target) if target else 0.0,
        "new_target_recall": len(new_covered) / len(target) if target else 0.0,
        "newly_covered_target_bars": [
            {"vendor": key[0], "symbol": key[1], "beijing": bj_text(key[2])}
            for key in sorted(new_covered - old_covered, key=lambda item: item[2])
        ],
        "still_missed_target_bars": [
            {"vendor": key[0], "symbol": key[1], "beijing": bj_text(key[2])}
            for key in sorted(target - new_covered, key=lambda item: item[2])
        ],
        "new_candidate_details": details,
    }
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({key: value for key, value in report.items() if key != "new_candidate_details"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
