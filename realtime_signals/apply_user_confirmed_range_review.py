"""Apply a scoped, user-confirmed range review to one replay market.

The targeted review replaces matching bars. Any older signal for the same
market that is outside the confirmed review scope is explicitly invalidated
instead of silently surviving with rejected range evidence.
"""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any


def identity(record: dict[str, Any]) -> tuple[str, str, str, int]:
    return (
        str(record["vendor"]),
        str(record["symbol"]),
        str(record["timeframe"]),
        int(record["bar_time"]),
    )


def is_signal(record: dict[str, Any]) -> bool:
    return record.get("final_decision", {}).get("verdict") == "SIGNAL"


def invalidated_record(record: dict[str, Any]) -> dict[str, Any]:
    output = dict(record)
    output["review_mode"] = "invalidated_by_user_confirmed_range"
    output["final_decision"] = {
        "verdict": "NO_SIGNAL",
        "direction": "none",
        "setup_type": "none",
        "grade": "none",
        "reasons": [
            "该旧信号依赖的震荡区间已被用户否决，且不在新的用户确认区间因果复核范围内，因此不保留。"
        ],
        "location_summary": "旧区间失效",
        "structure_summary": "等待基于新确认区间重新成立",
        "confirmation_price": 0,
        "invalidation_price": 0,
        "context": {
            "market_state": "旧判断已撤销",
            "levels_reason": "旧震荡框被用户否决",
            "range_or_channel_anchors": [],
            "previous_signal_id": 0,
            "previous_signal_status": "invalidated",
            "state_transition": "none",
            "transition_evidence": "none",
        },
    }
    return output


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
    parser.add_argument("--targeted-review", type=Path, required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--comparison", type=Path, required=True)
    args = parser.parse_args()

    original = json.loads(args.original.read_text(encoding="utf-8"))
    targeted = json.loads(args.targeted_review.read_text(encoding="utf-8"))
    target_key = (args.vendor, args.symbol)
    replacements = {
        identity(record): record
        for market in targeted.get("markets", [])
        if (str(market["vendor"]), str(market["symbol"])) == target_key
        for record in market.get("results", [])
    }

    old_market = next(
        market
        for market in original["markets"]
        if (str(market["vendor"]), str(market["symbol"])) == target_key
    )
    old_signal_rows = [
        record for record in old_market.get("results", []) if is_signal(record)
    ]
    merged_markets = []
    for market in original["markets"]:
        if (str(market["vendor"]), str(market["symbol"])) != target_key:
            merged_markets.append(summarize_market(market))
            continue
        results = []
        for record in market.get("results", []):
            replacement = replacements.get(identity(record))
            if replacement is not None:
                results.append(replacement)
            elif is_signal(record):
                results.append(invalidated_record(record))
            else:
                results.append(record)
        merged_markets.append(
            summarize_market(
                {
                    "vendor": market["vendor"],
                    "symbol": market["symbol"],
                    "results": results,
                }
            )
        )

    output = {
        **{key: value for key, value in original.items() if key != "markets"},
        "version": 4,
        "mode": "strict_causal_user_confirmed_range_replay",
        "rules_version": "louie-codex-v3-user-confirmed-range",
        "markets": merged_markets,
        "total_candidates": sum(market["candidates"] for market in merged_markets),
        "total_ai_calls": sum(market["ai_calls"] for market in merged_markets),
        "total_pre_ai_hard_rejects": sum(
            market["equivalent_pre_ai_hard_rejects"]
            for market in merged_markets
        ),
        "total_failures": sum(market["failures"] for market in merged_markets),
        "total_signals": sum(market["signals"] for market in merged_markets),
    }
    new_market = next(
        market
        for market in merged_markets
        if (market["vendor"], market["symbol"]) == target_key
    )
    comparison = {
        "vendor": args.vendor,
        "symbol": args.symbol,
        "old_signals": len(old_signal_rows),
        "new_signals": new_market["signals"],
        "targeted_candidates": len(replacements),
        "invalidated_old_signals": sum(
            identity(record) not in replacements for record in old_signal_rows
        ),
        "new_signal_rows": [
            {
                "bar_time": record["bar_time"],
                "beijing": record["beijing"],
                "direction": record["final_decision"]["direction"],
                "setup_type": record["final_decision"]["setup_type"],
                "grade": record["final_decision"]["grade"],
            }
            for record in new_market["results"]
            if is_signal(record)
        ],
    }

    if args.output.resolve() == args.original.resolve():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = args.original.with_suffix(
            f".before-user-range-{stamp}.json"
        )
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
    print(json.dumps(comparison, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
