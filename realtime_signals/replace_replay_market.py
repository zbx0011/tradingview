"""Replace one market in a multi-market replay audit and compare signals."""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any


def is_signal(record: dict[str, Any]) -> bool:
    return record.get("final_decision", {}).get("verdict") == "SIGNAL"


def signature(record: dict[str, Any]) -> tuple[Any, ...]:
    decision = record.get("final_decision") or {}
    if decision.get("verdict") != "SIGNAL":
        return ("NO_SIGNAL",)
    return (
        "SIGNAL",
        decision.get("direction"),
        decision.get("setup_type"),
        decision.get("grade"),
    )


def market_key(market: dict[str, Any]) -> tuple[str, str]:
    return str(market["vendor"]), str(market["symbol"])


def summarize_market(market: dict[str, Any]) -> dict[str, Any]:
    results = list(market.get("results") or [])
    return {
        "vendor": market["vendor"],
        "symbol": market["symbol"],
        "candidates": len(results),
        "ai_calls": sum(item.get("review_mode") == "ai" for item in results),
        "equivalent_pre_ai_hard_rejects": sum(
            item.get("review_mode") == "equivalent_pre_ai_hard_reject"
            for item in results
        ),
        "failures": sum(item.get("review_mode") == "failed" for item in results),
        "signals": sum(is_signal(item) for item in results),
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--replacement", type=Path, required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--comparison", type=Path, required=True)
    args = parser.parse_args()

    original = json.loads(args.original.read_text(encoding="utf-8"))
    replacement = json.loads(args.replacement.read_text(encoding="utf-8"))
    target = (args.vendor, args.symbol)
    new_market = next(
        market
        for market in replacement["markets"]
        if market_key(market) == target
    )
    old_market = next(
        market for market in original["markets"] if market_key(market) == target
    )
    markets = [
        summarize_market(new_market)
        if market_key(market) == target
        else summarize_market(market)
        for market in original["markets"]
    ]

    old_by_time = {
        int(item["bar_time"]): item
        for item in old_market.get("results") or []
        if is_signal(item)
    }
    new_by_time = {
        int(item["bar_time"]): item
        for item in new_market.get("results") or []
        if is_signal(item)
    }
    changes: list[dict[str, Any]] = []
    for bar_time in sorted(set(old_by_time) | set(new_by_time)):
        old = old_by_time.get(bar_time)
        new = new_by_time.get(bar_time)
        if old and new and signature(old) == signature(new):
            continue
        before = (old or {}).get("final_decision") or {}
        after = (new or {}).get("final_decision") or {}
        changes.append(
            {
                "bar_time": bar_time,
                "beijing": (new or old or {}).get("beijing"),
                "change_type": (
                    "新增"
                    if new and not old
                    else "取消"
                    if old and not new
                    else "方向/类型/等级变化"
                ),
                "before": {
                    "direction": before.get("direction"),
                    "setup_type": before.get("setup_type"),
                    "grade": before.get("grade"),
                },
                "after": {
                    "direction": after.get("direction"),
                    "setup_type": after.get("setup_type"),
                    "grade": after.get("grade"),
                },
            }
        )

    output = {
        **{key: value for key, value in original.items() if key != "markets"},
        "version": 3,
        "mode": "strict_causal_program_plus_ai_rules_v3",
        "rules_version": "louie-codex-v3-range-third-early-pullback",
        "markets": markets,
        "total_candidates": sum(item["candidates"] for item in markets),
        "total_ai_calls": sum(item["ai_calls"] for item in markets),
        "total_pre_ai_hard_rejects": sum(
            item["equivalent_pre_ai_hard_rejects"] for item in markets
        ),
        "total_failures": sum(item["failures"] for item in markets),
        "total_signals": sum(item["signals"] for item in markets),
    }
    market_windows = dict(original.get("market_windows") or {})
    original_window = original.get("window_beijing")
    if original_window:
        for market in original["markets"]:
            key = f"{market['vendor']}:{market['symbol']}"
            market_windows.setdefault(key, original_window)
    replacement_window = replacement.get("window_beijing")
    if replacement_window:
        market_windows[f"{args.vendor}:{args.symbol}"] = replacement_window
    output["market_windows"] = market_windows
    comparison = {
        "vendor": args.vendor,
        "symbol": args.symbol,
        "old_signals": sum(is_signal(item) for item in old_market["results"]),
        "new_signals": sum(is_signal(item) for item in new_market["results"]),
        "added": sum(item["change_type"] == "新增" for item in changes),
        "cancelled": sum(item["change_type"] == "取消" for item in changes),
        "modified": sum(
            item["change_type"] == "方向/类型/等级变化" for item in changes
        ),
        "changes": changes,
    }

    if args.output.resolve() == args.original.resolve():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = args.original.with_suffix(f".before-rules-v3-{stamp}.json")
        shutil.copy2(args.original, backup)
        comparison["backup"] = str(backup)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    args.comparison.write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {key: value for key, value in comparison.items() if key != "changes"},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
