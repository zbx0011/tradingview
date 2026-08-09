# louie规则回放（20260806版本）
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, connect


ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = Path(__file__).resolve().with_name("pure_ai_schema.json")
WORK_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TVFloat" / "pure_ai_full_scan"
MODEL = "gpt-5.6-sol"
EFFORT = "xhigh"
TIMEOUT_SECONDS = 240
BEIJING = timezone(timedelta(hours=8))

SYMBOLS = (
    ("BYBIT", "BTCUSDT.P"),
    ("OANDA", "XAGUSD"),
    ("OANDA", "XAUUSD"),
    ("CAPITALCOM", "SPX500"),
)

VALID_SETUPS = (
    "震荡内部：边缘反向",
    "震荡突破：位移突破",
    "宽通道边缘：反向波段",
    "宽通道突破：更大级别反转",
    "宽通道顺势：在有利边缘跟随主方向",
    "窄通道：等待回踩顺势参与",
)


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_full_bar_reviews (
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
            local_signal_id INTEGER,
            reviewed_at INTEGER NOT NULL,
            PRIMARY KEY (vendor, symbol, timeframe, bar_time)
        )
        """
    )
    conn.commit()


def bj_text(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(BEIJING).strftime(
        "%Y-%m-%d %H:%M"
    )


def load_bars(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    start: int,
    end: int,
) -> tuple[list[list[float | int]], list[list[float | int]]]:
    history = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe='5' AND is_final=1
          AND open_time<=?
        ORDER BY open_time DESC
        LIMIT 144
        """,
        (vendor, symbol, start),
    ).fetchall()
    history = list(reversed(history))
    evaluation = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe='5' AND is_final=1
          AND open_time>=? AND open_time<=?
        ORDER BY open_time
        """,
        (vendor, symbol, start, end),
    ).fetchall()

    def pack(rows: list[sqlite3.Row]) -> list[list[float | int]]:
        return [
            [
                int(row["open_time"]),
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                float(row["volume"] or 0),
            ]
            for row in rows
        ]

    packed_history = pack(history)
    packed_evaluation = pack(evaluation)
    if not packed_history or int(packed_history[-1][0]) != start:
        raise RuntimeError(f"{vendor}:{symbol} 缺少起始K线 {bj_text(start)}")
    return packed_history, packed_evaluation


def rules_prompt(vendor: str, symbol: str, history: list[list[float | int]]) -> str:
    return f"""你是一个独立、纯AI的交易机会逐K复核器。本轮是时间序列盲测。
禁止调用工具、网络、TradingView、数据库或读取本地文件。你只能使用我在对话中依次提供的K线。

品种：{vendor}:{symbol}，周期：5分钟。
数组字段依次为 [open_time, open, high, low, close, volume]。
每轮只判断本轮最后新增的一根K线在收盘时是否刚刚形成新的A/B级机会；严禁利用未来K线。

判断顺序与规则：
1. 先判断外层状态，再判断内层状态。
2. 正式类型只能选：{json.dumps(VALID_SETUPS, ensure_ascii=False)}。
3. 震荡中部不发信号；相邻K线的相近影线只算一次测试。
4. 震荡边缘的双顶/双底、楔形、假突破/假跌破、流动性扫取并收回可以升级。
5. 没有真正触及支撑压力则降级；宽通道顺势自动降一级。
6. 高潮后的第一次反转只能OBSERVE，必须已经出现失败延续、重新收回、反向跟随或二次反转才可A/B。
7. 滚动高低点本身不是震荡或宽通道边缘。判断宽通道必须从已见K线中找到至少两个上沿锚点和两个下沿锚点。
8. 若仍需未来K线确认，输出OBSERVE，而不是A/B。
9. 只评价最后新增K线是否产生“新机会”，不要重复之前已经成立的机会。

输出约束：
- A/B时 verdict与grade一致，direction为long或short，setup_type为上述完整类型。
- 仅观察时 verdict=OBSERVE、grade=none；无机会时 verdict=NO_SIGNAL、grade=none。
- reasons必须引用当时可验证的结构和价格，不可引用未来走势。

以下是截至第一根待评K线收盘时已经可见的144根或更少历史数据：
{json.dumps(history, ensure_ascii=False, separators=(",", ":"))}
请判断最后一根K线。"""


def next_prompt(bar: list[float | int]) -> str:
    return (
        "新增一根已经收盘的5分钟K线："
        + json.dumps(bar, ensure_ascii=False, separators=(",", ":"))
        + "\n只使用此前对话中的K线和这根新增K线，判断这根收盘时是否刚刚形成新的机会。"
    )


def run_codex(command: list[str], prompt: str, log_path: Path) -> tuple[str | None, dict[str, Any]]:
    output_path = log_path.with_suffix(".result.json")
    command = command + ["--output-schema", str(SCHEMA_PATH), "-o", str(output_path), "-"]
    completed = subprocess.run(
        command,
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=TIMEOUT_SECONDS,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    output = completed.stdout or ""
    log_path.write_text(output, encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(f"AI复核退出码 {completed.returncode}；日志：{log_path}")
    result = json.loads(output_path.read_text(encoding="utf-8"))
    session_id = None
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started":
            session_id = event.get("thread_id")
    return session_id, result


def save_result(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    bar_time: int,
    result: dict[str, Any],
) -> None:
    signal = conn.execute(
        """
        SELECT id FROM signals
        WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time=?
        ORDER BY id LIMIT 1
        """,
        (vendor, symbol, bar_time),
    ).fetchone()
    conn.execute(
        """
        INSERT INTO ai_full_bar_reviews (
            vendor,symbol,timeframe,bar_time,model,reasoning_effort,
            verdict,direction,setup_type,grade,outer_state,inner_state,
            reasons_json,confidence,result_json,local_signal_id,reviewed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
            local_signal_id=excluded.local_signal_id,
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
            int(signal["id"]) if signal else None,
            int(time.time()),
        ),
    )
    conn.commit()


def scan_symbol(
    conn: sqlite3.Connection,
    codex: str,
    vendor: str,
    symbol: str,
    start: int,
    end: int,
    force: bool,
) -> None:
    symbol_dir = WORK_DIR / f"{vendor}-{symbol.replace('.', '_')}"
    symbol_dir.mkdir(parents=True, exist_ok=True)
    history, evaluation = load_bars(conn, vendor, symbol, start, end)
    print(f"SYMBOL {vendor}:{symbol} bars={len(evaluation)}", flush=True)
    session_id: str | None = None

    for index, bar in enumerate(evaluation):
        bar_time = int(bar[0])
        existing = conn.execute(
            """
            SELECT 1 FROM ai_full_bar_reviews
            WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time=?
            """,
            (vendor, symbol, bar_time),
        ).fetchone()
        if existing and not force:
            # A resumed session cannot safely skip prior bars. Rebuild the model
            # sequence, but avoid rewriting the stored row.
            should_save = False
        else:
            should_save = True

        log_path = symbol_dir / f"{bar_time}.jsonl"
        if index == 0:
            command = [
                codex,
                "exec",
                "--json",
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
            ]
            new_session, result = run_codex(command, rules_prompt(vendor, symbol, history), log_path)
            if not new_session:
                raise RuntimeError(f"{vendor}:{symbol} 未获得AI会话ID；日志：{log_path}")
            session_id = new_session
        else:
            if not session_id:
                raise RuntimeError(f"{vendor}:{symbol} AI会话丢失")
            command = [
                codex,
                "exec",
                "resume",
                "--json",
                "--skip-git-repo-check",
                "--ignore-rules",
                "-m",
                MODEL,
                "-c",
                f"model_reasoning_effort={EFFORT}",
                session_id,
            ]
            _, result = run_codex(command, next_prompt(bar), log_path)

        if should_save:
            save_result(conn, vendor, symbol, bar_time, result)
        print(
            f"DONE {vendor}:{symbol} {bj_text(bar_time)} "
            f"{result['verdict']} {result['direction']}",
            flush=True,
        )


def parse_bj(value: str) -> int:
    parsed = datetime.strptime(value.replace("T", " "), "%Y-%m-%d %H:%M").replace(
        tzinfo=BEIJING
    )
    return int(parsed.timestamp())


def main() -> int:
    parser = argparse.ArgumentParser(description="Pure-AI causal review of every 5m bar")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--start-bj", default="2026-07-27 11:30")
    parser.add_argument("--end-bj", default="2026-07-27 15:50")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    codex = os.environ.get("CODEX_CLI") or shutil_which("codex")
    if not codex:
        raise RuntimeError("找不到 codex CLI")
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect(Path(args.db))
    ensure_table(conn)
    start = parse_bj(args.start_bj)
    end = parse_bj(args.end_bj)
    for vendor, symbol in SYMBOLS:
        scan_symbol(conn, codex, vendor, symbol, start, end, args.force)
    print("FULL_SCAN_COMPLETE", flush=True)
    return 0


def shutil_which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


if __name__ == "__main__":
    raise SystemExit(main())
