"""Reconstruct causal 15-minute horizontal range episodes for replay.

Each observation is computed with candles ending at the observation bar. The
range itself is proven from bars strictly before that observation bar. Similar
evolving bounds are consolidated into one editable chart range episode.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from candidate_filter_v2 import (
    WATCHLIST,
    atr,
    horizontal_range_boundaries,
    range_validation,
)
from kline_store import DEFAULT_DB


BEIJING = timezone(timedelta(hours=8))
TIMEFRAME = "15"
BAR_SECONDS = 15 * 60
WARMUP_BARS = 144
MIN_CAUSAL_OBSERVATIONS = 4
EXIT_LOOKBACK_BARS = 10


def parse_bj(value: str) -> int:
    return int(
        datetime.strptime(value.replace("T", " "), "%Y-%m-%d %H:%M")
        .replace(tzinfo=BEIJING)
        .timestamp()
    )


def bj_text(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, BEIJING).strftime("%Y-%m-%d %H:%M")


def overlap_ratio(a_low: float, a_high: float, b_low: float, b_high: float) -> float:
    overlap = max(0.0, min(a_high, b_high) - max(a_low, b_low))
    return overlap / max(min(a_high - a_low, b_high - b_low), 1e-9)


def compatible(cluster: dict[str, Any], obs: dict[str, Any]) -> bool:
    if obs["detected_at"] > cluster["last_detected_at"] + 8 * BAR_SECONDS:
        return False
    ratio = overlap_ratio(cluster["lower"], cluster["upper"], obs["lower"], obs["upper"])
    center_a = (cluster["upper"] + cluster["lower"]) / 2
    center_b = (obs["upper"] + obs["lower"]) / 2
    width = max(cluster["upper"] - cluster["lower"], obs["upper"] - obs["lower"])
    return ratio >= 0.55 or abs(center_a - center_b) <= 0.32 * width


def consolidate(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[dict[str, Any]] = []
    for obs in observations:
        matches = [item for item in clusters if compatible(item, obs)]
        if not matches:
            clusters.append(
                {
                    "observations": [obs],
                    "start_time": obs["start_time"],
                    "last_proof_end": obs["proof_end_time"],
                    "first_detected_at": obs["detected_at"],
                    "last_detected_at": obs["detected_at"],
                    "upper": obs["upper"],
                    "lower": obs["lower"],
                }
            )
            continue
        target = max(matches, key=lambda item: item["last_detected_at"])
        target["observations"].append(obs)
        # The earliest rolling proof may still contain part of the directional
        # ingress.  Use the stable median lifecycle start instead of allowing
        # one early window to pull the final rectangle back into that leg.
        ordered_starts = sorted(
            int(item["start_time"]) for item in target["observations"]
        )
        target["start_time"] = ordered_starts[len(ordered_starts) // 2]
        target["last_proof_end"] = max(target["last_proof_end"], obs["proof_end_time"])
        target["last_detected_at"] = max(target["last_detected_at"], obs["detected_at"])
        # Keep the stable median contact band as proof evolves. Expanding to
        # every rolling high/low would let one liquidity sweep permanently
        # enlarge the range.
        target["upper"] = sorted(
            float(item["upper"]) for item in target["observations"]
        )[len(target["observations"]) // 2]
        target["lower"] = sorted(
            float(item["lower"]) for item in target["observations"]
        )[len(target["observations"]) // 2]
    return clusters


def find_break(
    rows: list[sqlite3.Row],
    start_after: int,
    end: int,
    upper: float,
    lower: float,
    atr_value: float,
) -> dict[str, Any] | None:
    eligible = [
        row
        for row in rows
        if start_after < int(row["open_time"]) <= end
    ]

    def exit_leg_start(
        confirmed_index: int, direction: str
    ) -> tuple[int, dict[str, Any] | None]:
        """Locate the directional migration that led to a confirmed exit.

        The breakout is confirmed at the current bar, but the range lifecycle
        ends before the first persistent displacement candle in that same
        directional leg.  This keeps the egress leg out of both the rectangle
        and its boundary-contact counts.
        """
        confirmed = eligible[confirmed_index]
        confirmed_close = float(confirmed["close"])
        earliest = max(0, confirmed_index - EXIT_LOOKBACK_BARS + 1)
        candidates: list[tuple[int, dict[str, Any]]] = []
        sign = 1.0 if direction == "up" else -1.0
        for start_index in range(earliest, confirmed_index + 1):
            leg = eligible[start_index : confirmed_index + 1]
            if len(leg) < 2:
                continue
            first = leg[0]
            open_, high, low, close = map(
                float, (first["open"], first["high"], first["low"], first["close"])
            )
            first_body = abs(close - open_)
            first_location = (close - low) / max(high - low, 1e-9)
            starts_at_exit_edge = (
                direction == "up"
                and close >= upper - 0.20 * atr_value
            ) or (
                direction == "down"
                and close <= lower + 0.20 * atr_value
            )
            starts_with_displacement = (
                direction == "up"
                and first_body >= 1.00 * atr_value
                and first_location >= 0.65
            ) or (
                direction == "down"
                and first_body >= 1.00 * atr_value
                and first_location <= 0.35
            )
            if not starts_with_displacement or not starts_at_exit_edge:
                continue
            closes = [open_, *(float(row["close"]) for row in leg)]
            deltas = [
                closes[index] - closes[index - 1]
                for index in range(1, len(closes))
            ]
            path = sum(abs(value) for value in deltas)
            progress = sign * (confirmed_close - open_)
            efficiency = progress / max(path, 1e-9)
            directional_fraction = sum(sign * value > 0 for value in deltas) / max(
                len(deltas), 1
            )
            if (
                progress >= 1.20 * atr_value
                and efficiency >= 0.50
                and directional_fraction >= 0.60
            ):
                candidates.append(
                    (
                        start_index,
                        {
                            "direction": direction,
                            "progress_atr": progress / atr_value,
                            "efficiency": efficiency,
                            "directional_close_fraction": directional_fraction,
                            "bars": len(leg),
                        },
                    )
                )
        if not candidates:
            return int(confirmed["open_time"]), None
        start_index, profile = min(candidates, key=lambda item: item[0])
        return int(eligible[start_index]["open_time"]), profile

    def exit_holds(confirmed_index: int, direction: str) -> bool:
        """Reject a provisional break that promptly returns to the balance."""
        follow_through = eligible[
            confirmed_index + 1 : confirmed_index + 1 + 4
        ]
        if not follow_through:
            return True
        if direction == "up":
            return all(
                float(row["close"]) > upper + 0.02 * atr_value
                for row in follow_through
            )
        return all(
            float(row["close"]) < lower - 0.02 * atr_value
            for row in follow_through
        )

    outside_up = 0
    outside_down = 0
    outside_up_started: int | None = None
    outside_down_started: int | None = None
    for row_index, row in enumerate(eligible):
        bar_time = int(row["open_time"])
        open_, high, low, close = map(
            float, (row["open"], row["high"], row["low"], row["close"])
        )
        body = abs(close - open_)
        if close > upper + 0.12 * atr_value:
            outside_up += 1
            outside_up_started = (
                bar_time if outside_up_started is None else outside_up_started
            )
        else:
            outside_up = 0
            outside_up_started = None
        if close < lower - 0.12 * atr_value:
            outside_down += 1
            outside_down_started = (
                bar_time if outside_down_started is None else outside_down_started
            )
        else:
            outside_down = 0
            outside_down_started = None
        displaced_up = (
            close > upper + 0.20 * atr_value
            and body >= 0.60 * atr_value
            and close >= low + 0.65 * max(high - low, 1e-9)
        )
        displaced_down = (
            close < lower - 0.20 * atr_value
            and body >= 0.60 * atr_value
            and close <= low + 0.35 * max(high - low, 1e-9)
        )
        if outside_up >= 2 or outside_down >= 2 or displaced_up or displaced_down:
            direction = "up" if displaced_up or outside_up >= 2 else "down"
            if not exit_holds(row_index, direction):
                outside_up = 0
                outside_down = 0
                outside_up_started = None
                outside_down_started = None
                continue
            accepted_time = bar_time
            if not displaced_up and outside_up >= 2 and outside_up_started is not None:
                accepted_time = outside_up_started
            if (
                not displaced_down
                and outside_down >= 2
                and outside_down_started is not None
            ):
                accepted_time = outside_down_started
            leg_start_time, leg_profile = exit_leg_start(row_index, direction)
            return {
                "time": min(accepted_time, leg_start_time),
                "confirmed_at": bar_time,
                "direction": direction,
                "close": close,
                "displacement": bool(displaced_up or displaced_down),
                "exit_leg_start_time": leg_start_time,
                "exit_leg_profile": leg_profile,
            }
    return None


def contact_boundary_profile(
    rows: list[sqlite3.Row], start_time: int, end_time: int
) -> dict[str, Any]:
    """Return contact/body-defined boundaries for one causal lifecycle."""
    lifecycle = [
        row
        for row in rows
        if start_time <= int(row["open_time"]) <= end_time
    ]
    if not lifecycle:
        raise ValueError(
            f"no candles in range lifecycle {start_time}..{end_time}"
        )
    return horizontal_range_boundaries(lifecycle, atr(lifecycle))


def load_manual_ranges(path: Path | None) -> dict[tuple[str, str], dict[str, Any]]:
    """Load locked user rectangles so automatic rebuilds never overwrite them."""
    if path is None or not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    manual: dict[tuple[str, str], dict[str, Any]] = {}
    for market in payload.get("markets", []):
        symbol = str(market.get("symbol", ""))
        for item in market.get("ranges", []):
            if item.get("locked") or item.get("source") == "manual":
                manual[(symbol, str(item["range_id"]))] = dict(item)
    return manual


def matching_manual_range(
    manual_ranges: dict[tuple[str, str], dict[str, Any]],
    symbol: str,
    start_time: int,
    end_time: int,
) -> dict[str, Any] | None:
    """Match a locked edit by lifecycle overlap, not unstable ordinal IDs."""
    matches: list[tuple[float, dict[str, Any]]] = []
    for (manual_symbol, _), item in manual_ranges.items():
        if manual_symbol != symbol:
            continue
        manual_start = int(item["start_time"])
        manual_end = int(item["end_time"])
        overlap = max(0, min(end_time, manual_end) - max(start_time, manual_start))
        shorter = max(1, min(end_time - start_time, manual_end - manual_start))
        ratio = overlap / shorter
        if ratio >= 0.60:
            matches.append((ratio, item))
    return max(matches, key=lambda pair: pair[0])[1] if matches else None


def replay_symbol(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    start: int,
    end: int,
    manual_ranges: dict[tuple[str, str], dict[str, Any]],
) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT open_time,open,high,low,close,volume
        FROM candles
        WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
          AND open_time<=?
        ORDER BY open_time
        """,
        (vendor, symbol, TIMEFRAME, end),
    ).fetchall()
    start_index = next(
        (index for index, row in enumerate(rows) if int(row["open_time"]) >= start),
        len(rows),
    )
    observations: list[dict[str, Any]] = []
    for index in range(max(0, start_index - WARMUP_BARS), len(rows)):
        current_time = int(rows[index]["open_time"])
        if current_time < start or current_time > end:
            continue
        visible = rows[max(0, index - 119) : index + 1]
        if len(visible) < 40:
            continue
        atr_value = atr(visible)
        validation = range_validation(visible[:-1], atr_value)
        if not validation.get("valid"):
            continue
        observations.append(
            {
                "detected_at": current_time,
                "start_time": int(validation["start_time"]),
                "proof_end_time": int(validation["end_time"]),
                # Consolidate by the visible contact/body boundary. The same
                # definition is used by live validation and final replay.
                "upper": float(validation["upper"]),
                "lower": float(validation["lower"]),
                "atr14": float(atr_value),
                "rotation_count": int(validation.get("rotation_count", 0)),
                "inside_close_fraction": float(validation.get("inside_close_fraction", 0)),
            }
        )

    episodes: list[dict[str, Any]] = []
    used_manual_ids: set[str] = set()
    for ordinal, cluster in enumerate(consolidate(observations), 1):
        # Warm-up candles may prove a range that began before the requested
        # replay window. Do not create a partial historical rectangle for it.
        if cluster["start_time"] < start:
            continue
        obs = cluster["observations"]
        # A 15-minute top-level range must persist through at least one hour of
        # causal recognition. Two adjacent detections are merely a pause/flag,
        # not an independent horizontal market state.
        if len(obs) < MIN_CAUSAL_OBSERVATIONS:
            continue
        atr_value = sorted(item["atr14"] for item in obs)[len(obs) // 2]
        # Breakout decisions use the same contact/body boundaries shown on the
        # chart. Isolated sweeps are allowed; accepted closes outside are not.
        proof_profile = contact_boundary_profile(
            rows, cluster["start_time"], cluster["last_proof_end"]
        )
        proof_upper = float(proof_profile["upper"])
        proof_lower = float(proof_profile["lower"])
        broken = find_break(
            rows,
            cluster["last_proof_end"],
            end,
            proof_upper,
            proof_lower,
            atr_value,
        )
        end_time = (
            max(cluster["start_time"], int(broken["time"]) - BAR_SECONDS)
            if broken
            # An unbroken range is still active at the replay cutoff. Keep its
            # lifecycle open through the latest closed candle instead of
            # freezing the rectangle at the last bar that happened to add new
            # statistical proof. The drawing layer projects it a few bars
            # beyond that cutoff and refreshes it on each monitor cycle.
            else end
        )
        if end_time - cluster["start_time"] < 11 * BAR_SECONDS:
            continue
        final_profile = contact_boundary_profile(
            rows, cluster["start_time"], end_time
        )
        upper = float(final_profile["upper"])
        lower = float(final_profile["lower"])
        range_id = f"REPLAY-{symbol.replace('.', '_')}-{ordinal:02d}"
        manual = matching_manual_range(
            manual_ranges, symbol, cluster["start_time"], end_time
        )
        if manual:
            manual_id = str(manual["range_id"])
            if manual_id in used_manual_ids:
                continue
            used_manual_ids.add(manual_id)
            episodes.append(manual)
            continue
        episodes.append(
            {
                "range_id": range_id,
                "vendor": vendor,
                "symbol": symbol,
                "timeframe": TIMEFRAME,
                "start_time": cluster["start_time"],
                "end_time": end_time,
                "upper": upper,
                "lower": lower,
                "first_detected_at": cluster["first_detected_at"],
                "last_detected_at": cluster["last_detected_at"],
                "observation_count": len(obs),
                "median_atr14": atr_value,
                "breakout": broken,
                "source": "strict_causal_program_range_v5_trimmed_transition_legs",
                "boundary_method": "structural_contacts_after_ingress_egress_trim_v5",
                "upper_boundary_profile": final_profile["upper_profile"],
                "lower_boundary_profile": final_profile["lower_profile"],
                "raw_upper": final_profile["raw_upper"],
                "raw_lower": final_profile["raw_lower"],
                "user_editable": True,
                "start_beijing": bj_text(cluster["start_time"]),
                "end_beijing": bj_text(end_time),
                "detected_beijing": bj_text(cluster["first_detected_at"]),
            }
        )
    return {
        "vendor": vendor,
        "symbol": symbol,
        "observations": len(observations),
        "ranges": episodes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--start-bj", required=True)
    parser.add_argument("--end-bj", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--preserve-manual-from",
        type=Path,
        help="Existing replay_ranges.json whose locked/manual ranges must win.",
    )
    parser.add_argument(
        "--market",
        action="append",
        help="Optional exact VENDOR:SYMBOL filter; may be supplied repeatedly.",
    )
    args = parser.parse_args()
    start = parse_bj(args.start_bj)
    end = parse_bj(args.end_bj)
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    manual_ranges = load_manual_ranges(args.preserve_manual_from)
    requested = set(args.market or [])
    if requested:
        watchlist = [
            tuple(full_symbol.split(":", 1))
            for full_symbol in sorted(requested)
        ]
    else:
        watchlist = list(WATCHLIST)
    markets = [
        replay_symbol(conn, vendor, symbol, start, end, manual_ranges)
        for vendor, symbol in watchlist
    ]
    payload = {
        "version": 2,
        "mode": "strict_causal_range_reconstruction_v2",
        "boundary_rules_version": 5,
        "range_rules": {
            "minimum_causal_observations": MIN_CAUSAL_OBSERVATIONS,
            "proof_band": "15th_to_85th_percentile_core",
            "visible_boundary": (
                "structural_separated_wick_contacts_with_body_close_containment"
            ),
            "isolated_sweep_extreme_expands_boundary": False,
            "adjacent_wicks_count_as_one_test": True,
            "structural_pivot_candidates_only": True,
            "terminal_breakout_bar_excluded": True,
            "directional_ingress_excluded": True,
            "directional_egress_excluded_from_onset": True,
            "transition_leg_contacts_count": False,
            "failed_break_return_keeps_range_active": True,
            "manual_locked_ranges_have_priority": True,
        },
        "window_beijing": [bj_text(start), bj_text(end)],
        "markets": markets,
        "total_ranges": sum(len(item["ranges"]) for item in markets),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "success": True,
                "total_ranges": payload["total_ranges"],
                "markets": [
                    {
                        "symbol": item["symbol"],
                        "observations": item["observations"],
                        "ranges": len(item["ranges"]),
                    }
                    for item in markets
                ],
                "output": str(args.output.resolve()),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
