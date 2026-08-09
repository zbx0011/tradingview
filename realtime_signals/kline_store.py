from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent
DEFAULT_DB = (
    Path(os.environ.get("LOCALAPPDATA", ROOT / "data"))
    / "TVFloat"
    / "market.db"
)


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS candles (
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL,
    is_final INTEGER NOT NULL DEFAULT 1,
    ingested_at INTEGER NOT NULL,
    PRIMARY KEY (vendor, symbol, timeframe, open_time)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup
ON candles (vendor, symbol, timeframe, open_time DESC);

CREATE TABLE IF NOT EXISTS analysis_state (
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    bar_time INTEGER NOT NULL,
    outer_state TEXT,
    inner_state TEXT,
    state_json TEXT NOT NULL,
    rules_version TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vendor, symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS chart_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    upper REAL NOT NULL,
    lower REAL NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
    locked INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'deleted')),
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (vendor, symbol, timeframe, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_chart_ranges_lookup
ON chart_ranges (vendor, symbol, timeframe, status, start_time, end_time);

CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    bar_time INTEGER NOT NULL,
    signal_price REAL NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('long', 'short', 'observe')),
    setup_type TEXT NOT NULL,
    grade TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    rules_version TEXT NOT NULL,
    model_version TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    UNIQUE (vendor, symbol, timeframe, bar_time, direction, setup_type)
);

CREATE INDEX IF NOT EXISTS idx_signals_lookup
ON signals (vendor, symbol, timeframe, bar_time DESC);

CREATE TABLE IF NOT EXISTS tv_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL,
    alert_kind TEXT NOT NULL CHECK (alert_kind IN ('confirmation', 'invalidation')),
    price REAL NOT NULL,
    condition TEXT NOT NULL,
    tradingview_alert_id TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    created_at INTEGER NOT NULL,
    UNIQUE (signal_id, alert_kind),
    FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS range_edge_alerts (
    range_id INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('lower', 'upper')),
    vendor TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    threshold REAL NOT NULL,
    condition TEXT NOT NULL,
    range_updated_at INTEGER NOT NULL,
    tradingview_alert_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (range_id, side),
    FOREIGN KEY (range_id) REFERENCES chart_ranges(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_range_edge_alerts_market
ON range_edge_alerts (vendor, symbol, timeframe, status);

CREATE TABLE IF NOT EXISTS reviews (
    signal_id INTEGER PRIMARY KEY,
    verdict TEXT NOT NULL,
    correction_json TEXT NOT NULL DEFAULT '{}',
    reviewed_at INTEGER NOT NULL,
    FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
);
"""


def utc_now() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # The collector and the three AI workers use separate processes/connections.
    # Give short WAL writer collisions time to clear instead of failing a cycle
    # immediately with ``database is locked``.
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
    signal_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(signals)").fetchall()
    }
    if "acknowledged_at" not in signal_columns:
        conn.execute("ALTER TABLE signals ADD COLUMN acknowledged_at INTEGER")
        conn.commit()
    return conn


def decode_payload(encoded: str) -> Any:
    raw = base64.b64decode(encoded.encode("ascii"))
    return json.loads(raw.decode("utf-8"))


def normalize_bar(
    item: Any,
    vendor: str,
    symbol: str,
    timeframe: str,
    default_final: bool,
) -> tuple[Any, ...]:
    if isinstance(item, list):
        if len(item) < 5:
            raise ValueError(f"Bar array must contain at least 5 values: {item!r}")
        timestamp, open_, high, low, close = item[:5]
        volume = item[5] if len(item) > 5 else None
        is_final = default_final
    elif isinstance(item, dict):
        timestamp = item.get("time", item.get("open_time"))
        open_ = item["open"]
        high = item["high"]
        low = item["low"]
        close = item["close"]
        volume = item.get("volume")
        is_final = bool(item.get("is_final", default_final))
    else:
        raise TypeError(f"Unsupported bar type: {type(item).__name__}")

    timestamp = int(timestamp)
    open_, high, low, close = map(float, (open_, high, low, close))
    volume = None if volume is None else float(volume)
    if high < max(open_, close) or low > min(open_, close) or high < low:
        raise ValueError(f"Invalid OHLC values at {timestamp}")

    return (
        vendor,
        symbol,
        timeframe,
        timestamp,
        open_,
        high,
        low,
        close,
        volume,
        1 if is_final else 0,
        utc_now(),
    )


def ingest(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    timeframe: str,
    bars: Iterable[Any],
    default_final: bool,
) -> dict[str, Any]:
    rows = [
        normalize_bar(item, vendor, symbol, timeframe, default_final)
        for item in bars
    ]
    before = conn.total_changes
    conn.executemany(
        """
        INSERT INTO candles (
            vendor, symbol, timeframe, open_time,
            open, high, low, close, volume, is_final, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vendor, symbol, timeframe, open_time) DO UPDATE SET
            open=excluded.open,
            high=excluded.high,
            low=excluded.low,
            close=excluded.close,
            volume=excluded.volume,
            is_final=MAX(candles.is_final, excluded.is_final),
            ingested_at=excluded.ingested_at
        """,
        rows,
    )
    conn.commit()
    changed = conn.total_changes - before
    latest = conn.execute(
        """
        SELECT open_time, close, is_final
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=?
        ORDER BY open_time DESC LIMIT 1
        """,
        (vendor, symbol, timeframe),
    ).fetchone()
    return {
        "received": len(rows),
        "changed": changed,
        "latest": dict(latest) if latest else None,
    }


def ema(values: list[float], length: int) -> list[float]:
    if not values:
        return []
    alpha = 2.0 / (length + 1.0)
    output = [values[0]]
    for value in values[1:]:
        output.append(alpha * value + (1.0 - alpha) * output[-1])
    return output


def confirmed_pivots(rows: list[sqlite3.Row], width: int = 3) -> list[dict[str, Any]]:
    pivots: list[dict[str, Any]] = []
    for index in range(width, len(rows) - width):
        current = rows[index]
        window = rows[index - width : index + width + 1]
        if all(float(item["high"]) <= float(current["high"]) for item in window):
            pivots.append(
                {
                    "type": "H",
                    "time": int(current["open_time"]),
                    "price": float(current["high"]),
                }
            )
        if all(float(item["low"]) >= float(current["low"]) for item in window):
            pivots.append(
                {
                    "type": "L",
                    "time": int(current["open_time"]),
                    "price": float(current["low"]),
                }
            )
    return pivots


def compact_snapshot(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    timeframe: str,
    bars: int,
    tail: int,
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT open_time, open, high, low, close, volume
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
        ORDER BY open_time DESC LIMIT ?
        """,
        (vendor, symbol, timeframe, bars),
    ).fetchall()
    rows = list(reversed(rows))
    if not rows:
        return {
            "vendor": vendor,
            "symbol": symbol,
            "timeframe": timeframe,
            "bar_count": 0,
        }

    closes = [float(row["close"]) for row in rows]
    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    pivots = confirmed_pivots(rows, 3)[-30:]
    state = conn.execute(
        """
        SELECT bar_time, outer_state, inner_state, state_json, rules_version
        FROM analysis_state
        WHERE vendor=? AND symbol=? AND timeframe=?
        """,
        (vendor, symbol, timeframe),
    ).fetchone()

    recent = []
    start = max(0, len(rows) - tail)
    for index, row in enumerate(rows[start:], start=start):
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
            ]
        )

    return {
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": timeframe,
        "bar_count": len(rows),
        "from": int(rows[0]["open_time"]),
        "to": int(rows[-1]["open_time"]),
        "last_close": closes[-1],
        "window_high": max(float(row["high"]) for row in rows),
        "window_low": min(float(row["low"]) for row in rows),
        "confirmed_pivots": pivots,
        "previous_state": (
            {
                "bar_time": int(state["bar_time"]),
                "outer_state": state["outer_state"],
                "inner_state": state["inner_state"],
                "state": json.loads(state["state_json"]),
                "rules_version": state["rules_version"],
            }
            if state
            else None
        ),
        "recent_columns": [
            "time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "ema20",
            "ema50",
        ],
        "recent_bars": recent,
    }


def save_state(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    now = utc_now()
    conn.execute(
        """
        INSERT INTO analysis_state (
            vendor, symbol, timeframe, bar_time, outer_state, inner_state,
            state_json, rules_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vendor, symbol, timeframe) DO UPDATE SET
            bar_time=excluded.bar_time,
            outer_state=excluded.outer_state,
            inner_state=excluded.inner_state,
            state_json=excluded.state_json,
            rules_version=excluded.rules_version,
            updated_at=excluded.updated_at
        """,
        (
            payload["vendor"],
            payload["symbol"],
            payload.get("timeframe", "5"),
            int(payload["bar_time"]),
            payload.get("outer_state"),
            payload.get("inner_state"),
            json.dumps(payload.get("state", {}), ensure_ascii=False),
            payload.get("rules_version", "louie-codex-v1"),
            now,
        ),
    )
    conn.commit()


def _normalize_range(item: dict[str, Any]) -> dict[str, Any]:
    start_time = min(int(item["start_time"]), int(item["end_time"]))
    end_time = max(int(item["start_time"]), int(item["end_time"]))
    upper = max(float(item["upper"]), float(item["lower"]))
    lower = min(float(item["upper"]), float(item["lower"]))
    if end_time <= start_time:
        raise ValueError("range end_time must be later than start_time")
    if upper <= lower:
        raise ValueError("range upper must be above lower")
    return {
        "entity_id": str(item["entity_id"]),
        "start_time": start_time,
        "end_time": end_time,
        "upper": upper,
        "lower": lower,
        "color": None if item.get("color") is None else str(item["color"]),
    }


def sync_chart_ranges(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> dict[str, Any]:
    """Synchronize orange TradingView rectangles into the authoritative range layer.

    New chart rectangles are treated as manual. If an auto-created rectangle is
    moved or resized on the chart, it is promoted to a locked manual range.
    Missing rectangles are retained as deleted tombstones so an hourly auto
    pass cannot recreate a range the user intentionally removed.
    """
    vendor = str(payload["vendor"])
    symbol = str(payload["symbol"])
    timeframe = str(payload.get("timeframe", "15"))
    now = utc_now()
    existing_rows = conn.execute(
        """
        SELECT * FROM chart_ranges
        WHERE vendor=? AND symbol=? AND timeframe=?
        """,
        (vendor, symbol, timeframe),
    ).fetchall()
    existing = {str(row["entity_id"]): row for row in existing_rows}
    seen: set[str] = set()
    inserted = updated = promoted = deleted = 0

    for raw in payload.get("ranges", []):
        item = _normalize_range(raw)
        entity_id = item["entity_id"]
        seen.add(entity_id)
        previous = existing.get(entity_id)
        if previous is None:
            conn.execute(
                """
                INSERT INTO chart_ranges (
                    vendor,symbol,timeframe,entity_id,start_time,end_time,
                    upper,lower,source,locked,status,color,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,'1','active',?,?,?)
                """,
                (
                    vendor,
                    symbol,
                    timeframe,
                    entity_id,
                    item["start_time"],
                    item["end_time"],
                    item["upper"],
                    item["lower"],
                    "manual",
                    item["color"],
                    now,
                    now,
                ),
            )
            inserted += 1
            continue

        price_tolerance = max(
            abs(float(previous["upper"])),
            abs(float(previous["lower"])),
            1.0,
        ) * 1e-7
        geometry_changed = (
            int(previous["start_time"]) != item["start_time"]
            or int(previous["end_time"]) != item["end_time"]
            or abs(float(previous["upper"]) - item["upper"]) > price_tolerance
            or abs(float(previous["lower"]) - item["lower"]) > price_tolerance
        )
        source = str(previous["source"])
        locked = int(previous["locked"])
        if source == "auto" and geometry_changed:
            source = "manual"
            locked = 1
            promoted += 1
        status_changed = str(previous["status"]) != "active"
        color_changed = (previous["color"] or None) != item["color"]
        effective_updated_at = (
            now
            if geometry_changed or status_changed or color_changed
            else int(previous["updated_at"])
        )
        conn.execute(
            """
            UPDATE chart_ranges
            SET start_time=?,end_time=?,upper=?,lower=?,source=?,locked=?,
                status='active',color=?,updated_at=?
            WHERE id=?
            """,
            (
                item["start_time"],
                item["end_time"],
                item["upper"],
                item["lower"],
                source,
                locked,
                item["color"],
                effective_updated_at,
                int(previous["id"]),
            ),
        )
        updated += 1

    for entity_id, previous in existing.items():
        if entity_id in seen or str(previous["status"]) != "active":
            continue
        conn.execute(
            """
            UPDATE chart_ranges
            SET status='deleted',locked=1,updated_at=?
            WHERE id=?
            """,
            (now, int(previous["id"])),
        )
        deleted += 1

    conn.commit()
    return {
        "synced": len(seen),
        "inserted": inserted,
        "updated": updated,
        "promoted_to_manual": promoted,
        "marked_deleted": deleted,
    }


def save_auto_range(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> dict[str, Any]:
    """Register an AI-proposed rectangle after it has been drawn on TradingView."""
    item = _normalize_range(payload)
    vendor = str(payload["vendor"])
    symbol = str(payload["symbol"])
    timeframe = str(payload.get("timeframe", "15"))
    now = utc_now()
    previous = conn.execute(
        """
        SELECT id,source,locked FROM chart_ranges
        WHERE vendor=? AND symbol=? AND timeframe=? AND entity_id=?
        """,
        (vendor, symbol, timeframe, item["entity_id"]),
    ).fetchone()
    if previous and (str(previous["source"]) == "manual" or int(previous["locked"])):
        return {"saved": False, "reason": "manual_range_has_priority"}
    conn.execute(
        """
        INSERT INTO chart_ranges (
            vendor,symbol,timeframe,entity_id,start_time,end_time,upper,lower,
            source,locked,status,color,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,'auto',0,'active',?,?,?)
        ON CONFLICT(vendor,symbol,timeframe,entity_id) DO UPDATE SET
            start_time=excluded.start_time,
            end_time=excluded.end_time,
            upper=excluded.upper,
            lower=excluded.lower,
            source='auto',
            locked=0,
            status='active',
            color=excluded.color,
            updated_at=excluded.updated_at
        """,
        (
            vendor,
            symbol,
            timeframe,
            item["entity_id"],
            item["start_time"],
            item["end_time"],
            item["upper"],
            item["lower"],
            item["color"],
            now,
            now,
        ),
    )
    conn.commit()
    return {"saved": True, "entity_id": item["entity_id"]}


def chart_range_records(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> list[dict[str, Any]]:
    clauses = ["vendor=?", "symbol=?", "timeframe=?"]
    values: list[Any] = [
        payload["vendor"],
        payload["symbol"],
        str(payload.get("timeframe", "15")),
    ]
    if not bool(payload.get("include_deleted", False)):
        clauses.append("status='active'")
    if payload.get("through_time") is not None:
        clauses.append("start_time<=?")
        values.append(int(payload["through_time"]))
    rows = conn.execute(
        f"""
        SELECT id,vendor,symbol,timeframe,entity_id,start_time,end_time,
               upper,lower,source,locked,status,color,created_at,updated_at
        FROM chart_ranges
        WHERE {' AND '.join(clauses)}
        ORDER BY locked DESC, source='manual' DESC, start_time, id
        """,
        values,
    ).fetchall()
    return [dict(row) for row in rows]


def save_signal(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO signals (
            vendor, symbol, timeframe, bar_time, signal_price,
            direction, setup_type, grade, reasons_json, context_json,
            rules_version, model_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload["vendor"],
            payload["symbol"],
            payload.get("timeframe", "5"),
            int(payload["bar_time"]),
            float(payload["signal_price"]),
            payload["direction"],
            payload["setup_type"],
            payload["grade"],
            json.dumps(payload.get("reasons", []), ensure_ascii=False),
            json.dumps(payload.get("context", {}), ensure_ascii=False),
            payload.get("rules_version", "louie-codex-v1"),
            payload.get("model_version", "codex"),
            utc_now(),
        ),
    )
    conn.commit()
    if cursor.rowcount == 1:
        return {"inserted": True, "signal_id": cursor.lastrowid}
    existing = conn.execute(
        """
        SELECT id FROM signals
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?
          AND direction=? AND setup_type=?
        """,
        (
            payload["vendor"],
            payload["symbol"],
            payload.get("timeframe", "5"),
            int(payload["bar_time"]),
            payload["direction"],
            payload["setup_type"],
        ),
    ).fetchone()
    return {
        "inserted": False,
        "signal_id": None if existing is None else existing["id"],
    }


def save_tv_alert(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist the link between an opportunity signal and its one-shot TV alert."""
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO tv_alerts (
            signal_id, alert_kind, price, condition, tradingview_alert_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(payload["signal_id"]),
            payload["alert_kind"],
            float(payload["price"]),
            payload["condition"],
            None if payload.get("tradingview_alert_id") is None else str(payload["tradingview_alert_id"]),
            payload.get("status", "created"),
            utc_now(),
        ),
    )
    conn.commit()
    return {"inserted": cursor.rowcount == 1, "alert_row_id": cursor.lastrowid}


def range_edge_alert_records(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT range_id,side,vendor,symbol,timeframe,threshold,condition,
               range_updated_at,tradingview_alert_id,status,created_at,updated_at
        FROM range_edge_alerts
        ORDER BY vendor,symbol,timeframe,range_id,side
        """
    ).fetchall()
    return [dict(row) for row in rows]


def upsert_range_edge_alert(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> dict[str, Any]:
    now = utc_now()
    conn.execute(
        """
        INSERT INTO range_edge_alerts (
            range_id,side,vendor,symbol,timeframe,threshold,condition,
            range_updated_at,tradingview_alert_id,status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(range_id,side) DO UPDATE SET
            vendor=excluded.vendor,
            symbol=excluded.symbol,
            timeframe=excluded.timeframe,
            threshold=excluded.threshold,
            condition=excluded.condition,
            range_updated_at=excluded.range_updated_at,
            tradingview_alert_id=excluded.tradingview_alert_id,
            status=excluded.status,
            updated_at=excluded.updated_at
        """,
        (
            int(payload["range_id"]),
            str(payload["side"]),
            str(payload["vendor"]),
            str(payload["symbol"]),
            str(payload.get("timeframe", "15")),
            float(payload["threshold"]),
            str(payload["condition"]),
            int(payload["range_updated_at"]),
            (
                None
                if payload.get("tradingview_alert_id") is None
                else str(payload["tradingview_alert_id"])
            ),
            str(payload.get("status", "created")),
            now,
            now,
        ),
    )
    conn.commit()
    return {
        "saved": True,
        "range_id": int(payload["range_id"]),
        "side": str(payload["side"]),
        "status": str(payload.get("status", "created")),
    }


def replaceable_tv_alerts(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> list[dict[str, Any]]:
    """Return older TVFloat alerts for one exact market and timeframe.

    TradingView is the source of truth for whether an alert is still active.
    This query intentionally returns only alerts created by this application,
    so a reviewer can never delete an unrelated user-created alert.
    """
    rows = conn.execute(
        """
        SELECT
            ta.id AS alert_row_id,
            ta.signal_id,
            ta.alert_kind,
            ta.price,
            ta.condition,
            ta.tradingview_alert_id,
            ta.status,
            s.vendor,
            s.symbol,
            s.timeframe,
            s.bar_time
        FROM tv_alerts AS ta
        JOIN signals AS s ON s.id = ta.signal_id
        WHERE s.vendor=?
          AND s.symbol=?
          AND s.timeframe=?
          AND ta.signal_id<>?
          AND ta.status='created'
          AND ta.tradingview_alert_id IS NOT NULL
        ORDER BY s.bar_time DESC, ta.id DESC
        """,
        (
            payload["vendor"],
            payload["symbol"],
            payload.get("timeframe", "5"),
            int(payload["exclude_signal_id"]),
        ),
    ).fetchall()
    return [dict(row) for row in rows]


def update_tv_alert_status(
    conn: sqlite3.Connection, payload: dict[str, Any]
) -> dict[str, Any]:
    """Record the observed lifecycle of one persisted TradingView alert."""
    status = str(payload["status"])
    allowed = {
        "created",
        "deleted_replaced",
        "inactive_triggered_or_expired",
        "delete_failed",
    }
    if status not in allowed:
        raise ValueError(f"unsupported tv alert status: {status}")

    if payload.get("alert_row_id") is not None:
        cursor = conn.execute(
            "UPDATE tv_alerts SET status=? WHERE id=?",
            (status, int(payload["alert_row_id"])),
        )
    elif payload.get("tradingview_alert_id") is not None:
        cursor = conn.execute(
            "UPDATE tv_alerts SET status=? WHERE tradingview_alert_id=?",
            (status, str(payload["tradingview_alert_id"])),
        )
    else:
        raise ValueError(
            "update-tv-alert-status requires alert_row_id or tradingview_alert_id"
        )
    conn.commit()
    return {"updated": cursor.rowcount == 1, "status": status}


def start_job_run(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    """Create a durable audit row for a background review run."""
    started_at = int(payload.get("started_at") or utc_now())
    status = str(payload.get("status") or "running")
    detail = payload.get("detail", {})
    cursor = conn.execute(
        """
        INSERT INTO job_runs (started_at, finished_at, status, detail_json)
        VALUES (?, NULL, ?, ?)
        """,
        (started_at, status, json.dumps(detail, ensure_ascii=False, separators=(",", ":"))),
    )
    conn.commit()
    return {"job_run_id": cursor.lastrowid, "status": status}


def finish_job_run(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    """Finish a background review audit row with success/failure detail."""
    job_run_id = int(payload["job_run_id"])
    finished_at = int(payload.get("finished_at") or utc_now())
    status = str(payload["status"])
    detail = payload.get("detail", {})
    cursor = conn.execute(
        """
        UPDATE job_runs
        SET finished_at=?, status=?, detail_json=?
        WHERE id=?
        """,
        (
            finished_at,
            status,
            json.dumps(detail, ensure_ascii=False, separators=(",", ":")),
            job_run_id,
        ),
    )
    conn.commit()
    return {"updated": cursor.rowcount == 1, "job_run_id": job_run_id, "status": status}


def latest_time(
    conn: sqlite3.Connection, vendor: str, symbol: str, timeframe: str
) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT open_time, close, is_final
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=?
        ORDER BY open_time DESC LIMIT 1
        """,
        (vendor, symbol, timeframe),
    ).fetchone()
    if not row:
        return {}
    result = dict(row)
    stats = conn.execute(
        """
        SELECT count(*) AS bar_count, min(open_time) AS earliest_open_time
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=?
        """,
        (vendor, symbol, timeframe),
    ).fetchone()
    result.update(dict(stats))
    return result


def pending_alerts(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, vendor, symbol, timeframe, bar_time, signal_price,
               direction, setup_type, grade, reasons_json, created_at
        FROM signals
        WHERE acknowledged_at IS NULL AND direction IN ('long', 'short')
        ORDER BY bar_time DESC, id DESC
        """
    ).fetchall()
    return [
        {
            **dict(row),
            "reasons": json.loads(row["reasons_json"]),
        }
        for row in rows
    ]


def acknowledge_alerts(
    conn: sqlite3.Connection,
    signal_id: int | None,
    vendor: str | None,
    symbol: str | None,
) -> int:
    now = utc_now()
    if signal_id is not None:
        cursor = conn.execute(
            """
            UPDATE signals SET acknowledged_at=?
            WHERE id=? AND acknowledged_at IS NULL
            """,
            (now, signal_id),
        )
    elif symbol:
        if vendor:
            cursor = conn.execute(
                """
                UPDATE signals SET acknowledged_at=?
                WHERE vendor=? AND symbol=? AND acknowledged_at IS NULL
                """,
                (now, vendor, symbol),
            )
        else:
            cursor = conn.execute(
                """
                UPDATE signals SET acknowledged_at=?
                WHERE symbol=? AND acknowledged_at IS NULL
                """,
                (now, symbol),
            )
    else:
        raise ValueError("acknowledge requires --signal-id or --symbol")
    conn.commit()
    return cursor.rowcount


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Incremental OHLCV and signal store")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init")

    ingest_parser = sub.add_parser("ingest")
    ingest_parser.add_argument("--vendor", required=True)
    ingest_parser.add_argument("--symbol", required=True)
    ingest_parser.add_argument("--timeframe", default="5")
    ingest_parser.add_argument("--payload-base64", required=True)
    ingest_parser.add_argument("--not-final", action="store_true")

    latest_parser = sub.add_parser("latest")
    latest_parser.add_argument("--vendor", required=True)
    latest_parser.add_argument("--symbol", required=True)
    latest_parser.add_argument("--timeframe", default="5")

    snapshot_parser = sub.add_parser("snapshot")
    snapshot_parser.add_argument("--vendor", required=True)
    snapshot_parser.add_argument("--symbol", required=True)
    snapshot_parser.add_argument("--timeframe", default="5")
    snapshot_parser.add_argument("--bars", type=int, default=864)
    snapshot_parser.add_argument("--tail", type=int, default=72)

    state_parser = sub.add_parser("save-state")
    state_parser.add_argument("--payload-base64", required=True)

    range_sync_parser = sub.add_parser("sync-chart-ranges")
    range_sync_parser.add_argument("--payload-base64", required=True)

    range_auto_parser = sub.add_parser("save-auto-range")
    range_auto_parser.add_argument("--payload-base64", required=True)

    range_records_parser = sub.add_parser("range-records")
    range_records_parser.add_argument("--payload-base64", required=True)

    signal_parser = sub.add_parser("save-signal")
    signal_parser.add_argument("--payload-base64", required=True)

    tv_alert_parser = sub.add_parser("save-tv-alert")
    tv_alert_parser.add_argument("--payload-base64", required=True)

    replaceable_alerts_parser = sub.add_parser("replaceable-tv-alerts")
    replaceable_alerts_parser.add_argument("--payload-base64", required=True)

    alert_status_parser = sub.add_parser("update-tv-alert-status")
    alert_status_parser.add_argument("--payload-base64", required=True)

    sub.add_parser("range-edge-alert-records")

    range_edge_alert_parser = sub.add_parser("upsert-range-edge-alert")
    range_edge_alert_parser.add_argument("--payload-base64", required=True)

    job_start_parser = sub.add_parser("start-job-run")
    job_start_parser.add_argument("--payload-base64", required=True)

    job_finish_parser = sub.add_parser("finish-job-run")
    job_finish_parser.add_argument("--payload-base64", required=True)

    sub.add_parser("alerts")

    acknowledge_parser = sub.add_parser("acknowledge")
    acknowledge_parser.add_argument("--signal-id", type=int)
    acknowledge_parser.add_argument("--vendor")
    acknowledge_parser.add_argument("--symbol")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    conn = connect(args.db)
    try:
        if args.command == "init":
            result: Any = {"success": True, "db": str(args.db.resolve())}
        elif args.command == "ingest":
            payload = decode_payload(args.payload_base64)
            bars = payload["bars"] if isinstance(payload, dict) else payload
            result = ingest(
                conn,
                args.vendor,
                args.symbol,
                args.timeframe,
                bars,
                not args.not_final,
            )
        elif args.command == "latest":
            result = latest_time(
                conn, args.vendor, args.symbol, args.timeframe
            )
        elif args.command == "snapshot":
            result = compact_snapshot(
                conn,
                args.vendor,
                args.symbol,
                args.timeframe,
                max(1, args.bars),
                max(1, args.tail),
            )
        elif args.command == "save-state":
            payload = decode_payload(args.payload_base64)
            save_state(conn, payload)
            result = {"saved": True}
        elif args.command == "sync-chart-ranges":
            payload = decode_payload(args.payload_base64)
            result = sync_chart_ranges(conn, payload)
        elif args.command == "save-auto-range":
            payload = decode_payload(args.payload_base64)
            result = save_auto_range(conn, payload)
        elif args.command == "range-records":
            payload = decode_payload(args.payload_base64)
            result = chart_range_records(conn, payload)
        elif args.command == "save-signal":
            payload = decode_payload(args.payload_base64)
            result = save_signal(conn, payload)
        elif args.command == "save-tv-alert":
            payload = decode_payload(args.payload_base64)
            result = save_tv_alert(conn, payload)
        elif args.command == "replaceable-tv-alerts":
            payload = decode_payload(args.payload_base64)
            result = replaceable_tv_alerts(conn, payload)
        elif args.command == "update-tv-alert-status":
            payload = decode_payload(args.payload_base64)
            result = update_tv_alert_status(conn, payload)
        elif args.command == "range-edge-alert-records":
            result = range_edge_alert_records(conn)
        elif args.command == "upsert-range-edge-alert":
            payload = decode_payload(args.payload_base64)
            result = upsert_range_edge_alert(conn, payload)
        elif args.command == "start-job-run":
            payload = decode_payload(args.payload_base64)
            result = start_job_run(conn, payload)
        elif args.command == "finish-job-run":
            payload = decode_payload(args.payload_base64)
            result = finish_job_run(conn, payload)
        elif args.command == "alerts":
            result = pending_alerts(conn)
        elif args.command == "acknowledge":
            result = {
                "acknowledged": acknowledge_alerts(
                    conn,
                    args.signal_id,
                    args.vendor,
                    args.symbol,
                )
            }
        else:
            raise AssertionError(args.command)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
