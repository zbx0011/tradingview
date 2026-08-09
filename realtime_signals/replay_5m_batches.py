#!/usr/bin/env python3
# louie规则回放（20260806版本）
"""Generate strictly causal per-bar context batches for the 5m XAGUSD replay.

Each batch file contains only data available at the batch start plus the
OHLC/indicators of the bars inside the batch itself. Nothing after a bar is
ever included in that bar's line, and EMA/ATR/pivots are computed sequentially
over the full series so they are backward-looking only.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TVFloat" / "market.db"
BEIJING = timezone(timedelta(hours=8))
BATCH_SIZE = 60
CONTEXT_BEFORE = 80


def bj_text(ts: int) -> str:
    return datetime.fromtimestamp(ts, BEIJING).strftime("%m-%d %H:%M")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=float, default=12.0)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--context-before", type=int, default=CONTEXT_BEFORE)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "outputs" / "xagusd_replay_5m",
    )
    args = parser.parse_args()
    if args.hours <= 0 or args.hours > 30 * 24:
        raise SystemExit("--hours must be within (0, 720]")
    if args.batch_size <= 0 or args.context_before < 0:
        raise SystemExit("invalid batch/context size")
    out_dir = args.output_dir
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT open_time, open, high, low, close, volume
        FROM candles
        WHERE vendor='OANDA' AND symbol='XAGUSD' AND timeframe='5' AND is_final=1
        ORDER BY open_time
        """
    ).fetchall()
    con.close()
    if not rows:
        raise SystemExit("no XAGUSD 5m candles in DB")

    ema20 = ema50 = None
    tr_ema = None
    enriched = []
    for r in rows:
        o, h, l, c = r["open"], r["high"], r["low"], r["close"]
        if ema20 is None:
            ema20, ema50 = c, c
        else:
            ema20 = c * (2 / 21) + ema20 * (1 - 2 / 21)
            ema50 = c * (2 / 51) + ema50 * (1 - 2 / 51)
        tr = max(h - l, abs(h - c), abs(l - c))
        tr_ema = tr if tr_ema is None else (tr_ema * 13 + tr) / 14
        enriched.append(
            {
                "t": int(r["open_time"]),
                "o": o, "h": h, "l": l, "c": c,
                "ema20": ema20, "ema50": ema50, "atr": tr_ema,
                "v": int(r["volume"] or 0),
            }
        )

    # Confirmed pivots: 3-bar fractals confirmed by the following bar.
    pivots: list[dict] = []
    for i in range(1, len(enriched) - 1):
        prev, cur, nxt = enriched[i - 1], enriched[i], enriched[i + 1]
        if cur["h"] > prev["h"] and cur["h"] > nxt["h"]:
            pivots.append({"t": cur["t"], "p": cur["h"], "k": "H"})
        if cur["l"] < prev["l"] and cur["l"] < nxt["l"]:
            pivots.append({"t": cur["t"], "p": cur["l"], "k": "L"})
    expected_slots = max(1, int(round(args.hours * 12)))
    last_close_time = enriched[-1]["t"] + 300
    window_start_time = last_close_time - int(round(args.hours * 3600))
    window_indices = [
        i
        for i, bar in enumerate(enriched)
        if bar["t"] >= window_start_time and bar["t"] + 300 <= last_close_time
    ]
    if not window_indices:
        raise SystemExit("no final XAGUSD 5m bars in the requested time window")
    batches = [
        window_indices[i:i + args.batch_size]
        for i in range(0, len(window_indices), args.batch_size)
    ]
    manifest_batches = []
    for batch_no, indices in enumerate(batches):
        start_i = indices[0]
        context = enriched[max(0, start_i - args.context_before):start_i]
        lines = [
            f"# XAGUSD 5m replay batch {batch_no}  bars {indices[0]}..{indices[-1]}",
            f"# window: {bj_text(enriched[indices[0]]['t'])} -> {bj_text(enriched[indices[-1]]['t'])}",
            f"# context bars before batch: {len(context)} (EMA/ATR/pivots all computed before batch start)",
        ]
        pivots_before = [
            p for p in pivots
            if p["t"] < enriched[start_i]["t"]
        ][-40:]
        if pivots_before:
            lines.append("# confirmed pivots before batch: T P K")
            lines += [
                f"{bj_text(p['t'])} {p['p']:.3f} {p['k']}" for p in pivots_before
            ]
        lines.append("CONTEXT:")
        lines.append("idx time O H L C EMA20 EMA50 ATR V")
        lines += [
            f"{i} {bj_text(b['t'])} {b['o']:.3f} {b['h']:.3f} {b['l']:.3f} {b['c']:.3f} "
            f"{b['ema20']:.3f} {b['ema50']:.3f} {b['atr']:.3f} {b['v']}"
            for i, b in enumerate(context)
        ]
        lines.append("BATCH:")
        lines.append("idx time O H L C EMA20 EMA50 ATR V")
        for i in indices:
            b = enriched[i]
            lines.append(
                f"{i} {bj_text(b['t'])} {b['o']:.3f} {b['h']:.3f} {b['l']:.3f} {b['c']:.3f} "
                f"{b['ema20']:.3f} {b['ema50']:.3f} {b['atr']:.3f} {b['v']}"
            )
        path = out_dir / f"batch_{batch_no:03d}.txt"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        skeleton = [{"t": enriched[i]["t"], "v": "N"} for i in indices]
        (out_dir / f"batch_{batch_no:03d}_decisions.json").write_text(
            json.dumps(skeleton, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        manifest_batches.append(
            {
                "batch": batch_no,
                "first_idx": indices[0],
                "last_idx": indices[-1],
                "first_time": enriched[indices[0]]["t"],
                "last_time": enriched[indices[-1]]["t"],
                "bars": len(indices),
                "file": path.name,
            }
        )
    manifest = {
        "version": 2,
        "vendor": "OANDA",
        "symbol": "XAGUSD",
        "qualified_symbol": "OANDA:XAGUSD",
        "timeframe": "5",
        "timezone": "Asia/Shanghai",
        "requested_hours": args.hours,
        "window_start_time": window_start_time,
        "expected_5m_slots": expected_slots,
        "actual_bars": len(window_indices),
        "first_open_time": enriched[window_indices[0]]["t"],
        "last_open_time": enriched[window_indices[-1]]["t"],
        "last_close_time": last_close_time,
        "batches": manifest_batches,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "total_window_bars": len(window_indices),
                "batches": len(batches),
                "first_open_time": manifest["first_open_time"],
                "last_open_time": manifest["last_open_time"],
                "last_close_time": manifest["last_close_time"],
                "out": str(out_dir),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
