"""Merge a full causal base review with scoped user-confirmed range reviews.

The base review remains authoritative for non-range setup families. Signals
whose setup depends on an automatically inferred range are withdrawn, then
records from the user-confirmed range review replace matching bars. This
prevents deleting valid narrow/wide-channel signals when a bad range drawing
is rejected by the user.
"""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any


RANGE_SETUPS = {
    "震荡内部：边缘反向",
    "震荡突破：位移突破",
}


def identity(record: dict[str, Any]) -> tuple[str, str, str, int]:
    return (
        str(record["vendor"]),
        str(record["symbol"]),
        str(record["timeframe"]),
        int(record["bar_time"]),
    )


def is_signal(record: dict[str, Any]) -> bool:
    return record.get("final_decision", {}).get("verdict") == "SIGNAL"


def setup_type(record: dict[str, Any]) -> str:
    return str(record.get("final_decision", {}).get("setup_type") or "")


def withdraw_automatic_range_signal(record: dict[str, Any]) -> dict[str, Any]:
    output = dict(record)
    output["review_mode"] = "withdrawn_rejected_automatic_range"
    output["final_decision"] = {
        "verdict": "NO_SIGNAL",
        "direction": "none",
        "setup_type": "none",
        "grade": "none",
        "reasons": [
            "该信号依赖自动推断的震荡区间；该区间未通过用户确认，"
            "因此在完整新版中撤销。"
        ],
        "location_summary": "未通过用户确认的自动震荡区间",
        "structure_summary": "等待有效人工确认区间或其他独立结构",
        "confirmation_price": 0,
        "invalidation_price": 0,
        "context": {
            "market_state": "自动震荡结构已撤销",
            "levels_reason": "用户确认区间优先于自动区间",
            "range_or_channel_anchors": [],
            "previous_signal_id": 0,
            "previous_signal_status": "withdrawn",
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
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--base-review", type=Path, required=True)
    parser.add_argument("--confirmed-review", type=Path, required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--comparison", type=Path, required=True)
    args = parser.parse_args()

    current = json.loads(args.current.read_text(encoding="utf-8"))
    base = json.loads(args.base_review.read_text(encoding="utf-8"))
    confirmed = json.loads(args.confirmed_review.read_text(encoding="utf-8"))
    target_key = (args.vendor, args.symbol)

    base_market = next(
        market
        for market in base["markets"]
        if (str(market["vendor"]), str(market["symbol"])) == target_key
    )
    confirmed_market = next(
        market
        for market in confirmed["markets"]
        if (str(market["vendor"]), str(market["symbol"])) == target_key
    )
    confirmed_by_identity = {
        identity(record): record for record in confirmed_market.get("results", [])
    }

    automatic_range_signals_withdrawn: list[dict[str, Any]] = []
    corrected_results: list[dict[str, Any]] = []
    for base_record in sorted(
        base_market.get("results", []), key=lambda item: int(item["bar_time"])
    ):
        replacement = confirmed_by_identity.get(identity(base_record))
        if replacement is not None:
            corrected_results.append(replacement)
            continue
        if is_signal(base_record) and setup_type(base_record) in RANGE_SETUPS:
            automatic_range_signals_withdrawn.append(base_record)
            corrected_results.append(withdraw_automatic_range_signal(base_record))
            continue
        corrected_results.append(base_record)

    corrected_market = summarize_market(
        {
            "vendor": args.vendor,
            "symbol": args.symbol,
            "results": corrected_results,
        }
    )
    merged_markets: list[dict[str, Any]] = []
    replaced = False
    for market in current["markets"]:
        if (str(market["vendor"]), str(market["symbol"])) == target_key:
            merged_markets.append(corrected_market)
            replaced = True
        else:
            merged_markets.append(summarize_market(market))
    if not replaced:
        merged_markets.append(corrected_market)

    output = {
        **{key: value for key, value in current.items() if key != "markets"},
        "version": 5,
        "mode": "strict_causal_full_base_plus_user_confirmed_ranges",
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
    signal_rows = [
        {
            "bar_time": record["bar_time"],
            "beijing": record["beijing"],
            "direction": record["final_decision"]["direction"],
            "setup_type": record["final_decision"]["setup_type"],
            "grade": record["final_decision"]["grade"],
        }
        for record in corrected_results
        if is_signal(record)
    ]
    comparison = {
        "vendor": args.vendor,
        "symbol": args.symbol,
        "base_candidates": len(base_market.get("results", [])),
        "confirmed_range_candidates": len(confirmed_by_identity),
        "withdrawn_automatic_range_signals": [
            {
                "bar_time": record["bar_time"],
                "beijing": record["beijing"],
                "direction": record["final_decision"]["direction"],
                "setup_type": record["final_decision"]["setup_type"],
                "grade": record["final_decision"]["grade"],
            }
            for record in automatic_range_signals_withdrawn
        ],
        "new_signals": len(signal_rows),
        "new_signal_rows": signal_rows,
    }

    if args.output.resolve() == args.current.resolve():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = args.current.with_suffix(f".before-full-xag-v5-{stamp}.json")
        shutil.copy2(args.current, backup)
        comparison["backup"] = str(backup)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    args.comparison.write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(comparison, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
