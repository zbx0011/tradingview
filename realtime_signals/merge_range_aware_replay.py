"""Merge targeted range-aware decisions into the full strict replay audit."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def signal(decision: dict[str, Any] | None) -> bool:
    return bool(decision and decision.get("verdict") == "SIGNAL")


def signature(decision: dict[str, Any] | None) -> tuple[Any, ...]:
    if not signal(decision):
        return ("NO_SIGNAL",)
    return (
        "SIGNAL",
        decision.get("direction"),
        decision.get("setup_type"),
        decision.get("grade"),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--range-aware", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--comparison", type=Path, required=True)
    args = parser.parse_args()

    original = json.loads(args.original.read_text(encoding="utf-8"))
    aware = json.loads(args.range_aware.read_text(encoding="utf-8"))
    replacements = {
        (
            str(record["vendor"]),
            str(record["symbol"]),
            str(record["timeframe"]),
            int(record["bar_time"]),
        ): record
        for market in aware["markets"]
        for record in market["results"]
    }
    changes: list[dict[str, Any]] = []
    merged_markets: list[dict[str, Any]] = []
    for market in original["markets"]:
        results: list[dict[str, Any]] = []
        for old in market["results"]:
            identity = (
                str(old["vendor"]),
                str(old["symbol"]),
                str(old["timeframe"]),
                int(old["bar_time"]),
            )
            new = replacements.get(identity, old)
            if new is not old and signature(old.get("final_decision")) != signature(
                new.get("final_decision")
            ):
                before = old.get("final_decision") or {}
                after = new.get("final_decision") or {}
                changes.append(
                    {
                        "key": old["key"],
                        "vendor": old["vendor"],
                        "symbol": old["symbol"],
                        "timeframe": old["timeframe"],
                        "bar_time": old["bar_time"],
                        "beijing": old["beijing"],
                        "before_verdict": before.get("verdict"),
                        "before_direction": before.get("direction"),
                        "before_setup": before.get("setup_type"),
                        "before_grade": before.get("grade"),
                        "after_verdict": after.get("verdict"),
                        "after_direction": after.get("direction"),
                        "after_setup": after.get("setup_type"),
                        "after_grade": after.get("grade"),
                        "change_type": (
                            "新增"
                            if not signal(before) and signal(after)
                            else "取消"
                            if signal(before) and not signal(after)
                            else "类型/方向/等级变化"
                        ),
                    }
                )
            results.append(new)
        merged_markets.append(
            {
                "vendor": market["vendor"],
                "symbol": market["symbol"],
                "candidates": len(results),
                "ai_calls": sum(item.get("review_mode") == "ai" for item in results),
                "equivalent_pre_ai_hard_rejects": sum(
                    item.get("review_mode") == "equivalent_pre_ai_hard_reject"
                    for item in results
                ),
                "failures": sum(item.get("review_mode") == "failed" for item in results),
                "signals": sum(
                    signal(item.get("final_decision")) for item in results
                ),
                "results": results,
            }
        )
    merged = {
        **{key: value for key, value in original.items() if key != "markets"},
        "version": 2,
        "mode": "strict_causal_program_plus_ai_range_aware_merged",
        "chart_drawings_used": True,
        "strict_causal_replay_ranges_used": True,
        "markets": merged_markets,
        "total_candidates": sum(item["candidates"] for item in merged_markets),
        "total_ai_calls": sum(item["ai_calls"] for item in merged_markets),
        "total_pre_ai_hard_rejects": sum(
            item["equivalent_pre_ai_hard_rejects"] for item in merged_markets
        ),
        "total_failures": sum(item["failures"] for item in merged_markets),
        "total_signals": sum(item["signals"] for item in merged_markets),
    }
    comparison = {
        "original_signals": original["total_signals"],
        "range_aware_signals": merged["total_signals"],
        "targeted_candidates": len(replacements),
        "changed_candidates": len(changes),
        "added": sum(item["change_type"] == "新增" for item in changes),
        "cancelled": sum(item["change_type"] == "取消" for item in changes),
        "modified": sum(
            item["change_type"] == "类型/方向/等级变化" for item in changes
        ),
        "changes": changes,
    }
    args.output.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    args.comparison.write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({k: v for k, v in comparison.items() if k != "changes"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
