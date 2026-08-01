"""Render a no-future-data composite chart for one AI candidate."""
from __future__ import annotations

import argparse
from bisect import bisect_left
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from kline_store import DEFAULT_DB, ema


BEIJING = timezone(timedelta(hours=8))
BACKGROUND = "#101722"
PANEL = "#151e2c"
GRID = "#2b3749"
TEXT = "#dce5f2"
MUTED = "#8291a8"
UP = "#e9eef5"
DOWN = "#2f78ff"
EMA20 = "#2d7cff"
EMA50 = "#f5a623"
ACCENT = "#29d3c2"
RANGE_OUTLINE = "#f59e0b"
RANGE_FILL = "#4a3517"
CURRENT_RANGES: list[dict[str, Any]] = []


def scan_local_range_proposals(
    _rows: list[sqlite3.Row],
) -> list[dict[str, Any]]:
    """Numeric automatic range proposals are forbidden in production."""
    return []


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path(os.environ.get("WINDIR", r"C:\Windows"))
        / "Fonts"
        / ("msyhbd.ttc" if bold else "msyh.ttc"),
        Path(os.environ.get("WINDIR", r"C:\Windows"))
        / "Fonts"
        / ("arialbd.ttf" if bold else "arial.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def load_rows(
    db: Path, vendor: str, symbol: str, timeframe: str, bar_time: int, limit: int
) -> list[sqlite3.Row]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT open_time,open,high,low,close,volume
            FROM candles
            WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
              AND open_time<=?
            ORDER BY open_time DESC LIMIT ?
            """,
            (vendor, symbol, timeframe, bar_time, limit),
        ).fetchall()
    finally:
        conn.close()
    result = list(reversed(rows))
    if result and int(result[-1]["open_time"]) != bar_time:
        raise RuntimeError(
            f"candidate bar missing: requested={bar_time}, latest={result[-1]['open_time']}"
        )
    if any(int(row["open_time"]) > bar_time for row in result):
        raise RuntimeError("future bar detected in renderer input")
    return result


def load_ranges(
    db: Path,
    vendor: str,
    symbol: str,
    timeframe: str,
    first_time: int,
    bar_time: int,
) -> list[dict[str, Any]]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        try:
            rows = conn.execute(
                """
                SELECT entity_id,start_time,end_time,upper,lower,source,locked,
                       created_at,updated_at
                FROM chart_ranges
                WHERE vendor=? AND symbol=? AND timeframe=? AND status='active'
                  AND start_time<=? AND end_time>=?
                  AND (source='manual' OR created_at<=?)
                ORDER BY locked DESC,source='manual' DESC,start_time
                """,
                (
                    vendor,
                    symbol,
                    timeframe,
                    bar_time,
                    first_time,
                    bar_time + int(timeframe) * 60,
                ),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
    finally:
        conn.close()
    return [dict(row) for row in rows]


def load_replay_ranges(
    ranges_json: Path,
    vendor: str,
    symbol: str,
    timeframe: str,
    first_time: int,
    bar_time: int,
) -> list[dict[str, Any]]:
    """Load only reconstructed ranges already known at the replay cutoff."""
    payload = json.loads(ranges_json.read_text(encoding="utf-8"))
    ranges = [
        item
        for market in payload.get("markets", [])
        for item in market.get("ranges", [])
    ]
    eligible: list[dict[str, Any]] = []
    for item in ranges:
        if (
            str(item.get("vendor")) != vendor
            or str(item.get("symbol")) != symbol
            or str(item.get("timeframe")) != timeframe
        ):
            continue
        if int(item.get("first_detected_at", 0)) > bar_time:
            continue
        if int(item["start_time"]) > bar_time or int(item["end_time"]) < first_time:
            continue
        replay_item = dict(item)
        replay_item.setdefault(
            "entity_id", str(item.get("range_id") or "replay_range")
        )
        replay_item["source"] = "strict_causal_replay"
        replay_item["locked"] = False
        eligible.append(replay_item)
    return eligible


def _price(value: float) -> str:
    if abs(value) >= 1000:
        return f"{value:,.1f}"
    if abs(value) >= 100:
        return f"{value:,.2f}"
    return f"{value:,.4f}"


def draw_panel(
    image: Image.Image,
    box: tuple[int, int, int, int],
    rows: list[sqlite3.Row],
    title: str,
    ranges: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if ranges is None:
        ranges = CURRENT_RANGES
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = box
    draw.rounded_rectangle(box, radius=10, fill=PANEL, outline=GRID, width=1)
    header_height = 38
    price_right = 84
    plot_left = left + 14
    plot_top = top + header_height
    plot_right = right - price_right
    plot_bottom = bottom - 28
    draw.text((left + 14, top + 9), title, fill=TEXT, font=font(18, True))
    if not rows:
        draw.text((left + 14, top + 48), "No data", fill=MUTED, font=font(16))
        return {"bars": 0}

    highs = [float(row["high"]) for row in rows]
    lows = [float(row["low"]) for row in rows]
    closes = [float(row["close"]) for row in rows]
    raw_high, raw_low = max(highs), min(lows)
    padding = max((raw_high - raw_low) * 0.08, abs(raw_high) * 0.0002, 1e-6)
    price_high, price_low = raw_high + padding, raw_low - padding

    def y(value: float) -> float:
        return plot_top + (price_high - value) / (price_high - price_low) * (
            plot_bottom - plot_top
        )

    for index in range(5):
        value = price_high - index * (price_high - price_low) / 4
        line_y = int(y(value))
        draw.line((plot_left, line_y, plot_right, line_y), fill=GRID, width=1)
        draw.text(
            (plot_right + 8, line_y - 9),
            _price(value),
            fill=MUTED,
            font=font(13),
        )

    count = len(rows)
    step = max(1.0, (plot_right - plot_left) / max(count, 1))
    candle_width = max(1, int(step * 0.62))
    first_time = int(rows[0]["open_time"])
    bar_times = [int(row["open_time"]) for row in rows]
    bar_seconds = max(
        1,
        int(rows[1]["open_time"]) - first_time if len(rows) > 1 else 300,
    )

    for item in ranges:
        start_time = max(first_time, int(item["start_time"]))
        end_time = min(
            int(rows[-1]["open_time"]) + bar_seconds,
            int(item["end_time"]),
        )
        if end_time <= start_time:
            continue
        upper = float(item["upper"])
        lower = float(item["lower"])
        if upper < price_low or lower > price_high:
            continue
        # Map through loaded bar indices instead of wall-clock distance.
        # Forex/indices contain session and weekend gaps; wall-clock mapping
        # can place x1 beyond the right edge while x2 is clamped, producing an
        # inverted rectangle and breaking screenshot verification.
        start_index = min(count - 1, bisect_left(bar_times, start_time))
        end_index = min(count, bisect_left(bar_times, end_time))
        if end_index <= start_index:
            end_index = min(count, start_index + 1)
        x1 = plot_left + start_index * step
        x2 = plot_left + end_index * step
        y1 = y(min(upper, price_high))
        y2 = y(max(lower, price_low))
        draw.rectangle(
            (x1, y1, x2, y2),
            fill=RANGE_FILL,
            outline=RANGE_OUTLINE,
            width=2,
        )
        label = (
            "USER RANGE"
            if str(item.get("source")) == "manual"
            else "AUTO RANGE"
        )
        draw.text(
            (x1 + 5, y1 + 4),
            label,
            fill=RANGE_OUTLINE,
            font=font(11, True),
        )

    for index, row in enumerate(rows):
        center = plot_left + (index + 0.5) * step
        open_ = float(row["open"])
        high = float(row["high"])
        low = float(row["low"])
        close = float(row["close"])
        color = UP if close >= open_ else DOWN
        draw.line((center, y(high), center, y(low)), fill=color, width=1)
        body_top, body_bottom = sorted((y(open_), y(close)))
        if body_bottom - body_top < 1:
            body_bottom = body_top + 1
        draw.rectangle(
            (
                center - candle_width / 2,
                body_top,
                center + candle_width / 2,
                body_bottom,
            ),
            fill=color,
            outline=color,
        )

    for values, color, width in (
        (ema(closes, 20), EMA20, 2),
        (ema(closes, 50), EMA50, 1),
    ):
        points = [
            (plot_left + (index + 0.5) * step, y(float(value)))
            for index, value in enumerate(values)
        ]
        if len(points) >= 2:
            draw.line(points, fill=color, width=width)

    candidate_x = plot_left + (count - 0.5) * step
    draw.line(
        (candidate_x, plot_top, candidate_x, plot_bottom),
        fill=ACCENT,
        width=2,
    )
    candidate_close = float(rows[-1]["close"])
    candidate_y = y(candidate_close)
    draw.ellipse(
        (candidate_x - 5, candidate_y - 5, candidate_x + 5, candidate_y + 5),
        fill=ACCENT,
        outline="#ffffff",
        width=1,
    )
    draw.text(
        (max(plot_left, candidate_x - 126), plot_top + 6),
        "CANDIDATE (last closed bar)",
        fill=ACCENT,
        font=font(13, True),
    )

    label_count = min(5, count)
    for item in range(label_count):
        index = round(item * (count - 1) / max(label_count - 1, 1))
        row = rows[index]
        center = plot_left + (index + 0.5) * step
        label = datetime.fromtimestamp(int(row["open_time"]), BEIJING).strftime(
            "%m-%d %H:%M"
        )
        draw.text((center - 34, plot_bottom + 7), label, fill=MUTED, font=font(11))

    return {
        "bars": count,
        "start_time": int(rows[0]["open_time"]),
        "end_time": int(rows[-1]["open_time"]),
        "bar_seconds": bar_seconds,
        "low": raw_low,
        "high": raw_high,
        "close": candidate_close,
        "through_time": int(rows[-1]["open_time"]),
    }


def render(
    db: Path,
    vendor: str,
    symbol: str,
    timeframe: str,
    bar_time: int,
    output: Path,
    ignore_stored_ranges: bool = False,
    ranges_json: Path | None = None,
) -> dict[str, Any]:
    global CURRENT_RANGES
    timeframe_minutes = max(1, int(timeframe))
    outer_bar_count = max(144, round(36 * 60 / timeframe_minutes))
    inner_bar_count = max(36, round(9 * 60 / timeframe_minutes))
    rows = load_rows(
        db,
        vendor,
        symbol,
        timeframe,
        bar_time,
        outer_bar_count,
    )
    if len(rows) < inner_bar_count:
        raise RuntimeError(f"not enough bars to render: {len(rows)}")
    if ranges_json is not None:
        CURRENT_RANGES = load_replay_ranges(
            ranges_json,
            vendor,
            symbol,
            timeframe,
            int(rows[0]["open_time"]),
            bar_time,
        )
    else:
        CURRENT_RANGES = (
            []
            if ignore_stored_ranges
            else load_ranges(
                db,
                vendor,
                symbol,
                timeframe,
                int(rows[0]["open_time"]),
                bar_time,
            )
        )
    local_range_proposals = scan_local_range_proposals(rows)
    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1180, 820), BACKGROUND)
    draw = ImageDraw.Draw(image)
    through = datetime.fromtimestamp(bar_time, BEIJING).strftime("%Y-%m-%d %H:%M")
    draw.text(
        (24, 13),
        f"{vendor}:{symbol}  ·  {timeframe}m  ·  STRICT DATA CUTOFF {through} Beijing",
        fill=TEXT,
        font=font(20, True),
    )
    draw.text(
        (24, 43),
        "No bar after the candidate is included. Use outer state first, then inner state.",
        fill=MUTED,
        font=font(14),
    )
    outer = draw_panel(
        image,
        (20, 72, 1160, 460),
        rows,
        f"OUTER VIEW · last {len(rows)} bars (up to {len(rows) * int(timeframe) / 60:g} hours)",
    )
    inner_rows = rows[-inner_bar_count:]
    inner = draw_panel(
        image,
        (20, 478, 1160, 800),
        inner_rows,
        (
            f"INNER VIEW · last {len(inner_rows)} bars "
            f"({len(inner_rows) * int(timeframe) / 60:g} hours)"
        ),
    )
    image.save(output, format="PNG", optimize=True)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {
        "success": True,
        "output": str(output.resolve()),
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": timeframe,
        "bar_time": bar_time,
        "through_time": through,
        "no_future_bars": True,
        "outer": outer,
        "inner": inner,
        "chart_ranges": CURRENT_RANGES,
        "stored_ranges_ignored": ignore_stored_ranges,
        "replay_ranges_supplied": ranges_json is not None,
        "local_range_proposals": local_range_proposals,
        "sha256": digest,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--timeframe", default="5")
    parser.add_argument("--bar-time", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--ignore-stored-ranges",
        action="store_true",
        help="Exclude current/manual TradingView ranges from strict replay images.",
    )
    parser.add_argument(
        "--ranges-json",
        type=Path,
        help="Strict-causal reconstructed ranges to overlay on the replay image.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = render(
        args.db,
        args.vendor,
        args.symbol,
        args.timeframe,
        args.bar_time,
        args.output,
        args.ignore_stored_ranges,
        args.ranges_json,
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
