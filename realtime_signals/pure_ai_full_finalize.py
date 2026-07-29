from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, connect
from pure_ai_full_scan import (
    EFFORT as FIRST_EFFORT,
    MODEL as FIRST_MODEL,
    ROOT,
    SCHEMA_PATH,
    WORK_DIR,
    bj_text,
    load_bars,
    parse_bj,
    rules_prompt,
)


MODEL = "gpt-5.6-sol"
EFFORT = "high"
TIMEOUT_SECONDS = 240
BEIJING = timezone(timedelta(hours=8))


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_full_bar_rechecks (
            vendor TEXT NOT NULL,
            symbol TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            bar_time INTEGER NOT NULL,
            model TEXT NOT NULL,
            reasoning_effort TEXT NOT NULL,
            verdict TEXT NOT NULL,
            direction TEXT NOT NULL,
            setup_type TEXT NOT NULL,
            grade TEXT NOT NULL,
            outer_state TEXT NOT NULL,
            inner_state TEXT NOT NULL,
            reasons_json TEXT NOT NULL,
            confidence REAL NOT NULL,
            result_json TEXT NOT NULL,
            reviewed_at INTEGER NOT NULL,
            PRIMARY KEY (vendor, symbol, timeframe, bar_time)
        )
        """
    )
    conn.commit()


def independent_history(
    conn: sqlite3.Connection, vendor: str, symbol: str, bar_time: int
) -> list[list[float | int]]:
    history, _ = load_bars(conn, vendor, symbol, bar_time, bar_time)
    return history


def run_recheck(
    codex: str,
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    bar_time: int,
    force: bool,
) -> dict[str, Any]:
    result_dir = WORK_DIR / "sol-rechecks"
    result_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{vendor}-{symbol.replace('.', '_')}-{bar_time}"
    result_path = result_dir / f"{stem}.result.json"
    if result_path.exists() and not force:
        return json.loads(result_path.read_text(encoding="utf-8"))
    history = independent_history(conn, vendor, symbol, bar_time)
    command = [
        codex,
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ignore-rules",
        "-C",
        str(ROOT),
        "-m",
        MODEL,
        "-c",
        f"model_reasoning_effort={EFFORT}",
        "--output-schema",
        str(SCHEMA_PATH),
        "-o",
        str(result_path),
        "-",
    ]
    completed = subprocess.run(
        command,
        input=rules_prompt(vendor, symbol, history),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=TIMEOUT_SECONDS,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    (result_dir / f"{stem}.log").write_text(completed.stdout or "", encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(
            f"Sol复核失败 {vendor}:{symbol} {bj_text(bar_time)}，退出码{completed.returncode}"
        )
    return json.loads(result_path.read_text(encoding="utf-8"))


def save_recheck(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    bar_time: int,
    result: dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO ai_full_bar_rechecks (
            vendor,symbol,timeframe,bar_time,model,reasoning_effort,
            verdict,direction,setup_type,grade,outer_state,inner_state,
            reasons_json,confidence,result_json,reviewed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vendor,symbol,timeframe,bar_time) DO UPDATE SET
            model=excluded.model,
            reasoning_effort=excluded.reasoning_effort,
            verdict=excluded.verdict,
            direction=excluded.direction,
            setup_type=excluded.setup_type,
            grade=excluded.grade,
            outer_state=excluded.outer_state,
            inner_state=excluded.inner_state,
            reasons_json=excluded.reasons_json,
            confidence=excluded.confidence,
            result_json=excluded.result_json,
            reviewed_at=excluded.reviewed_at
        """,
        (
            vendor,
            symbol,
            "5",
            bar_time,
            MODEL,
            EFFORT,
            result["verdict"],
            result["direction"],
            result.get("setup_type", ""),
            result["grade"],
            result["outer_state"],
            result["inner_state"],
            json.dumps(result["reasons"], ensure_ascii=False, separators=(",", ":")),
            float(result["confidence"]),
            json.dumps(result, ensure_ascii=False, separators=(",", ":")),
            int(time.time()),
        ),
    )
    conn.commit()


def reuse_positive_audit(
    conn: sqlite3.Connection, signal_id: int
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT result_json FROM signal_ai_comparisons WHERE signal_id=?",
        (signal_id,),
    ).fetchone()
    return json.loads(row["result_json"]) if row else None


def final_rows(
    conn: sqlite3.Connection, start: int, end: int
) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT r.*,s.direction AS local_direction,s.setup_type AS local_setup,
               s.grade AS local_grade
        FROM ai_full_bar_reviews r
        LEFT JOIN signals s ON s.id=r.local_signal_id
        WHERE r.bar_time>=? AND r.bar_time<=?
        ORDER BY r.bar_time,r.vendor,r.symbol
        """,
        (start, end),
    ).fetchall()
    output: list[dict[str, Any]] = []
    for row in rows:
        recheck = conn.execute(
            """
            SELECT result_json FROM ai_full_bar_rechecks
            WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time=?
            """,
            (row["vendor"], row["symbol"], row["bar_time"]),
        ).fetchone()
        first = json.loads(row["result_json"])
        final = json.loads(recheck["result_json"]) if recheck else first
        local_formal = row["local_signal_id"] is not None
        ai_formal = final["verdict"] in {"A", "B"}
        if local_formal and ai_formal:
            agreement = (
                "both_same_direction"
                if row["local_direction"] == final["direction"]
                else "direction_conflict"
            )
        elif local_formal:
            agreement = "local_only"
        elif ai_formal:
            agreement = "ai_only"
        else:
            agreement = "both_no_formal_signal"
        output.append(
            {
                "vendor": row["vendor"],
                "symbol": row["symbol"],
                "bar_time": int(row["bar_time"]),
                "beijing_time": bj_text(int(row["bar_time"])),
                "local_signal_id": row["local_signal_id"],
                "local_direction": row["local_direction"] or "none",
                "local_setup": row["local_setup"] or "",
                "local_grade": row["local_grade"] or "none",
                "first_model": FIRST_MODEL,
                "first_verdict": first["verdict"],
                "final_model": MODEL if recheck else FIRST_MODEL,
                "ai_verdict": final["verdict"],
                "ai_direction": final["direction"],
                "ai_setup": final.get("setup_type", ""),
                "ai_grade": final["grade"],
                "ai_reasons": final["reasons"],
                "agreement": agreement,
            }
        )
    return output


def write_report(rows: list[dict[str, Any]], start: int, end: int) -> dict[str, Any]:
    report_dir = WORK_DIR
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["agreement"]] = counts.get(row["agreement"], 0) + 1
    same = counts.get("both_same_direction", 0)
    conflict = counts.get("direction_conflict", 0)
    local_count = sum(r["local_signal_id"] is not None for r in rows)
    ai_count = sum(r["ai_verdict"] in {"A", "B"} for r in rows)
    timestamp_overlap = same + conflict
    direction_precision = same / local_count if local_count else 0.0
    direction_recall = same / ai_count if ai_count else 0.0
    direction_f1 = (
        2 * direction_precision * direction_recall / (direction_precision + direction_recall)
        if direction_precision + direction_recall
        else 0.0
    )
    same_rows = [r for r in rows if r["agreement"] == "both_same_direction"]
    summary = {
        "window_beijing": [bj_text(start), bj_text(end)],
        "total_symbol_bars": len(rows),
        "local_formal_signals": local_count,
        "ai_formal_signals": ai_count,
        "timestamp_precision": timestamp_overlap / local_count if local_count else 0.0,
        "timestamp_recall": timestamp_overlap / ai_count if ai_count else 0.0,
        "direction_precision": direction_precision,
        "direction_recall": direction_recall,
        "direction_f1": direction_f1,
        "binary_timestamp_agreement": (
            counts.get("both_no_formal_signal", 0) + timestamp_overlap
        )
        / len(rows),
        "direction_aware_agreement": (
            counts.get("both_no_formal_signal", 0) + same
        )
        / len(rows),
        "grade_exact_on_direction_matches": sum(
            r["local_grade"] == r["ai_grade"] for r in same_rows
        ),
        "setup_exact_on_direction_matches": sum(
            r["local_setup"] == r["ai_setup"] for r in same_rows
        ),
        **counts,
    }
    payload = {"summary": summary, "rows": rows}
    (report_dir / "full-comparison-report.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with (report_dir / "full-comparison-report.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "vendor",
                "symbol",
                "beijing_time",
                "local_signal_id",
                "local_direction",
                "local_setup",
                "local_grade",
                "first_verdict",
                "final_model",
                "ai_verdict",
                "ai_direction",
                "ai_setup",
                "ai_grade",
                "agreement",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in writer.fieldnames})
    mismatches = [
        row for row in rows if row["agreement"] != "both_no_formal_signal"
    ]
    lines = [
        "# 本地程序+AI 与逐K纯AI全量比较",
        "",
        f"- 固定窗口：{bj_text(start)} 至 {bj_text(end)}",
        f"- 品种×K线总数：{len(rows)}",
        f"- 本地正式信号：{summary['local_formal_signals']}",
        f"- 纯AI正式信号：{summary['ai_formal_signals']}",
        f"- 同方向命中：{counts.get('both_same_direction', 0)}",
        f"- 仅本地有：{counts.get('local_only', 0)}",
        f"- 仅纯AI有：{counts.get('ai_only', 0)}",
        f"- 方向冲突：{counts.get('direction_conflict', 0)}",
        f"- 双方均无正式信号：{counts.get('both_no_formal_signal', 0)}",
        f"- 时间戳精确率/召回率：{summary['timestamp_precision']:.1%} / {summary['timestamp_recall']:.1%}",
        f"- 方向一致精确率/召回率/F1：{summary['direction_precision']:.1%} / {summary['direction_recall']:.1%} / {summary['direction_f1']:.1%}",
        f"- 二元时间戳一致率：{summary['binary_timestamp_agreement']:.1%}",
        f"- 方向敏感一致率：{summary['direction_aware_agreement']:.1%}",
        f"- 同方向{same}例中的等级/类型完全一致：{summary['grade_exact_on_direction_matches']} / {summary['setup_exact_on_direction_matches']}",
        "",
        "## 所有至少一方有信号的时间点",
        "",
        "| 时间 | 品种 | 本地 | 纯AI | 关系 |",
        "|---|---|---|---|---|",
    ]
    for row in mismatches:
        local = (
            f"{row['local_grade']} {row['local_direction']}"
            if row["local_signal_id"] is not None
            else "无"
        )
        ai = (
            f"{row['ai_grade']} {row['ai_direction']}"
            if row["ai_verdict"] in {"A", "B"}
            else row["ai_verdict"]
        )
        lines.append(
            f"| {row['beijing_time']} | {row['symbol']} | {local} | {ai} | {row['agreement']} |"
        )
    (report_dir / "full-comparison-report.md").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Sol recheck and full confusion report")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--start-bj", default="2026-07-27T11:30")
    parser.add_argument("--end-bj", default="2026-07-27T15:50")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    codex = os.environ.get("CODEX_CLI") or shutil.which("codex")
    if not codex:
        raise RuntimeError("找不到 codex CLI")
    conn = connect(Path(args.db))
    ensure_table(conn)
    start = parse_bj(args.start_bj)
    end = parse_bj(args.end_bj)
    rows = conn.execute(
        """
        SELECT * FROM ai_full_bar_reviews
        WHERE bar_time>=? AND bar_time<=?
        ORDER BY bar_time,vendor,symbol
        """,
        (start, end),
    ).fetchall()
    expected = conn.execute(
        """
        SELECT count(*) FROM candles
        WHERE timeframe='5' AND is_final=1 AND open_time>=? AND open_time<=?
          AND ((vendor='BYBIT' AND symbol='BTCUSDT.P')
            OR (vendor='OANDA' AND symbol IN ('XAGUSD','XAUUSD'))
            OR (vendor='CAPITALCOM' AND symbol='SPX500'))
        """,
        (start, end),
    ).fetchone()[0]
    if len(rows) != expected:
        raise RuntimeError(f"全量初筛未完成：已有{len(rows)}，应有{expected}")

    for index, row in enumerate(rows, 1):
        formal_candidate = row["verdict"] in {"A", "B"}
        local_positive = row["local_signal_id"] is not None
        if not formal_candidate and not local_positive:
            continue
        existing = conn.execute(
            """
            SELECT 1 FROM ai_full_bar_rechecks
            WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time=?
            """,
            (row["vendor"], row["symbol"], row["bar_time"]),
        ).fetchone()
        if existing and not args.force:
            continue
        reused = (
            reuse_positive_audit(conn, int(row["local_signal_id"]))
            if local_positive
            else None
        )
        result = reused or run_recheck(
            codex,
            conn,
            row["vendor"],
            row["symbol"],
            int(row["bar_time"]),
            args.force,
        )
        save_recheck(
            conn, row["vendor"], row["symbol"], int(row["bar_time"]), result
        )
        print(
            f"RECHECK {index}/{len(rows)} {row['symbol']} "
            f"{bj_text(int(row['bar_time']))} {result['verdict']} {result['direction']}",
            flush=True,
        )
    summary = write_report(final_rows(conn, start, end), start, end)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
