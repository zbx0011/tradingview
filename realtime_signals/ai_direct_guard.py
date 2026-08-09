# louie规则监控（20260806版本）
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, confirmed_pivots, connect, ema, save_state, utc_now


TIMEFRAME = "5"
BAR_SECONDS = 5 * 60
SAFETY_SECONDS = 5
# A decision belongs to the signal bar that opened at ``bar_time``.  It is a
# live opportunity only until the following 5m bar closes.  Historical review
# may still record the AI verdict, but it must never create a float alert,
# TradingView drawing, or TradingView alert after this deadline.
LIVE_SIGNAL_DEADLINE_BARS = 2
# Leave enough time for the single TradingView executor to switch the chart,
# draw, verify, and create both alerts before the live deadline.  This is an
# operational delivery budget, not a trading-rule threshold.
MIN_EXECUTION_REMAINING_SECONDS = 90
RULES_VERSION = "louie-xau-replay-v1"
ALLOWED_MARKETS = {
    ("BYBIT", "BTCUSDT.P"),
    ("OANDA", "XAGUSD"),
    ("OANDA", "XAUUSD"),
}
ALLOWED_SETUPS = {
    "震荡内部：边缘反向",
    "震荡突破：位移突破",
    "宽通道边缘：反向波段",
    "宽通道突破：更大级别反转",
    "宽通道顺势：在有利边缘跟随主方向",
    "窄通道：等待回踩顺势参与",
}
ALLOWED_VERDICTS = {"NO_SIGNAL", "OBSERVE", "SIGNAL"}
CYCLE_LEASE_NAME = "direct_ai_cycle"
EXECUTOR_LEASE_NAME = "direct_ai_executor"
MIN_CYCLE_LEASE_SECONDS = 1
MAX_CYCLE_LEASE_SECONDS = 24 * 60 * 60
PROJECT_ROOT = Path(__file__).resolve().parents[1]
RULE_SOURCE_PATHS = (
    PROJECT_ROOT / "migration" / "codex-handoff" / "source-rules" / "Louie交易规则完整整理_案例扩展版.md",
    PROJECT_ROOT / "migration" / "codex-handoff" / "source-rules" / "louie-case-expanded.md",
)


def rule_source_manifest() -> list[dict[str, Any]]:
    manifest: list[dict[str, Any]] = []
    for path in RULE_SOURCE_PATHS:
        if not path.is_file():
            raise FileNotFoundError(f"required Louie rule source is missing: {path}")
        raw = path.read_bytes()
        manifest.append(
            {
                "path": str(path.relative_to(PROJECT_ROOT)).replace("\\", "/"),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw),
                "must_be_read_in_full_by_ai": True,
            }
        )
    return manifest


DIRECT_REVIEW_SCHEMA = """
CREATE TABLE IF NOT EXISTS ai_direct_reviews (
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    bar_time INTEGER NOT NULL,
    data_cutoff INTEGER NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    verdict TEXT NOT NULL,
    direction TEXT NOT NULL,
    setup_type TEXT NOT NULL,
    grade TEXT NOT NULL,
    outer_state TEXT NOT NULL,
    inner_state TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    location_summary TEXT NOT NULL,
    structure_summary TEXT NOT NULL,
    confirmation_price REAL,
    invalidation_price REAL,
    context_json TEXT NOT NULL,
    rules_version TEXT NOT NULL DEFAULT '',
    execution_status TEXT NOT NULL DEFAULT 'not_required',
    execution_owner TEXT NOT NULL DEFAULT '',
    execution_claimed_at INTEGER,
    execution_detail_json TEXT NOT NULL DEFAULT '{}',
    reviewed_at INTEGER NOT NULL,
    PRIMARY KEY (vendor, symbol, timeframe, bar_time)
);

CREATE INDEX IF NOT EXISTS idx_ai_direct_reviews_market
ON ai_direct_reviews (vendor, symbol, timeframe, bar_time DESC);

CREATE TABLE IF NOT EXISTS ai_direct_monitor_status (
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    latest_closed_bar_time INTEGER,
    last_reviewed_bar_time INTEGER,
    pending_count INTEGER NOT NULL DEFAULT 0,
    expired_unreviewed_count INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (vendor, symbol, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_ai_direct_monitor_status_checked
ON ai_direct_monitor_status (checked_at DESC);

CREATE TABLE IF NOT EXISTS ai_direct_cycle_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_at INTEGER NOT NULL,
    owner TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ai_direct_cycle_log_completed
ON ai_direct_cycle_log (completed_at DESC);

CREATE TABLE IF NOT EXISTS ai_direct_cycle_leases (
    lease_name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
"""


def ensure_direct_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(DIRECT_REVIEW_SCHEMA)
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(ai_direct_reviews)").fetchall()
    }
    if "rules_version" not in columns:
        conn.execute(
            "ALTER TABLE ai_direct_reviews ADD COLUMN rules_version TEXT NOT NULL DEFAULT ''"
        )
    if "execution_owner" not in columns:
        conn.execute(
            "ALTER TABLE ai_direct_reviews ADD COLUMN execution_owner TEXT NOT NULL DEFAULT ''"
        )
    if "execution_claimed_at" not in columns:
        conn.execute(
            "ALTER TABLE ai_direct_reviews ADD COLUMN execution_claimed_at INTEGER"
        )
    conn.commit()


def _validate_cycle_lease(owner: str, lease_seconds: int) -> tuple[str, int]:
    normalized_owner = str(owner).strip()
    if not normalized_owner:
        raise ValueError("cycle lease owner is required")
    try:
        seconds = int(lease_seconds)
    except (TypeError, ValueError) as exc:
        raise ValueError("cycle lease seconds must be an integer") from exc
    if not MIN_CYCLE_LEASE_SECONDS <= seconds <= MAX_CYCLE_LEASE_SECONDS:
        raise ValueError(
            f"cycle lease seconds must be between {MIN_CYCLE_LEASE_SECONDS} and "
            f"{MAX_CYCLE_LEASE_SECONDS}"
        )
    return normalized_owner, seconds


def cycle_begin(
    conn: sqlite3.Connection,
    owner: str,
    lease_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    """Atomically acquire or refresh the singleton direct-AI cycle lease."""
    normalized_owner, seconds = _validate_cycle_lease(owner, lease_seconds)
    now_value = int(now if now is not None else utc_now())
    expires_at = now_value + seconds

    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            """
            SELECT owner, expires_at
            FROM ai_direct_cycle_leases
            WHERE lease_name=?
            """,
            (CYCLE_LEASE_NAME,),
        ).fetchone()
        if row is not None and row["owner"] != normalized_owner and int(row["expires_at"]) > now_value:
            conn.rollback()
            return {
                "acquired": False,
                "owner": row["owner"],
                "expires_at": int(row["expires_at"]),
            }

        if row is None:
            conn.execute(
                """
                INSERT INTO ai_direct_cycle_leases (lease_name, owner, expires_at)
                VALUES (?, ?, ?)
                """,
                (CYCLE_LEASE_NAME, normalized_owner, expires_at),
            )
        else:
            conn.execute(
                """
                UPDATE ai_direct_cycle_leases
                SET owner=?, expires_at=?
                WHERE lease_name=?
                """,
                (normalized_owner, expires_at, CYCLE_LEASE_NAME),
            )
        conn.commit()
        return {"acquired": True, "owner": normalized_owner, "expires_at": expires_at}
    except Exception:
        conn.rollback()
        raise


def cycle_end(conn: sqlite3.Connection, owner: str) -> dict[str, Any]:
    """Release the singleton lease only when owned by ``owner``."""
    normalized_owner = str(owner).strip()
    if not normalized_owner:
        raise ValueError("cycle lease owner is required")

    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            """
            DELETE FROM ai_direct_cycle_leases
            WHERE lease_name=? AND owner=?
            """,
            (CYCLE_LEASE_NAME, normalized_owner),
        )
        if cursor.rowcount == 1:
            conn.execute(
                """
                INSERT INTO ai_direct_cycle_log (completed_at, owner, detail_json)
                VALUES (?, ?, ?)
                """,
                (
                    int(utc_now()),
                    normalized_owner,
                    json.dumps(
                        {"event": "cycle_completed"},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                ),
            )
            conn.commit()
            return {"released": True}
        conn.rollback()
        return {"released": False}
    except Exception:
        conn.rollback()
        raise


def wait_live_slot(
    reserve_seconds: int = 150,
    safety_seconds: int = 6,
    sleep: bool = False,
    now: int | None = None,
) -> dict[str, Any]:
    """Return the earliest safe collection slot for the just-closed 5m candle.

    If the newest closed candle still has at least ``reserve_seconds`` before
    its live-execution deadline, the caller may collect immediately.  Otherwise
    (heartbeat arrived late or almost at the deadline) wait until the next 5m
    close plus the safety window, so the cycle always starts right after a
    candle close with a full live window.
    """
    import math
    import time as _time

    now_value = int(now if now is not None else utc_now())
    latest_open = math.floor((now_value - safety_seconds) / BAR_SECONDS) * BAR_SECONDS - BAR_SECONDS
    deadline = latest_open + LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS
    if now_value + reserve_seconds <= deadline:
        return {
            "action": "collect_now",
            "latest_open": latest_open,
            "deadline": deadline,
            "sleep_until": None,
        }
    next_close = math.floor(now_value / BAR_SECONDS) * BAR_SECONDS + BAR_SECONDS
    sleep_until = next_close + safety_seconds
    if sleep:
        remaining = sleep_until - int(_time.time())
        if remaining > 0:
            _time.sleep(remaining)
        now_value = int(utc_now())
        latest_open = math.floor((now_value - safety_seconds) / BAR_SECONDS) * BAR_SECONDS - BAR_SECONDS
        deadline = latest_open + LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS
        return {
            "action": "collect_now",
            "latest_open": latest_open,
            "deadline": deadline,
            "sleep_until": sleep_until,
        }
    return {
        "action": "wait_for_next_close",
        "latest_open": latest_open,
        "deadline": deadline,
        "sleep_until": sleep_until,
    }


def cycle_wait(
    conn: sqlite3.Connection,
    owner: str,
    lease_seconds: int = 600,
    timeout_seconds: int = 900,
    poll_seconds: int = 15,
    now: int | None = None,
) -> dict[str, Any]:
    """Wait for the singleton cycle lease instead of skipping the round.

    If a previous cycle is still running, poll until it releases the lease and
    then acquire immediately.  This implements "wait for the previous task,
    then run right away" instead of quietly dropping the heartbeat.
    """
    import time as _time

    started = int(now if now is not None else utc_now())
    last_block: dict[str, Any] = {}
    while True:
        result = cycle_begin(conn, owner, lease_seconds)
        if result.get("acquired"):
            result["waited_seconds"] = int(utc_now()) - started
            return result
        last_block = result
        if int(utc_now()) - started >= timeout_seconds:
            return {
                "acquired": False,
                "owner": last_block.get("owner"),
                "expires_at": last_block.get("expires_at"),
                "timeout_seconds": timeout_seconds,
            }
        _time.sleep(max(1, min(int(poll_seconds), 60)))


def _lease_begin(
    conn: sqlite3.Connection,
    lease_name: str,
    owner: str,
    lease_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    normalized_owner, seconds = _validate_cycle_lease(owner, lease_seconds)
    now_value = int(now if now is not None else utc_now())
    expires_at = now_value + seconds
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT owner,expires_at FROM ai_direct_cycle_leases WHERE lease_name=?",
            (lease_name,),
        ).fetchone()
        if row is not None and row["owner"] != normalized_owner and int(row["expires_at"]) > now_value:
            conn.rollback()
            return {
                "acquired": False,
                "owner": row["owner"],
                "expires_at": int(row["expires_at"]),
            }
        conn.execute(
            """
            INSERT INTO ai_direct_cycle_leases (lease_name,owner,expires_at)
            VALUES (?,?,?)
            ON CONFLICT(lease_name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
            """,
            (lease_name, normalized_owner, expires_at),
        )
        conn.commit()
        return {"acquired": True, "owner": normalized_owner, "expires_at": expires_at}
    except Exception:
        conn.rollback()
        raise


def _lease_end(conn: sqlite3.Connection, lease_name: str, owner: str) -> dict[str, Any]:
    normalized_owner = str(owner).strip()
    if not normalized_owner:
        raise ValueError("lease owner is required")
    cursor = conn.execute(
        "DELETE FROM ai_direct_cycle_leases WHERE lease_name=? AND owner=?",
        (lease_name, normalized_owner),
    )
    conn.commit()
    return {"released": cursor.rowcount == 1}


def executor_begin(
    conn: sqlite3.Connection,
    owner: str,
    lease_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    return _lease_begin(conn, EXECUTOR_LEASE_NAME, owner, lease_seconds, now)


def executor_end(conn: sqlite3.Connection, owner: str) -> dict[str, Any]:
    return _lease_end(conn, EXECUTOR_LEASE_NAME, owner)


def decode_payload(encoded: str) -> dict[str, Any]:
    raw = base64.b64decode(encoded.encode("ascii"), validate=True)
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("payload must be a JSON object")
    return value


def validate_market(vendor: str, symbol: str, timeframe: str) -> None:
    if (vendor, symbol) not in ALLOWED_MARKETS:
        raise ValueError(f"market is not enabled for direct AI: {vendor}:{symbol}")
    if str(timeframe) != TIMEFRAME:
        raise ValueError(f"only {TIMEFRAME}m is enabled, got {timeframe}")


def eligible_cutoff(now: int | None = None) -> int:
    return int(now if now is not None else utc_now()) - SAFETY_SECONDS


def assert_final_bar(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    timeframe: str,
    bar_time: int,
    now: int | None = None,
) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume,is_final
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND open_time=?
        """,
        (vendor, symbol, timeframe, bar_time),
    ).fetchone()
    if row is None:
        raise ValueError(f"bar not found: {vendor}:{symbol} {timeframe} {bar_time}")
    if int(row["is_final"]) != 1:
        raise ValueError("bar is not marked final")
    cutoff = eligible_cutoff(now)
    if int(row["open_time"]) + BAR_SECONDS > cutoff:
        raise ValueError(
            f"bar has not passed close safety window: close={int(row['open_time']) + BAR_SECONDS} cutoff={cutoff}"
        )
    return row


def pack_bar(row: sqlite3.Row) -> list[float | int | None]:
    return [
        int(row["open_time"]),
        float(row["open"]),
        float(row["high"]),
        float(row["low"]),
        float(row["close"]),
        None if row["volume"] is None else float(row["volume"]),
    ]


def live_execution_deadline(bar_time: int) -> int:
    return int(bar_time) + LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS


def live_execution_freshness(
    bar_time: int,
    now: int | None = None,
    reserve_seconds: int = MIN_EXECUTION_REMAINING_SECONDS,
) -> dict[str, Any]:
    now_value = int(now if now is not None else utc_now())
    deadline = live_execution_deadline(bar_time)
    remaining = deadline - now_value
    return {
        "fresh": remaining > max(0, int(reserve_seconds)),
        "bar_close_time": int(bar_time) + BAR_SECONDS,
        "execution_deadline": deadline,
        "checked_at": now_value,
        "seconds_remaining": remaining,
        "reserve_seconds": max(0, int(reserve_seconds)),
    }


def next_bars(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    timeframe: str,
    limit: int,
    now: int | None = None,
) -> dict[str, Any]:
    validate_market(vendor, symbol, timeframe)
    now_value = int(now if now is not None else utc_now())
    cutoff = eligible_cutoff(now)
    last_review = conn.execute(
        """
        SELECT MAX(bar_time) AS bar_time
        FROM ai_direct_reviews
        WHERE vendor=? AND symbol=? AND timeframe=?
        """,
        (vendor, symbol, timeframe),
    ).fetchone()
    last_time = None if last_review is None else last_review["bar_time"]

    if last_time is None:
        rows = conn.execute(
            """
            SELECT open_time,open,high,low,close,volume,is_final
            FROM candles
            WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
              AND open_time + ? <= ?
              AND open_time + ? > ?
            ORDER BY open_time DESC LIMIT 1
            """,
            (
                vendor,
                symbol,
                timeframe,
                BAR_SECONDS,
                cutoff,
                LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS,
                now_value + MIN_EXECUTION_REMAINING_SECONDS,
            ),
        ).fetchall()
        rows = list(reversed(rows))
        bootstrap = True
    else:
        rows = conn.execute(
            """
            SELECT open_time,open,high,low,close,volume,is_final
            FROM candles
            WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
              AND open_time>? AND open_time + ? <= ?
              AND open_time + ? > ?
            ORDER BY open_time DESC LIMIT ?
            """,
            (
                vendor,
                symbol,
                timeframe,
                int(last_time),
                BAR_SECONDS,
                cutoff,
                LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS,
                now_value + MIN_EXECUTION_REMAINING_SECONDS,
                limit,
            ),
        ).fetchall()
        rows = list(reversed(rows))
        bootstrap = False

    stale_unreviewed = conn.execute(
        """
        SELECT COUNT(*) AS count
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
          AND open_time>? AND open_time + ? <= ?
          AND open_time + ? <= ?
        """,
        (
            vendor,
            symbol,
            timeframe,
            -1 if last_time is None else int(last_time),
            BAR_SECONDS,
            cutoff,
            LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS,
            now_value + MIN_EXECUTION_REMAINING_SECONDS,
        ),
    ).fetchone()
    expired_count = int(stale_unreviewed["count"])
    pending_count = len(rows)
    if pending_count:
        monitor_result = "pending_review"
    elif expired_count:
        monitor_result = "expired_no_pending"
    else:
        monitor_result = "no_new_bar"

    latest_closed = conn.execute(
        """
        SELECT MAX(open_time) AS bar_time
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
          AND open_time + ? <= ?
        """,
        (vendor, symbol, timeframe, BAR_SECONDS, cutoff),
    ).fetchone()
    latest_closed_time = (
        None if latest_closed is None or latest_closed["bar_time"] is None
        else int(latest_closed["bar_time"])
    )
    conn.execute(
        """
        INSERT INTO ai_direct_monitor_status (
            vendor,symbol,timeframe,checked_at,latest_closed_bar_time,
            last_reviewed_bar_time,pending_count,expired_unreviewed_count,
            result,detail_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vendor,symbol,timeframe) DO UPDATE SET
            checked_at=excluded.checked_at,
            latest_closed_bar_time=excluded.latest_closed_bar_time,
            last_reviewed_bar_time=excluded.last_reviewed_bar_time,
            pending_count=excluded.pending_count,
            expired_unreviewed_count=excluded.expired_unreviewed_count,
            result=excluded.result,
            detail_json=excluded.detail_json
        """,
        (
            vendor,
            symbol,
            timeframe,
            now_value,
            latest_closed_time,
            None if last_time is None else int(last_time),
            pending_count,
            expired_count,
            monitor_result,
            json.dumps(
                {
                    "cutoff": cutoff,
                    "execution_reserve_seconds": MIN_EXECUTION_REMAINING_SECONDS,
                    "live_only": True,
                    "no_historical_backfill": True,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        ),
    )
    conn.commit()

    return {
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": timeframe,
        "cutoff": cutoff,
        "bootstrap_latest_only": bootstrap,
        "last_reviewed_bar_time": None if last_time is None else int(last_time),
        "live_only": True,
        "execution_reserve_seconds": MIN_EXECUTION_REMAINING_SECONDS,
        "expired_unreviewed_count": expired_count,
        "pending_count": pending_count,
        "pending_bars": [pack_bar(row) for row in rows],
        "columns": ["time", "open", "high", "low", "close", "volume"],
    }


def true_ranges(rows: list[sqlite3.Row]) -> list[float]:
    values: list[float] = []
    previous_close: float | None = None
    for row in rows:
        high = float(row["high"])
        low = float(row["low"])
        if previous_close is None:
            values.append(high - low)
        else:
            values.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
        previous_close = float(row["close"])
    return values


def rolling_average(values: list[float], length: int) -> list[float]:
    output: list[float] = []
    total = 0.0
    for index, value in enumerate(values):
        total += value
        if index >= length:
            total -= values[index - length]
        output.append(total / min(index + 1, length))
    return output


def snapshot_hash(snapshot: dict[str, Any]) -> str:
    canonical = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_snapshot(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    timeframe: str,
    bar_time: int,
    history_bars: int = 864,
    tail: int = 864,
    now: int | None = None,
) -> dict[str, Any]:
    validate_market(vendor, symbol, timeframe)
    target = assert_final_bar(conn, vendor, symbol, timeframe, bar_time, now)
    rows = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume,is_final
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
          AND open_time<=?
        ORDER BY open_time DESC LIMIT ?
        """,
        (vendor, symbol, timeframe, bar_time, history_bars),
    ).fetchall()
    rows = list(reversed(rows))
    if not rows or int(rows[-1]["open_time"]) != bar_time:
        raise ValueError("target bar is not the newest bar in the causal snapshot")

    closes = [float(row["close"]) for row in rows]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    atr14 = rolling_average(true_ranges(rows), 14)
    start = max(0, len(rows) - max(1, tail))
    recent = []
    for index in range(start, len(rows)):
        row = rows[index]
        recent.append(
            [
                int(row["open_time"]),
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                None if row["volume"] is None else float(row["volume"]),
                round(ema20[index], 8),
                round(ema50[index], 8),
                round(atr14[index], 8),
            ]
        )

    state = conn.execute(
        """
        SELECT bar_time,outer_state,inner_state,state_json,rules_version
        FROM analysis_state
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time<=?
          AND rules_version=?
        ORDER BY bar_time DESC LIMIT 1
        """,
        (vendor, symbol, timeframe, bar_time, RULES_VERSION),
    ).fetchone()
    previous_review = conn.execute(
        """
        SELECT bar_time,verdict,direction,setup_type,grade,outer_state,inner_state,
               reasons_json,location_summary,structure_summary,context_json
        FROM ai_direct_reviews
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time<?
          AND rules_version=?
        ORDER BY bar_time DESC LIMIT 1
        """,
        (vendor, symbol, timeframe, bar_time, RULES_VERSION),
    ).fetchone()
    ranges = conn.execute(
        """
        SELECT id,entity_id,start_time,end_time,upper,lower,source,locked,status,
               color,created_at,updated_at
        FROM chart_ranges
        WHERE vendor=? AND symbol=? AND timeframe=? AND status='active'
          AND start_time<=?
        ORDER BY locked DESC, source='manual' DESC, start_time, id
        """,
        (vendor, symbol, timeframe, bar_time),
    ).fetchall()
    recent_signals = conn.execute(
        """
        SELECT id,bar_time,signal_price,direction,setup_type,grade,
               reasons_json,context_json,created_at,acknowledged_at
        FROM signals
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time<=?
          AND rules_version=?
        ORDER BY bar_time DESC LIMIT 8
        """,
        (vendor, symbol, timeframe, bar_time, RULES_VERSION),
    ).fetchall()

    # Build JSON manually for signals to avoid ambiguous expression precedence.
    signal_values: list[dict[str, Any]] = []
    for row in recent_signals:
        value = dict(row)
        value["reasons"] = json.loads(value.pop("reasons_json") or "[]")
        value["context"] = json.loads(value.pop("context_json") or "{}")
        signal_values.append(value)

    previous_review_value = None
    if previous_review is not None:
        previous_review_value = dict(previous_review)
        previous_review_value["reasons"] = json.loads(previous_review_value.pop("reasons_json") or "[]")
        previous_review_value["context"] = json.loads(previous_review_value.pop("context_json") or "{}")

    snapshot: dict[str, Any] = {
        "schema_version": 1,
        "purpose": "direct_ai_causal_review",
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": timeframe,
        "bar_time": bar_time,
        "data_cutoff": bar_time,
        "bar_close_time": bar_time + BAR_SECONDS,
        "no_future_bars": True,
        "max_included_bar_time": int(rows[-1]["open_time"]),
        "target_bar": pack_bar(target),
        "history_summary": {
            "bar_count": len(rows),
            "from": int(rows[0]["open_time"]),
            "to": int(rows[-1]["open_time"]),
            "window_high": max(float(row["high"]) for row in rows),
            "window_low": min(float(row["low"]) for row in rows),
            "confirmed_pivots": confirmed_pivots(rows, 3)[-40:],
        },
        "recent_columns": [
            "time", "open", "high", "low", "close", "volume", "ema20", "ema50", "atr14_descriptive_only"
        ],
        "recent_bars": recent,
        "active_chart_ranges": [dict(row) for row in ranges],
        "manual_range_priority": True,
        "previous_state": (
            {
                "bar_time": int(state["bar_time"]),
                "outer_state": state["outer_state"],
                "inner_state": state["inner_state"],
                "state": json.loads(state["state_json"] or "{}"),
                "rules_version": state["rules_version"],
            }
            if state
            else None
        ),
        "previous_direct_review": previous_review_value,
        "recent_formal_signals": signal_values,
        "program_policy": {
            "candidate_prefilter_used": False,
            "atr_or_candle_position_gate_used": False,
            "decision_owner": "AI",
            "program_role": "collection_cutoff_audit_dedupe_execution_only",
            "rules_version": RULES_VERSION,
            "rule_sources": rule_source_manifest(),
            "session_requirements": "本次XAU逐根复盘要求（见 AI_DIRECT_MONITOR.md）",
        },
    }
    snapshot["snapshot_sha256"] = snapshot_hash(snapshot)
    return snapshot


def validate_decision(decision: dict[str, Any], close: float, bar_time: int) -> None:
    verdict = str(decision.get("verdict", ""))
    if verdict not in ALLOWED_VERDICTS:
        raise ValueError(f"invalid verdict: {verdict}")
    reasons = decision.get("reasons")
    if not isinstance(reasons, list) or not reasons or not all(str(item).strip() for item in reasons):
        raise ValueError("reasons must be a non-empty list")
    if not str(decision.get("outer_state", "")).strip() or not str(decision.get("inner_state", "")).strip():
        raise ValueError("outer_state and inner_state are required for every review")
    if verdict == "SIGNAL":
        if decision.get("direction") not in {"long", "short"}:
            raise ValueError("SIGNAL requires long or short direction")
        if decision.get("grade", "none") != "none":
            raise ValueError("XAU replay rules do not use A/B grades")
        if decision.get("setup_type") not in ALLOWED_SETUPS:
            raise ValueError("SIGNAL uses an unsupported setup_type")
        context = decision.get("context")
        if not isinstance(context, dict):
            raise ValueError("SIGNAL requires context")
        audit = context.get("second_time_audit")
        if not isinstance(audit, dict):
            raise ValueError("SIGNAL requires second_time_audit")
        expected_close_time = int(bar_time) + BAR_SECONDS
        if audit.get("passed") is not True:
            raise ValueError("second_time_audit did not pass")
        if int(audit.get("data_cutoff", -1)) != int(bar_time):
            raise ValueError("second_time_audit data_cutoff mismatch")
        if int(audit.get("max_included_bar_time", -1)) != int(bar_time):
            raise ValueError("second_time_audit included a future bar")
        if int(audit.get("signal_bar_time", -1)) != int(bar_time):
            raise ValueError("second_time_audit signal bar mismatch")
        if int(audit.get("earliest_decision_time", -1)) != expected_close_time:
            raise ValueError("second_time_audit earliest decision time mismatch")
        if int(audit.get("future_reference_count", -1)) != 0:
            raise ValueError("second_time_audit contains future references")
        confirmation = float(decision["confirmation_price"])
        invalidation = float(decision["invalidation_price"])
        if decision["direction"] == "long" and not (confirmation >= close and invalidation < close):
            raise ValueError("invalid long confirmation/invalidation levels")
        if decision["direction"] == "short" and not (confirmation <= close and invalidation > close):
            raise ValueError("invalid short confirmation/invalidation levels")
    else:
        if decision.get("direction", "none") != "none":
            raise ValueError(f"{verdict} must use direction=none")
        if decision.get("grade", "none") != "none":
            raise ValueError(f"{verdict} must use grade=none")
        if decision.get("setup_type", "none") != "none":
            raise ValueError(f"{verdict} must use setup_type=none")


def record_review(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    now: int | None = None,
) -> dict[str, Any]:
    vendor = str(payload["vendor"])
    symbol = str(payload["symbol"])
    timeframe = str(payload.get("timeframe", TIMEFRAME))
    bar_time = int(payload["bar_time"])
    validate_market(vendor, symbol, timeframe)

    # Check the primary key before rebuilding the causal snapshot.  A concurrent
    # writer may have already recorded this bar and changed analysis_state while
    # this caller was preparing its payload; that is a benign duplicate, not a
    # snapshot-integrity failure.
    existing = conn.execute(
        """
        SELECT 1
        FROM ai_direct_reviews
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?
        """,
        (vendor, symbol, timeframe, bar_time),
    ).fetchone()
    if existing is not None:
        return {"inserted": False, "duplicate": True, "should_execute": False}

    snapshot = build_snapshot(conn, vendor, symbol, timeframe, bar_time)
    supplied_hash = str(payload.get("snapshot_sha256", ""))
    if supplied_hash != snapshot["snapshot_sha256"]:
        # The row may have been inserted after the initial existence check while
        # this snapshot was being rebuilt.  Re-check before treating the hash
        # mismatch as an invalid (non-duplicate) submission.
        raced = conn.execute(
            """
            SELECT 1
            FROM ai_direct_reviews
            WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?
            """,
            (vendor, symbol, timeframe, bar_time),
        ).fetchone()
        if raced is not None:
            return {"inserted": False, "duplicate": True, "should_execute": False}
        raise ValueError("snapshot hash mismatch; decision is not bound to the causal snapshot")
    decision = payload.get("decision")
    if not isinstance(decision, dict):
        raise ValueError("decision must be an object")
    close = float(snapshot["target_bar"][4])
    validate_decision(decision, close, bar_time)

    reviewed_at = int(now if now is not None else utc_now())
    freshness = live_execution_freshness(bar_time, reviewed_at)
    context = decision.get("context") if isinstance(decision.get("context"), dict) else {}
    context = {
        **context,
        "data_cutoff": bar_time,
        "snapshot_sha256": snapshot["snapshot_sha256"],
        "no_future_bars": True,
        "decision_owner": "AI",
        "candidate_prefilter_used": False,
        "rules_version": RULES_VERSION,
        "live_execution": freshness,
    }
    if decision["verdict"] != "SIGNAL":
        execution_status = "not_required"
        execution_detail: dict[str, Any] = {}
    elif freshness["fresh"]:
        execution_status = "pending"
        execution_detail = {"live_execution": freshness}
    else:
        execution_status = "expired"
        execution_detail = {
            "reason": "live_signal_deadline_exceeded",
            "live_execution": freshness,
            "verdict_preserved_for_audit": True,
        }
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO ai_direct_reviews (
            vendor,symbol,timeframe,bar_time,data_cutoff,snapshot_sha256,
            model,reasoning_effort,verdict,direction,setup_type,grade,
            outer_state,inner_state,reasons_json,location_summary,
            structure_summary,confirmation_price,invalidation_price,
            context_json,rules_version,execution_status,execution_detail_json,reviewed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            vendor,
            symbol,
            timeframe,
            bar_time,
            bar_time,
            snapshot["snapshot_sha256"],
            str(payload.get("model", "deepseek-v4-flash")),
            str(payload.get("reasoning_effort", "max")),
            decision["verdict"],
            str(decision.get("direction", "none")),
            str(decision.get("setup_type", "none")),
            str(decision.get("grade", "none")),
            str(decision["outer_state"]),
            str(decision["inner_state"]),
            json.dumps(decision["reasons"], ensure_ascii=False, separators=(",", ":")),
            str(decision.get("location_summary", "")),
            str(decision.get("structure_summary", "")),
            None if decision.get("confirmation_price") is None else float(decision["confirmation_price"]),
            None if decision.get("invalidation_price") is None else float(decision["invalidation_price"]),
            json.dumps(context, ensure_ascii=False, separators=(",", ":")),
            RULES_VERSION,
            execution_status,
            json.dumps(execution_detail, ensure_ascii=False, separators=(",", ":")),
            reviewed_at,
        ),
    )
    conn.commit()
    inserted = cursor.rowcount == 1
    if not inserted:
        return {"inserted": False, "duplicate": True, "should_execute": False}

    save_state(
        conn,
        {
            "vendor": vendor,
            "symbol": symbol,
            "timeframe": timeframe,
            "bar_time": bar_time,
            "outer_state": decision["outer_state"],
            "inner_state": decision["inner_state"],
            "state": {
                "source": "direct_ai",
                "verdict": decision["verdict"],
                "reasons": decision["reasons"],
                "snapshot_sha256": snapshot["snapshot_sha256"],
                "context": context,
            },
            "rules_version": RULES_VERSION,
        },
    )
    result: dict[str, Any] = {
        "inserted": True,
        "duplicate": False,
        "should_execute": decision["verdict"] == "SIGNAL" and execution_status == "pending",
        "execution_status": execution_status,
        "live_execution": freshness,
    }
    if result["should_execute"]:
        target = snapshot["target_bar"]
        result["execution_payload"] = {
            "candidate": {
                "vendor": vendor,
                "symbol": symbol,
                "timeframe": timeframe,
                "bar_time": bar_time,
                "open": target[1],
                "high": target[2],
                "low": target[3],
                "close": target[4],
                "volume": target[5],
                "atr14": snapshot["recent_bars"][-1][8],
                "data_cutoff": bar_time,
                "snapshot_sha256": snapshot["snapshot_sha256"],
            },
            "decision": {
                **decision,
                "context": context,
            },
        }
    return result


def _execution_payload_from_review(
    conn: sqlite3.Connection,
    review: sqlite3.Row,
) -> dict[str, Any]:
    vendor = str(review["vendor"])
    symbol = str(review["symbol"])
    timeframe = str(review["timeframe"])
    bar_time = int(review["bar_time"])
    rows = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume,is_final
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
          AND open_time<=?
        ORDER BY open_time DESC LIMIT 64
        """,
        (vendor, symbol, timeframe, bar_time),
    ).fetchall()
    rows = list(reversed(rows))
    if not rows or int(rows[-1]["open_time"]) != bar_time:
        raise ValueError("execution queue cannot reconstruct the signal candle")
    target = rows[-1]
    atr14 = rolling_average(true_ranges(rows), 14)[-1]
    context = json.loads(review["context_json"] or "{}")
    decision = {
        "verdict": str(review["verdict"]),
        "direction": str(review["direction"]),
        "setup_type": str(review["setup_type"]),
        "grade": str(review["grade"]),
        "outer_state": str(review["outer_state"]),
        "inner_state": str(review["inner_state"]),
        "reasons": json.loads(review["reasons_json"] or "[]"),
        "location_summary": str(review["location_summary"]),
        "structure_summary": str(review["structure_summary"]),
        "confirmation_price": float(review["confirmation_price"]),
        "invalidation_price": float(review["invalidation_price"]),
        "context": context,
    }
    return {
        "candidate": {
            "vendor": vendor,
            "symbol": symbol,
            "timeframe": timeframe,
            "bar_time": bar_time,
            "open": float(target["open"]),
            "high": float(target["high"]),
            "low": float(target["low"]),
            "close": float(target["close"]),
            "volume": None if target["volume"] is None else float(target["volume"]),
            "atr14": round(float(atr14), 8),
            "data_cutoff": int(review["data_cutoff"]),
            "snapshot_sha256": str(review["snapshot_sha256"]),
        },
        "decision": decision,
    }


def _expire_pending_executions(
    conn: sqlite3.Connection,
    now_value: int,
    reserve_seconds: int = MIN_EXECUTION_REMAINING_SECONDS,
) -> list[dict[str, Any]]:
    stale = conn.execute(
        """
        SELECT vendor,symbol,timeframe,bar_time
        FROM ai_direct_reviews
        WHERE verdict='SIGNAL' AND execution_status='pending'
          AND bar_time + ? <= ?
        ORDER BY bar_time,vendor,symbol,timeframe
        """,
        (
            LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS,
            int(now_value) + max(0, int(reserve_seconds)),
        ),
    ).fetchall()
    expired: list[dict[str, Any]] = []
    for row in stale:
        freshness = live_execution_freshness(
            int(row["bar_time"]),
            int(now_value),
            reserve_seconds,
        )
        detail = {
            "reason": "live_signal_deadline_exceeded",
            "live_execution": freshness,
            "verdict_preserved_for_audit": True,
        }
        conn.execute(
            """
            UPDATE ai_direct_reviews
            SET execution_status='expired',execution_owner='',execution_claimed_at=NULL,
                execution_detail_json=?
            WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?
              AND execution_status='pending'
            """,
            (
                json.dumps(detail, ensure_ascii=False, separators=(",", ":")),
                row["vendor"],
                row["symbol"],
                row["timeframe"],
                row["bar_time"],
            ),
        )
        expired.append(
            {
                "vendor": row["vendor"],
                "symbol": row["symbol"],
                "timeframe": row["timeframe"],
                "bar_time": int(row["bar_time"]),
                "execution_deadline": freshness["execution_deadline"],
            }
        )
    return expired


def expire_pending_executions(
    conn: sqlite3.Connection,
    now: int | None = None,
    reserve_seconds: int = MIN_EXECUTION_REMAINING_SECONDS,
) -> dict[str, Any]:
    now_value = int(now if now is not None else utc_now())
    conn.execute("BEGIN IMMEDIATE")
    try:
        expired = _expire_pending_executions(conn, now_value, reserve_seconds)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"expired_count": len(expired), "expired": expired, "checked_at": now_value}


def claim_execution(
    conn: sqlite3.Connection,
    owner: str,
    lease_seconds: int = 300,
    now: int | None = None,
) -> dict[str, Any]:
    """Expire late work, then atomically claim the oldest still-live signal."""
    normalized_owner, seconds = _validate_cycle_lease(owner, lease_seconds)
    now_value = int(now if now is not None else utc_now())
    stale_before = now_value - seconds
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            """
            UPDATE ai_direct_reviews
            SET execution_status='pending',execution_owner='',execution_claimed_at=NULL
            WHERE verdict='SIGNAL' AND execution_status='executing'
              AND execution_claimed_at IS NOT NULL AND execution_claimed_at<=?
            """,
            (stale_before,),
        )
        expired = _expire_pending_executions(conn, now_value)
        review = conn.execute(
            """
            SELECT *
            FROM ai_direct_reviews
            WHERE verdict='SIGNAL' AND execution_status='pending'
            ORDER BY bar_time,vendor,symbol,timeframe
            LIMIT 1
            """
        ).fetchone()
        if review is None:
            conn.commit()
            return {"claimed": False, "expired_count": len(expired), "expired": expired}
        cursor = conn.execute(
            """
            UPDATE ai_direct_reviews
            SET execution_status='executing',execution_owner=?,execution_claimed_at=?
            WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?
              AND execution_status='pending'
            """,
            (
                normalized_owner,
                now_value,
                review["vendor"],
                review["symbol"],
                review["timeframe"],
                review["bar_time"],
            ),
        )
        if cursor.rowcount != 1:
            raise RuntimeError("execution claim lost an atomic update race")
        execution_payload = _execution_payload_from_review(conn, review)
        conn.commit()
        return {
            "claimed": True,
            "owner": normalized_owner,
            "claimed_at": now_value,
            "execution_deadline": live_execution_deadline(int(review["bar_time"])),
            "seconds_remaining": live_execution_deadline(int(review["bar_time"])) - now_value,
            "expired_count": len(expired),
            "expired": expired,
            "key": {
                "vendor": review["vendor"],
                "symbol": review["symbol"],
                "timeframe": review["timeframe"],
                "bar_time": int(review["bar_time"]),
            },
            "execution_payload": execution_payload,
        }
    except Exception:
        conn.rollback()
        raise


def mark_execution(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    vendor = str(payload["vendor"])
    symbol = str(payload["symbol"])
    timeframe = str(payload.get("timeframe", TIMEFRAME))
    bar_time = int(payload["bar_time"])
    validate_market(vendor, symbol, timeframe)
    status = str(payload["status"])
    if status not in {"succeeded", "failed", "duplicate", "expired"}:
        raise ValueError("invalid execution status")
    owner = str(payload.get("owner", "")).strip()
    params: list[Any] = [
        status,
        json.dumps(payload.get("detail", {}), ensure_ascii=False, separators=(",", ":")),
        vendor,
        symbol,
        timeframe,
        bar_time,
    ]
    owner_clause = ""
    if owner:
        owner_clause = " AND execution_status='executing' AND execution_owner=?"
        params.append(owner)
    cursor = conn.execute(
        f"""
        UPDATE ai_direct_reviews
        SET execution_status=?, execution_detail_json=?
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?{owner_clause}
        """,
        params,
    )
    conn.commit()
    if cursor.rowcount != 1:
        raise ValueError("direct AI review row not found")
    return {"updated": True, "status": status}


def main() -> int:
    parser = argparse.ArgumentParser(description="Causal guard and audit store for direct-AI 5m reviews")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    sub = parser.add_subparsers(dest="command", required=True)

    next_parser = sub.add_parser("next")
    next_parser.add_argument("--vendor", required=True)
    next_parser.add_argument("--symbol", required=True)
    next_parser.add_argument("--timeframe", default=TIMEFRAME)
    next_parser.add_argument("--limit", type=int, default=3)

    snapshot_parser = sub.add_parser("snapshot")
    snapshot_parser.add_argument("--vendor", required=True)
    snapshot_parser.add_argument("--symbol", required=True)
    snapshot_parser.add_argument("--timeframe", default=TIMEFRAME)
    snapshot_parser.add_argument("--bar-time", type=int, required=True)
    snapshot_parser.add_argument("--history-bars", type=int, default=864)
    snapshot_parser.add_argument("--tail", type=int, default=864)

    record_parser = sub.add_parser("record")
    record_parser.add_argument("--payload-base64", required=True)

    mark_parser = sub.add_parser("mark-execution")
    mark_parser.add_argument("--payload-base64", required=True)

    claim_parser = sub.add_parser("claim-execution")
    claim_parser.add_argument("--owner", required=True)
    claim_parser.add_argument("--lease-seconds", type=int, default=300)

    sub.add_parser("expire-pending")

    executor_begin_parser = sub.add_parser("executor-begin")
    executor_begin_parser.add_argument("--owner", required=True)
    executor_begin_parser.add_argument("--lease-seconds", type=int, default=900)

    executor_end_parser = sub.add_parser("executor-end")
    executor_end_parser.add_argument("--owner", required=True)

    cycle_begin_parser = sub.add_parser("cycle-begin")
    cycle_begin_parser.add_argument("--owner", required=True)
    cycle_begin_parser.add_argument("--lease-seconds", required=True, type=int)

    cycle_end_parser = sub.add_parser("cycle-end")
    cycle_end_parser.add_argument("--owner", required=True)

    wait_live_slot_parser = sub.add_parser("wait-live-slot")
    wait_live_slot_parser.add_argument("--reserve-seconds", type=int, default=150)
    wait_live_slot_parser.add_argument("--safety-seconds", type=int, default=6)
    wait_live_slot_parser.add_argument("--sleep", action="store_true")

    cycle_wait_parser = sub.add_parser("cycle-wait")
    cycle_wait_parser.add_argument("--owner", required=True)
    cycle_wait_parser.add_argument("--lease-seconds", type=int, default=600)
    cycle_wait_parser.add_argument("--timeout-seconds", type=int, default=900)
    cycle_wait_parser.add_argument("--poll-seconds", type=int, default=15)

    args = parser.parse_args()
    conn = connect(Path(args.db))
    ensure_direct_schema(conn)
    if args.command == "next":
        result = next_bars(conn, args.vendor, args.symbol, str(args.timeframe), max(1, min(args.limit, 12)))
    elif args.command == "snapshot":
        result = build_snapshot(
            conn,
            args.vendor,
            args.symbol,
            str(args.timeframe),
            args.bar_time,
            max(144, min(args.history_bars, 1728)),
            max(72, min(args.tail, 864)),
        )
    elif args.command == "record":
        result = record_review(conn, decode_payload(args.payload_base64))
    elif args.command == "mark-execution":
        result = mark_execution(conn, decode_payload(args.payload_base64))
    elif args.command == "claim-execution":
        result = claim_execution(conn, args.owner, args.lease_seconds)
    elif args.command == "expire-pending":
        result = expire_pending_executions(conn)
    elif args.command == "executor-begin":
        result = executor_begin(conn, args.owner, args.lease_seconds)
    elif args.command == "executor-end":
        result = executor_end(conn, args.owner)
    elif args.command == "cycle-begin":
        result = cycle_begin(conn, args.owner, args.lease_seconds)
    elif args.command == "wait-live-slot":
        result = wait_live_slot(
            reserve_seconds=args.reserve_seconds,
            safety_seconds=args.safety_seconds,
            sleep=args.sleep,
        )
    elif args.command == "cycle-wait":
        result = cycle_wait(
            conn,
            args.owner,
            lease_seconds=args.lease_seconds,
            timeout_seconds=args.timeout_seconds,
            poll_seconds=args.poll_seconds,
        )
    else:
        result = cycle_end(conn, args.owner)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
