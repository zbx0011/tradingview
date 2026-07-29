from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, connect


ROOT = Path(__file__).resolve().parent.parent
WORK_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TVFloat" / "pure_ai_comparison"
SCHEMA_PATH = Path(__file__).resolve().with_name("pure_ai_schema.json")
MODEL = "gpt-5.6-sol"
EFFORT = "high"
TIMEOUT_SECONDS = 240

VALID_SETUPS = (
    "震荡内部：边缘反向",
    "震荡突破：位移突破",
    "宽通道边缘：反向波段",
    "宽通道突破：更大级别反转",
    "宽通道顺势：在有利边缘跟随主方向",
    "窄通道：等待回踩顺势参与",
)


def repair_text(value: str) -> str:
    """Repair strings that were accidentally persisted as GBK bytes in Latin-1."""
    if not value:
        return value
    try:
        candidate = value.encode("latin1").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value
    return candidate if any("\u4e00" <= ch <= "\u9fff" for ch in candidate) else value


def normalized_setup(value: str) -> str:
    value = repair_text(value)
    aliases = {
        "range_breakout_displacement": "震荡突破：位移突破",
    }
    return aliases.get(value, value)


def beijing_text(timestamp: int) -> str:
    tz = timezone(timedelta(hours=8))
    return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(tz).strftime("%Y-%m-%d %H:%M")


def ensure_result_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_ai_comparisons (
            signal_id INTEGER PRIMARY KEY,
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
            compared_at INTEGER NOT NULL,
            FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
        )
        """
    )
    conn.commit()


def load_cases(conn: sqlite3.Connection, bars: int) -> list[dict[str, Any]]:
    signals = conn.execute(
        """
        SELECT id,vendor,symbol,timeframe,bar_time,signal_price,direction,
               setup_type,grade,reasons_json,context_json,created_at
        FROM signals
        ORDER BY bar_time,id
        """
    ).fetchall()
    cases: list[dict[str, Any]] = []
    for signal in signals:
        history = conn.execute(
            """
            SELECT open_time,open,high,low,close,volume
            FROM candles
            WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
              AND open_time<=?
            ORDER BY open_time DESC
            LIMIT ?
            """,
            (
                signal["vendor"],
                signal["symbol"],
                signal["timeframe"],
                signal["bar_time"],
                bars,
            ),
        ).fetchall()
        history = list(reversed(history))
        if not history or int(history[-1]["open_time"]) != int(signal["bar_time"]):
            raise RuntimeError(f"Signal {signal['id']} has no matching final candle")
        cases.append(
            {
                "signal_id": int(signal["id"]),
                "vendor": signal["vendor"],
                "symbol": signal["symbol"],
                "timeframe": signal["timeframe"],
                "cutoff_bar_time": int(signal["bar_time"]),
                "cutoff_beijing": beijing_text(int(signal["bar_time"])),
                "bars": [
                    [
                        int(row["open_time"]),
                        float(row["open"]),
                        float(row["high"]),
                        float(row["low"]),
                        float(row["close"]),
                        float(row["volume"]),
                    ]
                    for row in history
                ],
                "_original": {
                    "signal_price": float(signal["signal_price"]),
                    "direction": signal["direction"],
                    "setup_type": normalized_setup(signal["setup_type"]),
                    "grade": signal["grade"],
                    "reasons": [
                        repair_text(str(item))
                        for item in json.loads(signal["reasons_json"])
                    ],
                },
            }
        )
    return cases


def prompt_for(case: dict[str, Any]) -> str:
    blind = {key: value for key, value in case.items() if not key.startswith("_") and key != "signal_id"}
    return f"""你是独立的纯AI交易机会复核器。本次是盲测，不允许使用工具、网络、TradingView、数据库或任何外部信息。

下面只给出一个固定品种5分钟K线，在 cutoff_bar_time 对应K线收盘时已经存在的数据。数组字段依次为：
[open_time, open, high, low, close, volume]。

你不知道另一套系统在该时间点给过什么信号。请独立判断：最后一根K线收盘时，是否刚刚形成新的A/B级机会。绝不利用最后一根之后的数据。

判断顺序和规则：
1. 先判断外层状态，再判断内层状态。
2. 正式类型只能选：{json.dumps(VALID_SETUPS, ensure_ascii=False)}。
3. 震荡中部不发信号；相邻相近影线只算一次测试。
4. 震荡边缘的双顶/双底、楔形、假突破/假跌破、扫流动性并收回可升级。
5. 没有真正触及支撑压力应降级；宽通道顺势自动降一级。
6. 高潮后的第一次反转只能OBSERVE，必须已经出现失败延续、重新收回、反向跟随或二次反转才可A/B。
7. 24根滚动高低点本身不是震荡或宽通道边缘。若判断宽通道，必须能从已给K线中找到至少两个上沿锚点和两个下沿锚点，否则不可使用宽通道类型。
8. 若信号仍需未来K线确认，输出OBSERVE，而不是A/B。
9. 只评价最后一根K线是否产生“新机会”，不要评价之前已经发生的机会。

输出要求：
- A/B时 verdict与grade一致，direction为long或short，setup_type为上述完整类型。
- 仅观察时 verdict=OBSERVE、grade=none；无机会时 verdict=NO_SIGNAL、grade=none。
- OBSERVE/NO_SIGNAL时 direction可为倾向方向或none，setup_type可为空字符串。
- reasons必须写出当时可验证的具体价格结构。

盲测数据：
{json.dumps(blind, ensure_ascii=False, separators=(",", ":"))}
"""


def run_one(codex: str, case: dict[str, Any], force: bool) -> dict[str, Any]:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    result_path = WORK_DIR / f"signal-{case['signal_id']}.json"
    if result_path.exists() and not force:
        return json.loads(result_path.read_text(encoding="utf-8"))
    command = [
        codex,
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "danger-full-access",
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
        input=prompt_for(case),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=TIMEOUT_SECONDS,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    log_path = WORK_DIR / f"signal-{case['signal_id']}.log"
    log_path.write_text(completed.stdout or "", encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(
            f"AI-only review failed for signal {case['signal_id']} "
            f"(exit {completed.returncode}); see {log_path}"
        )
    result = json.loads(result_path.read_text(encoding="utf-8"))
    return result


def save_result(conn: sqlite3.Connection, signal_id: int, result: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO signal_ai_comparisons (
            signal_id,model,reasoning_effort,verdict,direction,setup_type,grade,
            outer_state,inner_state,reasons_json,confidence,result_json,compared_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(signal_id) DO UPDATE SET
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
            compared_at=excluded.compared_at
        """,
        (
            signal_id,
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


def build_report(cases: list[dict[str, Any]], results: dict[int, dict[str, Any]]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for case in cases:
        original = case["_original"]
        pure = results[case["signal_id"]]
        pure_formal = pure["verdict"] in {"A", "B"}
        direction_match = pure_formal and pure["direction"] == original["direction"]
        setup_match = pure_formal and pure.get("setup_type", "") == original["setup_type"]
        grade_match = pure_formal and pure["grade"] == original["grade"]
        rows.append(
            {
                "signal_id": case["signal_id"],
                "symbol": case["symbol"],
                "beijing": case["cutoff_beijing"],
                "original_direction": original["direction"],
                "original_setup": original["setup_type"],
                "original_grade": original["grade"],
                "pure_verdict": pure["verdict"],
                "pure_direction": pure["direction"],
                "pure_setup": pure.get("setup_type", ""),
                "pure_grade": pure["grade"],
                "pure_confidence": pure["confidence"],
                "formal_agreement": pure_formal,
                "direction_match": direction_match,
                "setup_match": setup_match,
                "grade_match": grade_match,
                "pure_reasons": pure["reasons"],
            }
        )
    total = len(rows)
    formal = sum(row["formal_agreement"] for row in rows)
    direction = sum(row["direction_match"] for row in rows)
    setup = sum(row["setup_match"] for row in rows)
    grade = sum(row["grade_match"] for row in rows)
    return {
        "summary": {
            "total_archived_signals": total,
            "pure_ai_kept_formal": formal,
            "pure_ai_rejected_or_observe": total - formal,
            "direction_match": direction,
            "setup_exact_match": setup,
            "grade_exact_match": grade,
        },
        "rows": rows,
    }


def write_report(report: dict[str, Any]) -> tuple[Path, Path, Path]:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    json_path = WORK_DIR / "comparison-report.json"
    csv_path = WORK_DIR / "comparison-report.csv"
    md_path = WORK_DIR / "comparison-report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        fieldnames = [key for key in report["rows"][0].keys() if key != "pure_reasons"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in report["rows"]:
            writer.writerow({key: row[key] for key in fieldnames})
    summary = report["summary"]
    lines = [
        "# 本地筛选＋AI 与纯AI盲测比较",
        "",
        f"- 存档信号：{summary['total_archived_signals']}",
        f"- 纯AI仍判定A/B：{summary['pure_ai_kept_formal']}",
        f"- 纯AI降为观察或无信号：{summary['pure_ai_rejected_or_observe']}",
        f"- 方向一致：{summary['direction_match']}",
        f"- 类型完全一致：{summary['setup_exact_match']}",
        f"- 等级完全一致：{summary['grade_exact_match']}",
        "",
        "|ID|品种|北京时间|原信号|纯AI|方向|类型|等级|",
        "|---:|---|---|---|---|---|---|---|",
    ]
    for row in report["rows"]:
        original = f"{row['original_grade']} {row['original_direction']} {row['original_setup']}"
        pure = f"{row['pure_verdict']} {row['pure_direction']} {row['pure_setup']}"
        lines.append(
            f"|{row['signal_id']}|{row['symbol']}|{row['beijing']}|{original}|{pure}|"
            f"{'✓' if row['direction_match'] else '✗'}|"
            f"{'✓' if row['setup_match'] else '✗'}|"
            f"{'✓' if row['grade_match'] else '✗'}|"
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, csv_path, md_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--bars", type=int, default=144)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError("codex executable not found")
    conn = connect(args.db)
    ensure_result_table(conn)
    cases = load_cases(conn, max(48, args.bars))
    results: dict[int, dict[str, Any]] = {}
    print(f"FROZEN_CASES={len(cases)}", flush=True)
    for index, case in enumerate(cases, start=1):
        print(
            f"START {index}/{len(cases)} id={case['signal_id']} "
            f"{case['symbol']} {case['cutoff_beijing']}",
            flush=True,
        )
        result = run_one(codex, case, args.force)
        save_result(conn, case["signal_id"], result)
        results[case["signal_id"]] = result
        print(
            f"DONE {index}/{len(cases)} id={case['signal_id']} "
            f"verdict={result['verdict']} direction={result['direction']}",
            flush=True,
        )
    report = build_report(cases, results)
    paths = write_report(report)
    print(json.dumps({"summary": report["summary"], "files": [str(path) for path in paths]}, ensure_ascii=False), flush=True)
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
