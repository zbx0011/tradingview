#!/usr/bin/env python3
"""Build a causal chart snapshot (text for the model + PNG archive).

Only bars <= idx are used. The text view is what deepseek-v4-flash (text-only)
consumes; the PNG is saved for human inspection and audit.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

try:
    from .xau_causal_gate import (
        BEIJING,
        confirmed_pivots,
        enrich,
        load_data,
        structure_hints,
    )
except ImportError:  # The runner copies this file into an isolated standalone work directory.
    from xau_causal_gate import (
        BEIJING,
        confirmed_pivots,
        enrich,
        load_data,
        structure_hints,
    )


def bj(ts: int) -> str:
    return datetime.fromtimestamp(ts, BEIJING).strftime("%Y-%m-%d %H:%M")


def build_snapshot_text(
    bars: list[dict[str, Any]],
    idx: int,
    *,
    symbol: str | None = None,
    timeframe_minutes: int | None = None,
) -> str:
    if idx < 0 or idx >= len(bars):
        raise ValueError(f"idx out of range: {idx}")
    bar = bars[idx]
    window = bars[max(0, idx - 39):idx + 1]
    tail100 = bars[max(0, idx - 99):idx + 1]
    pivots = confirmed_pivots(bars, idx)
    hints = structure_hints(bars, idx)
    indicator_text = f"EMA20={float(bar['ema20']):.3f}"
    if "ema50" in bar:
        indicator_text += f" EMA50={float(bar['ema50']):.3f}"
    indicator_text += f" ATR14={float(bar['atr14']):.3f}"
    identity = ""
    if symbol and timeframe_minutes:
        identity = f"{symbol} {timeframe_minutes}m；"
    lines = [
        f"=== 图表快照（{identity}截止 idx={idx}，{bj(int(bar['time']))} 开 / {bj(int(bar['close_time']))} 收） ===",
        f"当前K: O={float(bar['open']):.2f} H={float(bar['high']):.2f} L={float(bar['low']):.2f} C={float(bar['close']):.2f} V={int(bar.get('volume') or 0)}",
        indicator_text,
        f"近100根区间: H={max(float(b['high']) for b in tail100):.2f} L={min(float(b['low']) for b in tail100):.2f}",
        f"已确认枢轴(≤idx): " + ("; ".join(
            f"{p['kind']}@{p['idx']}({bj(int(bars[p['idx']]['time']))[5:16]} {p['price']:.2f})" for p in pivots
        ) if pivots else "无"),
        f"结构提示: {json.dumps(hints, ensure_ascii=False)}",
        "K线明细(最近40根, 时间为开):",
    ]
    for b in window:
        mark = " <== 当前" if int(b["time"]) == int(bar["time"]) else ""
        lines.append(
            f"{int(b['idx']):>3} {bj(int(b['time']))[5:16]} "
            f"O{float(b['open']):.2f} H{float(b['high']):.2f} L{float(b['low']):.2f} "
            f"C{float(b['close']):.2f} V{int(b.get('volume') or 0)}{mark}"
        )
    return "\n".join(lines)


def render_png(
    bars: list[dict[str, Any]],
    idx: int,
    out_path: Path,
    *,
    symbol: str = "UNKNOWN",
    timeframe_minutes: int = 0,
) -> Path:
    start = max(0, idx - 239)
    window = bars[start:idx + 1]
    W, H = 1200, 640
    pad_l, pad_r, pad_t, pad_b = 60, 20, 30, 140
    chart_h = H - pad_t - pad_b
    img = Image.new("RGB", (W, H), (13, 17, 23))
    draw = ImageDraw.Draw(img)
    highs = [float(b["high"]) for b in window]
    lows = [float(b["low"]) for b in window]
    vols = [float(b.get("volume") or 0) for b in window]
    hi, lo = max(highs), min(lows)
    span = max(hi - lo, 1e-6)
    vmax = max(vols) or 1.0
    n = len(window)
    cw = (W - pad_l - pad_r) / max(n, 1)

    def px(i: int, price: float) -> tuple[float, float]:
        return (pad_l + (i + 0.5) * cw, pad_t + (hi - price) / span * chart_h)

    indicator_series = [("ema20", (251, 146, 60))]
    if window and "ema50" in window[0]:
        indicator_series.append(("ema50", (96, 165, 250)))
    for key, color in indicator_series:
        pts = [px(i, float(b[key])) for i, b in enumerate(window)]
        if len(pts) > 1:
            draw.line(pts, fill=color, width=1)

    historical = structure_hints(bars, idx).get("historical_support_resistance") or {}
    for row in historical.get("supports", [])[:3]:
        for key, color in (("body_low", (22, 163, 74)), ("low", (21, 128, 61))):
            price = float(row[key])
            if lo <= price <= hi:
                y = px(0, price)[1]
                draw.line([(pad_l, y), (W - pad_r, y)], fill=color, width=1)
        price = float(row["body_low"])
        if lo <= price <= hi:
            draw.text((pad_l + 4, px(0, price)[1] - 12), f"S idx={row['idx']} age>{int(row['age_days'])}d", fill=(74, 222, 128))
    for row in historical.get("resistances", [])[:3]:
        for key, color in (("body_high", (220, 38, 38)), ("high", (153, 27, 27))):
            price = float(row[key])
            if lo <= price <= hi:
                y = px(0, price)[1]
                draw.line([(pad_l, y), (W - pad_r, y)], fill=color, width=1)
        price = float(row["body_high"])
        if lo <= price <= hi:
            draw.text((pad_l + 4, px(0, price)[1] - 12), f"R idx={row['idx']} age>{int(row['age_days'])}d", fill=(248, 113, 113))

    for i, b in enumerate(window):
        x = pad_l + (i + 0.5) * cw
        up = float(b["close"]) >= float(b["open"])
        color = (34, 197, 94) if up else (239, 68, 68)
        draw.line([(x, px(i, float(b["high"]))[1]), (x, px(i, float(b["low"]))[1])], fill=color, width=1)
        y1 = px(i, max(float(b["open"]), float(b["close"])))[1]
        y2 = px(i, min(float(b["open"]), float(b["close"])))[1]
        bw = max(cw * 0.62, 1.0)
        draw.rectangle([x - bw / 2, y1, x + bw / 2, y2], outline=color, width=1)
        if up:
            draw.rectangle([x - bw / 2, y1, x + bw / 2, y2], fill=(34, 197, 94))
        vh = (float(b.get("volume") or 0) / vmax) * 70
        draw.rectangle([x - bw / 2, H - 30 - vh, x + bw / 2, H - 30], outline=None, fill=(60, 70, 90))

    cur_x = pad_l + (n - 0.5) * cw
    draw.line([(cur_x, pad_t), (cur_x, pad_t + chart_h)], fill=(250, 204, 21), width=1)
    draw.text((cur_x - 40, pad_t + chart_h + 6), f"idx={idx} {bj(int(bars[idx]['time']))[5:16]}", fill=(250, 204, 21))
    timeframe_label = f"{timeframe_minutes}m" if timeframe_minutes > 0 else "?m"
    draw.text((pad_l, 8), f"{symbol} {timeframe_label} idx={idx} (bars <= current only)", fill=(240, 240, 240))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--idx", type=int, required=True)
    parser.add_argument(
        "--data",
        type=Path,
        default=Path(os.environ.get("XAU_DATA_FILE", str(Path.home() / "AppData" / "Local" / "Temp" / "xauusd_luna_compare_634bars.json"))),
    )
    parser.add_argument("--out-dir", type=Path, default=Path.cwd() / "snapshots")
    args = parser.parse_args()
    payload, raw = load_data(args.data)
    timeframe_minutes = int(payload["timeframe_minutes"])
    symbol = str(payload["symbol"])
    bars = enrich(raw, timeframe_minutes)
    text = build_snapshot_text(
        bars,
        args.idx,
        symbol=symbol,
        timeframe_minutes=timeframe_minutes,
    )
    png = render_png(
        bars,
        args.idx,
        args.out_dir / f"snapshot_{args.idx:04d}.png",
        symbol=symbol,
        timeframe_minutes=timeframe_minutes,
    )
    print(json.dumps({"idx": args.idx, "text": text, "png": str(png)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
