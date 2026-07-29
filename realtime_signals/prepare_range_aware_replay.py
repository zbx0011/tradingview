"""Build a targeted replay queue with strict-causal reconstructed ranges."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any

from candidate_filter_v2 import (
    add_early_range_reclaim_triggers,
    narrow_pullback_opportunity_validation,
    range_reversal_position_validation,
    reason_family,
)


BAR_SECONDS = 15 * 60


def all_ranges(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for market in payload.get("markets", [])
        for item in market.get("ranges", [])
    ]


def eligible_ranges(
    candidate: dict[str, Any], ranges: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    bar_time = int(candidate["bar_time"])
    return [
        item
        for item in ranges
        if str(item["vendor"]) == str(candidate["vendor"])
        and str(item["symbol"]) == str(candidate["symbol"])
        and int(item["first_detected_at"]) <= bar_time
        and int(item["start_time"]) <= bar_time <= int(item["end_time"]) + BAR_SECONDS
    ]


def choose_range(
    candidate: dict[str, Any], ranges: list[dict[str, Any]]
) -> dict[str, Any]:
    # Prefer the most recently completed/detected range, matching production
    # authoritative_chart_range_validation without using any future edit.
    return max(
        ranges,
        key=lambda item: (
            int(item["end_time"]),
            int(item["start_time"]),
            int(item["first_detected_at"]),
        ),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--ranges", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    queue = json.loads(args.queue.read_text(encoding="utf-8"))
    ranges_payload = json.loads(args.ranges.read_text(encoding="utf-8"))
    ranges = all_ranges(ranges_payload)
    selected: list[dict[str, Any]] = []
    market_counts: dict[str, int] = {}
    for original in queue["candidates"]:
        eligible = eligible_ranges(original, ranges)
        if not eligible:
            continue
        candidate = copy.deepcopy(original)
        chosen = choose_range(candidate, eligible)
        upper = float(chosen["upper"])
        lower = float(chosen["lower"])
        atr14 = max(float(candidate.get("atr14") or 0), 1e-9)
        candidate["chart_ranges"] = eligible
        candidate["range_validation"] = {
            "valid": True,
            "reason": "strict_causal_replay_range",
            "source": "strict_causal_replay",
            "locked": False,
            "entity_id": str(chosen["range_id"]),
            "start_time": int(chosen["start_time"]),
            "end_time": int(chosen["end_time"]),
            "upper": upper,
            "lower": lower,
            "width_atr": (upper - lower) / atr14,
            "chart_override": True,
            "first_detected_at": int(chosen["first_detected_at"]),
            "requirements": {
                "definition": "strict_causal_reconstructed_orange_rectangle",
                "future_bars_used": False,
            },
        }
        recent = candidate.get("recent_ohlc") or []
        if recent:
            rows = [
                {
                    "open_time": int(row[0]),
                    "open": float(row[1]),
                    "high": float(row[2]),
                    "low": float(row[3]),
                    "close": float(row[4]),
                    "volume": None if len(row) < 6 else row[5],
                }
                for row in recent
            ]
            current = rows[-1]
            candidate["range_reversal_validation"] = (
                range_reversal_position_validation(
                    current,
                    candidate["range_validation"],
                    atr14,
                )
            )
            # Drop any early-reclaim trigger derived from the queue's fallback
            # OHLC range. The strict-causal rectangle selected above is now
            # authoritative and must be the only source of that trigger.
            original_codes = {
                item.get("code") for item in (candidate.get("hypotheses") or [])
            }
            hypotheses = [
                item
                for item in (candidate.get("hypotheses") or [])
                if item.get("code")
                not in {
                    "lower_range_liquidity_reclaim_pin",
                    "upper_range_liquidity_reclaim_pin",
                }
            ]
            add_early_range_reclaim_triggers(
                hypotheses,
                candidate["range_reversal_validation"],
            )
            if not hypotheses:
                candidate["hypotheses"] = []
                candidate["reason_codes"] = []
                candidate["reason_families"] = []
                candidate["candidate_score"] = 0
                candidate["candidate_lifecycle"] = "new"
                candidate["direction_hint"] = "none"
                candidate["setup_hint"] = "none"
                candidate["reason"] = (
                    "authoritative_range_removed_stale_fallback_trigger"
                )
                candidate["needs_sol"] = False
            elif {item.get("code") for item in hypotheses} != original_codes:
                candidate["hypotheses"] = hypotheses
                candidate["reason_codes"] = [
                    str(item["code"]) for item in hypotheses
                ]
                candidate["reason_families"] = sorted(
                    {reason_family(str(item["code"])) for item in hypotheses}
                )
                candidate["candidate_score"] = max(
                    int(item["score"]) for item in hypotheses
                )
                candidate["candidate_lifecycle"] = "confirmed"
                directions = sorted(
                    {str(item["direction"]) for item in hypotheses}
                )
                candidate["direction_hint"] = (
                    directions[0] if len(directions) == 1 else "conflict"
                )
                dominant = max(
                    hypotheses,
                    key=lambda item: (
                        int(item["score"]),
                        item.get("lifecycle") == "confirmed",
                    ),
                )
                candidate["setup_hint"] = dominant["hypothesis"]
                candidate["reason"] = dominant["code"]
                candidate["needs_sol"] = True
            candidate["narrow_pullback_validation"] = (
                narrow_pullback_opportunity_validation(
                    rows,
                    atr14,
                    candidate.get("narrow_channel_validation") or {},
                    candidate["range_validation"],
                )
            )
        candidate["range_aware_recheck"] = True
        selected.append(candidate)
        market = f"{candidate['vendor']}:{candidate['symbol']}"
        market_counts[market] = market_counts.get(market, 0) + 1

    output = {
        "version": 2,
        "mode": "strict_causal_range_aware_targeted_replay",
        "window_beijing": queue["window_beijing"],
        "source_queue": str(args.queue),
        "ranges_source": str(args.ranges),
        "targeted_candidates": len(selected),
        "market_counts": market_counts,
        "candidates": selected,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({k: v for k, v in output.items() if k != "candidates"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
