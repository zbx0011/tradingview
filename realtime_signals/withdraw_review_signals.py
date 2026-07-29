"""Withdraw explicitly rejected replay signals from a merged review file."""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any


def is_signal(record: dict[str, Any]) -> bool:
    return record.get("final_decision", {}).get("verdict") == "SIGNAL"


def withdrawn(record: dict[str, Any], reason: str) -> dict[str, Any]:
    output = dict(record)
    output["review_mode"] = "withdrawn_after_rule_regression"
    output["final_decision"] = {
        "verdict": "NO_SIGNAL",
        "direction": "none",
        "setup_type": "none",
        "grade": "none",
        "reasons": [reason],
        "location_summary": "窄通道与回踩硬门槛未通过",
        "structure_summary": "普通推进或双向摆动，不能归类为窄通道回踩",
        "confirmation_price": 0,
        "invalidation_price": 0,
        "context": {
            "market_state": "原窄通道判断已撤销",
            "levels_reason": reason,
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
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--comparison", type=Path, required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--bar-time", type=int, action="append", required=True)
    parser.add_argument("--reason", required=True)
    args = parser.parse_args()

    data = json.loads(args.input.read_text(encoding="utf-8"))
    targets = set(args.bar_time)
    withdrawn_rows: list[dict[str, Any]] = []
    markets: list[dict[str, Any]] = []
    for market in data["markets"]:
        if (
            str(market["vendor"]) != args.vendor
            or str(market["symbol"]) != args.symbol
        ):
            markets.append(summarize_market(market))
            continue
        results = []
        for record in market.get("results", []):
            if int(record["bar_time"]) in targets and is_signal(record):
                withdrawn_rows.append(
                    {
                        "bar_time": record["bar_time"],
                        "beijing": record["beijing"],
                        "direction": record["final_decision"]["direction"],
                        "grade": record["final_decision"]["grade"],
                        "setup_type": record["final_decision"]["setup_type"],
                    }
                )
                results.append(withdrawn(record, args.reason))
            else:
                results.append(record)
        markets.append(
            summarize_market(
                {
                    "vendor": market["vendor"],
                    "symbol": market["symbol"],
                    "results": results,
                }
            )
        )

    output = {
        **{key: value for key, value in data.items() if key != "markets"},
        "version": max(int(data.get("version", 1)), 6),
        "rules_version": "louie-codex-v4-strict-narrow-channel",
        "markets": markets,
        "total_candidates": sum(market["candidates"] for market in markets),
        "total_ai_calls": sum(market["ai_calls"] for market in markets),
        "total_pre_ai_hard_rejects": sum(
            market["equivalent_pre_ai_hard_rejects"] for market in markets
        ),
        "total_failures": sum(market["failures"] for market in markets),
        "total_signals": sum(market["signals"] for market in markets),
    }
    remaining = next(
        market
        for market in markets
        if market["vendor"] == args.vendor and market["symbol"] == args.symbol
    )
    comparison = {
        "vendor": args.vendor,
        "symbol": args.symbol,
        "withdrawn": withdrawn_rows,
        "remaining_signals": [
            {
                "bar_time": record["bar_time"],
                "beijing": record["beijing"],
                "direction": record["final_decision"]["direction"],
                "grade": record["final_decision"]["grade"],
                "setup_type": record["final_decision"]["setup_type"],
            }
            for record in remaining["results"]
            if is_signal(record)
        ],
    }
    if args.input.resolve() == args.output.resolve():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = args.input.with_suffix(
            f".before-narrow-regression-{stamp}.json"
        )
        shutil.copy2(args.input, backup)
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
