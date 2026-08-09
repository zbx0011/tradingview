#!/usr/bin/env python3
# louie规则回放（20260806版本）
"""Extract SIGNAL rows from the replay decisions JSONL into a draw-ready file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--src",
        type=Path,
        default=ROOT / "outputs" / "xagusd_replay_5m_decisions.jsonl",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "outputs" / "xagusd_replay_signals.json",
    )
    args = parser.parse_args()
    src = args.src if args.src.is_absolute() else ROOT / args.src
    output = args.output if args.output.is_absolute() else ROOT / args.output
    signals = []
    with src.open("r", encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            if d["v"] != "S":
                continue
            signals.append(
                {
                    "vendor": "OANDA",
                    "symbol": "XAGUSD",
                    "timeframe": "5",
                    "bar_time": int(d["t"]),
                    "direction": d["d"],
                    "setup_type": d.get("s", ""),
                    "reason": d.get("r", ""),
                    "signal_price": float(d["p"]),
                    "audit": d.get("a"),
                    "model": d.get("model"),
                    "reasoning_effort": d.get("reasoning_effort"),
                }
            )
    signals.sort(key=lambda s: s["bar_time"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(signals, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"signals": len(signals), "out": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
