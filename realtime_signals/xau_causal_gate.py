#!/usr/bin/env python3
"""One-way causal gate for the frozen 2026-08-04 XAUUSD 5m replay.

The next candle is released only after the current candle's decision has been
validated and appended to a hash-chained ledger.  This makes it impossible for
the judging turn to receive candle n+1 before committing candle n.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = Path(os.environ.get("XAU_DATA_FILE", str(Path.home() / "AppData" / "Local" / "Temp" / "xauusd_luna_compare_634bars.json")))
DEFAULT_OUT = ROOT / "outputs" / "xauusd_replay_5m_20260806_causal_sol_xhigh"
EXPECTED_SHA256 = os.environ.get("XAU_EXPECTED_SHA", "030b3bad06d0392d4e02398c6e0fa7354bff38c685d291820877237a315ba0c0")
BEIJING = timezone(timedelta(hours=8))
START_IDX = int(os.environ.get("CAUSAL_START_IDX", "0"))
MODEL_NAME = os.environ.get("CAUSAL_MODEL", "gpt-5.6-sol")
MODEL_EFFORT = os.environ.get("CAUSAL_EFFORT", "xhigh")


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_data(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"frozen data SHA256 mismatch: {digest}")
    payload = json.loads(raw)
    bars = payload.get("bars")
    if payload.get("symbol") != "OANDA:XAUUSD" or payload.get("timeframe_minutes") != 5:
        raise SystemExit("unexpected frozen symbol/timeframe")
    if not isinstance(bars, list) or len(bars) < 634:
        raise SystemExit(f"expected at least 634 frozen bars, got {len(bars) if isinstance(bars, list) else '?'}")
    return payload, bars


def enrich(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    ema20: float | None = None
    ema50: float | None = None
    atr14: float | None = None
    prev_close: float | None = None
    for idx, bar in enumerate(bars):
        close = float(bar["close"])
        high = float(bar["high"])
        low = float(bar["low"])
        ema20 = close if ema20 is None else close * (2 / 21) + ema20 * (19 / 21)
        ema50 = close if ema50 is None else close * (2 / 51) + ema50 * (49 / 51)
        true_range = high - low if prev_close is None else max(
            high - low, abs(high - prev_close), abs(low - prev_close)
        )
        atr14 = true_range if atr14 is None else (atr14 * 13 + true_range) / 14
        result.append(
            {
                **bar,
                "idx": idx,
                "ema20": ema20,
                "ema50": ema50,
                "atr14": atr14,
                "close_time": int(bar["time"]) + 300,
            }
        )
        prev_close = close
    return result


def confirmed_pivots(bars: list[dict[str, Any]], cutoff_idx: int) -> list[dict[str, Any]]:
    pivots: list[dict[str, Any]] = []
    # A three-bar pivot at i is only known after i+1 has closed, so i+1 <= cutoff.
    for i in range(1, cutoff_idx):
        prev_bar, bar, next_bar = bars[i - 1], bars[i], bars[i + 1]
        if float(bar["high"]) > float(prev_bar["high"]) and float(bar["high"]) > float(next_bar["high"]):
            pivots.append({"idx": i, "kind": "H", "price": float(bar["high"])})
        if float(bar["low"]) < float(prev_bar["low"]) and float(bar["low"]) < float(next_bar["low"]):
            pivots.append({"idx": i, "kind": "L", "price": float(bar["low"])})
    return pivots[-8:]


def structure_hints(bars: list[dict[str, Any]], idx: int) -> dict[str, Any]:
    """Advisory hints computed only from bars <= idx.

    These are technical context flags for deciding when a chart snapshot is
    useful. They are NOT trading rules and never affect the hash-chained
    decision record.
    """
    if idx <= 0:
        return {"suggest_snapshot": False, "flags": []}
    cur = bars[idx]
    window = bars[max(0, idx - 24):idx]
    prev_high = max(float(b["high"]) for b in window)
    prev_low = min(float(b["low"]) for b in window)
    bodies = sorted(abs(float(b["close"]) - float(b["open"])) for b in bars[max(0, idx - 20):idx])
    median_body = bodies[len(bodies) // 2] if bodies else 0.0
    body = abs(float(cur["close"]) - float(cur["open"]))
    atr = float(cur["atr14"])
    flags: list[str] = []

    if int(cur["time"]) - int(bars[idx - 1]["time"]) > 300:
        flags.append("gap")
    if float(cur["high"]) > prev_high and float(cur["close"]) < prev_high:
        flags.append("sweep_high_back")
    if float(cur["low"]) < prev_low and float(cur["close"]) > prev_low:
        flags.append("sweep_low_back")
    if float(cur["close"]) > prev_high:
        flags.append("close_break_high")
    if float(cur["close"]) < prev_low:
        flags.append("close_break_low")
    if median_body > 0 and body > 1.8 * median_body:
        flags.append("large_body")
    if idx >= 1:
        prev_spread = float(bars[idx - 1]["ema20"]) - float(bars[idx - 1]["ema50"])
        cur_spread = float(cur["ema20"]) - float(cur["ema50"])
        if prev_spread <= 0 < cur_spread:
            flags.append("ema20_cross_above")
        elif prev_spread >= 0 > cur_spread:
            flags.append("ema20_cross_below")
    if atr > 0 and abs(float(cur["close"]) - float(cur["ema20"])) > 1.2 * atr:
        flags.append("ema_deviation")
    return {"suggest_snapshot": bool(flags), "flags": flags}


def state_path(out_dir: Path) -> Path:
    return out_dir / "gate_state.json"


def ledger_path(out_dir: Path) -> Path:
    return out_dir / "decisions.jsonl"


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def current_payload(bars: list[dict[str, Any]], idx: int, chain: str) -> dict[str, Any]:
    if idx >= len(bars):
        return {"done": True, "committed": len(bars), "chain_sha256": chain}
    bar = bars[idx]
    previous_time = int(bars[idx - 1]["time"]) if idx else None
    gap_minutes = None if previous_time is None else (int(bar["time"]) - previous_time) // 60
    return {
        "done": False,
        "idx": idx,
        "remaining_including_current": len(bars) - idx,
        "bar": {
            "open_time": int(bar["time"]),
            "beijing_open_time": bar["beijing_open_time"],
            "beijing_close_time": datetime.fromtimestamp(int(bar["close_time"]), BEIJING).strftime("%Y-%m-%d %H:%M"),
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
            "volume": int(bar.get("volume") or 0),
            "ema20": round(float(bar["ema20"]), 6),
            "ema50": round(float(bar["ema50"]), 6),
            "atr14": round(float(bar["atr14"]), 6),
            "gap_from_previous_minutes": gap_minutes,
        },
        "confirmed_pivots": confirmed_pivots(bars, idx),
        "structure_hint": structure_hints(bars, idx),
        "chain_sha256_before_decision": chain,
        "causal_rule": "commit idx before gate releases idx+1; evidence/max_used_idx must be <= idx",
    }


def cmd_init(args: argparse.Namespace) -> int:
    payload, raw_bars = load_data(args.data)
    bars = enrich(raw_bars)
    if START_IDX < 0 or START_IDX >= len(bars):
        raise SystemExit(f"CAUSAL_START_IDX must be in [0, {len(bars) - 1}], got {START_IDX}")
    args.out.mkdir(parents=True, exist_ok=True)
    state = {"next_idx": START_IDX, "chain_sha256": "0" * 64, "data_sha256": EXPECTED_SHA256}
    write_json(state_path(args.out), state)
    ledger_path(args.out).write_text("", encoding="utf-8")
    manifest = {
        "version": 1,
        "model": MODEL_NAME,
        "reasoning_effort": MODEL_EFFORT,
        "symbol": payload["symbol"],
        "timeframe_minutes": payload["timeframe_minutes"],
        "timezone": payload["timezone"],
        "bar_time_semantics": payload["bar_time_semantics"],
        "data_sha256": EXPECTED_SHA256,
        "count": len(bars),
        "first_open_time": bars[0]["time"],
        "last_open_time": bars[-1]["time"],
        "start_idx": START_IDX,
        "preloaded_history_bars": START_IDX,
        "anti_lookahead": "one-way gate; the next bar is returned only after current decision is hash-chained",
    }
    write_json(args.out / "manifest.json", manifest)
    print(json.dumps(current_payload(bars, 0, state["chain_sha256"]), ensure_ascii=False))
    return 0


def parse_evidence(text: str) -> list[int]:
    if not text.strip():
        return []
    values = [int(part) for part in text.split(",")]
    if len(values) != len(set(values)):
        raise SystemExit("duplicate evidence index")
    return values


def cmd_step(args: argparse.Namespace) -> int:
    _, raw_bars = load_data(args.data)
    bars = enrich(raw_bars)
    state = json.loads(state_path(args.out).read_text(encoding="utf-8"))
    idx = int(state["next_idx"])
    if idx >= len(bars):
        print(json.dumps(current_payload(bars, idx, state["chain_sha256"]), ensure_ascii=False))
        return 0
    if args.idx != idx:
        raise SystemExit(f"gate expected idx={idx}, received idx={args.idx}")
    if args.max_used_idx != idx:
        raise SystemExit("max_used_idx must equal the currently released idx")
    evidence = parse_evidence(args.evidence)
    if any(value < 0 or value > idx for value in evidence):
        raise SystemExit("future/invalid evidence index")
    if args.decision == "SIGNAL" and args.direction == "none":
        raise SystemExit("SIGNAL requires long or short direction")
    if args.decision != "SIGNAL" and args.direction != "none":
        raise SystemExit("only SIGNAL may have a direction")
    if not args.reason.strip() or not args.setup.strip():
        raise SystemExit("setup/reason must not be blank")
    bar = bars[idx]
    record = {
        "idx": idx,
        "bar_open_time": int(bar["time"]),
        "beijing_open_time": bar["beijing_open_time"],
        "decision_after_close_time": int(bar["close_time"]),
        "decision": args.decision,
        "direction": args.direction,
        "setup": args.setup.strip(),
        "reason": args.reason.strip(),
        "evidence_indices": evidence,
        "max_used_idx": args.max_used_idx,
        "no_future_data": True,
        "previous_chain_sha256": state["chain_sha256"],
    }
    record["record_sha256"] = hashlib.sha256(canonical(record)).hexdigest()
    new_chain = hashlib.sha256((state["chain_sha256"] + record["record_sha256"]).encode("ascii")).hexdigest()
    record["chain_sha256"] = new_chain
    with ledger_path(args.out).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    state["next_idx"] = idx + 1
    state["chain_sha256"] = new_chain
    write_json(state_path(args.out), state)
    print(json.dumps(current_payload(bars, idx + 1, new_chain), ensure_ascii=False))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    _, raw_bars = load_data(args.data)
    bars = enrich(raw_bars)
    state = json.loads(state_path(args.out).read_text(encoding="utf-8"))
    print(json.dumps(current_payload(bars, int(state["next_idx"]), state["chain_sha256"]), ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init").set_defaults(func=cmd_init)
    subparsers.add_parser("status").set_defaults(func=cmd_status)
    step = subparsers.add_parser("step")
    step.add_argument("--idx", type=int, required=True)
    step.add_argument("--decision", choices=("NO_SIGNAL", "OBSERVE", "SIGNAL"), required=True)
    step.add_argument("--direction", choices=("none", "long", "short"), required=True)
    step.add_argument("--setup", required=True)
    step.add_argument("--reason", required=True)
    step.add_argument("--evidence", default="")
    step.add_argument("--max-used-idx", type=int, required=True)
    step.set_defaults(func=cmd_step)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.data.is_absolute():
        args.data = (ROOT / args.data).resolve()
    if not args.out.is_absolute():
        args.out = (ROOT / args.out).resolve()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
