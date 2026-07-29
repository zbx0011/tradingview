"""High-recall deterministic candidate gate for the 15-minute monitor.

The gate never creates a formal signal. It deliberately emits a wider set of
well-described candidates for AI review while preserving the strict A/B
decision in the reviewer. It also remembers early observations for up to six
closed bars so follow-through and failed-continuation confirmations are not
lost between runs.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from kline_store import DEFAULT_DB, ema


WATCHLIST = (
    ("BYBIT", "BTCUSDT.P"),
    ("OANDA", "XAGUSD"),
    ("OANDA", "XAUUSD"),
    ("ICMARKETS", "US500"),
)
TIMEFRAME = "15"
BAR_SECONDS = 15 * 60
MEMORY_VERSION = 6
MEMORY_BARS = 6


def atr(rows: list[sqlite3.Row], length: int = 14) -> float:
    if len(rows) < 2:
        return 0.0
    values: list[float] = []
    previous = float(rows[0]["close"])
    for row in rows[1:]:
        high, low = float(row["high"]), float(row["low"])
        values.append(max(high - low, abs(high - previous), abs(low - previous)))
        previous = float(row["close"])
    sample = values[-length:]
    return sum(sample) / len(sample) if sample else 0.0


def close_location(row: sqlite3.Row) -> float:
    high, low = float(row["high"]), float(row["low"])
    if high <= low:
        return 0.5
    return (float(row["close"]) - low) / (high - low)


def independent_turning_points(rows: list[sqlite3.Row], side: str) -> list[dict[str, float | int]]:
    """Return non-adjacent three-bar pivots, so adjacent wicks count once."""
    points: list[dict[str, float | int]] = []
    field = "high" if side == "high" else "low"
    for index in range(1, len(rows) - 1):
        value = float(rows[index][field])
        left, right = float(rows[index - 1][field]), float(rows[index + 1][field])
        is_pivot = value >= left and value > right if side == "high" else value <= left and value < right
        if not is_pivot:
            continue
        bar_time = int(rows[index]["open_time"])
        if points and bar_time - int(points[-1]["time"]) <= BAR_SECONDS:
            better = value > float(points[-1]["price"]) if side == "high" else value < float(points[-1]["price"])
            if better:
                points[-1] = {"time": bar_time, "price": value}
            continue
        points.append({"time": bar_time, "price": value})
    return points


def _linear_slope(points: list[dict[str, float | int]]) -> tuple[float, float]:
    xs = [float(point["index"]) for point in points]
    ys = [float(point["price"]) for point in points]
    mean_x = sum(xs) / len(xs)
    mean_y = sum(ys) / len(ys)
    denominator = sum((value - mean_x) ** 2 for value in xs)
    if denominator <= 0:
        return 0.0, mean_y
    slope = sum(
        (x_value - mean_x) * (y_value - mean_y)
        for x_value, y_value in zip(xs, ys)
    ) / denominator
    return slope, mean_y - slope * mean_x


def _structural_pivots(
    rows: list[sqlite3.Row], strength: int = 2
) -> list[dict[str, float | int | str]]:
    """Build a latest, alternating swing sequence without cherry-picking wicks."""
    raw: list[dict[str, float | int | str]] = []
    for index in range(strength, len(rows) - strength):
        high = float(rows[index]["high"])
        low = float(rows[index]["low"])
        left_highs = [float(rows[item]["high"]) for item in range(index - strength, index)]
        right_highs = [float(rows[item]["high"]) for item in range(index + 1, index + strength + 1)]
        left_lows = [float(rows[item]["low"]) for item in range(index - strength, index)]
        right_lows = [float(rows[item]["low"]) for item in range(index + 1, index + strength + 1)]
        is_high = high >= max(left_highs) and high > max(right_highs)
        is_low = low <= min(left_lows) and low < min(right_lows)
        # An outside bar that is both extremes is not a clean channel anchor.
        if is_high == is_low:
            continue
        raw.append(
            {
                "side": "H" if is_high else "L",
                "index": index,
                "time": int(rows[index]["open_time"]),
                "price": high if is_high else low,
            }
        )

    alternating: list[dict[str, float | int | str]] = []
    for point in raw:
        if not alternating or point["side"] != alternating[-1]["side"]:
            alternating.append(point)
            continue
        current_price = float(point["price"])
        previous_price = float(alternating[-1]["price"])
        is_better = (
            current_price > previous_price
            if point["side"] == "H"
            else current_price < previous_price
        )
        if is_better:
            alternating[-1] = point
    return alternating


def wide_channel_validation(
    rows: list[sqlite3.Row], atr14: float
) -> dict[str, Any]:
    """Conservative proof gate for a visually meaningful wide channel.

    A falling/rising zigzag is not enough. The latest six structural pivots
    must alternate, both boundaries must be directionally parallel, and both
    countertrend rotations must develop over several bars with real close
    progression. This intentionally rejects one/two-bar wick bounces.
    """
    sample = rows[-72:]
    pivots = _structural_pivots(sample)
    result: dict[str, Any] = {
        "valid": False,
        "direction": None,
        "reason": "insufficient_latest_structural_swings",
        "requirements": {
            "alternating_pivots": 6,
            "same_side_min_gap_bars": 4,
            "countertrend_min_duration_bars": 3,
            "countertrend_min_directional_closes": 2,
            "countertrend_min_progress_atr": 0.60,
            "slope_ratio_range": [0.50, 2.00],
            "minimum_width_atr": 1.50,
            "maximum_width_ratio": 1.80,
        },
        "latest_pivots": pivots[-8:],
    }
    if len(pivots) < 6:
        return result

    sequence = pivots[-6:]
    highs = [point for point in sequence if point["side"] == "H"]
    lows = [point for point in sequence if point["side"] == "L"]
    if len(highs) != 3 or len(lows) != 3:
        result["reason"] = "latest_six_not_three_upper_three_lower"
        return result

    same_side_gaps = [
        int(points[index]["index"]) - int(points[index - 1]["index"])
        for points in (highs, lows)
        for index in range(1, len(points))
    ]
    if min(same_side_gaps) < 4:
        result["reason"] = "same_side_anchors_too_close"
        result["same_side_gaps_bars"] = same_side_gaps
        return result

    high_prices = [float(point["price"]) for point in highs]
    low_prices = [float(point["price"]) for point in lows]
    down = all(high_prices[index] < high_prices[index - 1] for index in (1, 2)) and all(
        low_prices[index] < low_prices[index - 1] for index in (1, 2)
    )
    up = all(high_prices[index] > high_prices[index - 1] for index in (1, 2)) and all(
        low_prices[index] > low_prices[index - 1] for index in (1, 2)
    )
    if not down and not up:
        result["reason"] = "boundaries_do_not_trend_together"
        return result
    direction = "down" if down else "up"

    high_slope, high_intercept = _linear_slope(highs)
    low_slope, low_intercept = _linear_slope(lows)
    if high_slope * low_slope <= 0:
        result["reason"] = "boundary_slopes_have_opposite_signs"
        return result
    slope_ratio = max(abs(high_slope), abs(low_slope)) / max(
        min(abs(high_slope), abs(low_slope)), 1e-9
    )
    if not 0.50 <= (abs(high_slope) / max(abs(low_slope), 1e-9)) <= 2.00:
        result["reason"] = "boundaries_not_parallel_enough"
        result["slope_ratio"] = slope_ratio
        return result

    x_values = [
        float(sequence[0]["index"]),
        (float(sequence[0]["index"]) + float(sequence[-1]["index"])) / 2.0,
        float(sequence[-1]["index"]),
    ]
    widths = [
        (high_slope * x_value + high_intercept)
        - (low_slope * x_value + low_intercept)
        for x_value in x_values
    ]
    if min(widths) < 1.50 * atr14:
        result["reason"] = "channel_too_narrow"
        result["widths_atr"] = [width / atr14 for width in widths]
        return result
    width_ratio = max(widths) / max(min(widths), 1e-9)
    if width_ratio > 1.80:
        result["reason"] = "channel_width_not_stable"
        result["width_ratio"] = width_ratio
        return result

    countertrend_legs: list[dict[str, Any]] = []
    expected_start = "L" if direction == "down" else "H"
    for start, end in zip(sequence, sequence[1:]):
        if start["side"] != expected_start:
            continue
        start_index, end_index = int(start["index"]), int(end["index"])
        duration = end_index - start_index
        leg_rows = sample[start_index : end_index + 1]
        closes = [float(row["close"]) for row in leg_rows]
        if direction == "down":
            directional_closes = sum(
                closes[index] > closes[index - 1] for index in range(1, len(closes))
            )
            progress = max(closes) - closes[0]
        else:
            directional_closes = sum(
                closes[index] < closes[index - 1] for index in range(1, len(closes))
            )
            progress = closes[0] - min(closes)
        countertrend_legs.append(
            {
                "from_time": int(start["time"]),
                "to_time": int(end["time"]),
                "duration_bars": duration,
                "directional_closes": directional_closes,
                "progress_atr": progress / atr14,
            }
        )

    qualified_legs = [
        leg
        for leg in countertrend_legs
        if leg["duration_bars"] >= 3
        and leg["directional_closes"] >= 2
        and leg["progress_atr"] >= 0.60
    ]
    if len(qualified_legs) < 2:
        result["reason"] = "countertrend_rotations_not_wide_enough"
        result["countertrend_legs"] = countertrend_legs
        return result

    result.update(
        {
            "valid": True,
            "direction": direction,
            "reason": "latest_structure_proves_wide_channel",
            "upper_anchors": highs,
            "lower_anchors": lows,
            "upper_slope_per_bar": high_slope,
            "lower_slope_per_bar": low_slope,
            "slope_ratio": slope_ratio,
            "widths_atr": [width / atr14 for width in widths],
            "width_ratio": width_ratio,
            "countertrend_legs": countertrend_legs,
        }
    )
    return result


def narrow_channel_validation(
    rows: list[sqlite3.Row], atr14: float
) -> dict[str, Any]:
    """Conservative proof gate for a true narrow directional channel.

    A trend leg, an EMA touch, or a failed wide-channel hypothesis is not a
    narrow channel.  The proof must contain a persistent, efficient directional
    leg with shallow internal pullbacks and only a shallow recent retracement.
    The result is direction-specific so an old up channel cannot authorize a
    new short setup (or vice versa).
    """
    sample = rows[-64:]
    requirements = {
        "leg_length_bars": [12, 14, 16, 20, 24],
        "maximum_pullback_bars": 4,
        "minimum_net_progress_atr": 1.80,
        "minimum_directional_efficiency": 0.62,
        "minimum_directional_close_fraction": 0.66,
        "minimum_directional_body_fraction": 0.60,
        "minimum_closes_on_trend_side_of_ema20": 0.78,
        "maximum_ema20_crosses": 1,
        "maximum_internal_pullback_atr": 0.70,
        "maximum_internal_pullback_fraction": 0.35,
        "maximum_recent_pullback_atr": 0.85,
        "maximum_recent_pullback_fraction": 0.35,
        "maximum_opposite_body_atr": 0.50,
        "maximum_largest_body_share": 0.42,
        "maximum_mean_adjacent_range_overlap": 0.72,
        "maximum_high_overlap_fraction": 0.60,
        "minimum_median_body_to_range": 0.32,
        "maximum_single_bar_range_atr": 2.00,
    }
    result: dict[str, Any] = {
        "valid": False,
        "direction": None,
        "valid_directions": [],
        "reason": "no_recent_persistent_narrow_channel",
        "requirements": requirements,
        "proofs": {},
        "best_rejections": {},
    }
    if len(sample) < 16 or atr14 <= 0:
        result["reason"] = "insufficient_bars_or_atr"
        return result

    closes = [float(row["close"]) for row in sample]
    ema20_values = ema(closes, 20)
    ema50_values = ema(closes, 50)
    proofs: dict[str, dict[str, Any]] = {}
    best_rejections: dict[str, dict[str, Any]] = {}

    def rejection_score(metrics: dict[str, Any]) -> float:
        return (
            min(float(metrics["net_progress_atr"]) / 1.80, 1.0)
            + min(float(metrics["directional_efficiency"]) / 0.58, 1.0)
            + min(float(metrics["directional_close_fraction"]) / 0.62, 1.0)
            + min(float(metrics["trend_side_ema20_fraction"]) / 0.70, 1.0)
        )

    for direction in ("up", "down"):
        sign = 1.0 if direction == "up" else -1.0
        for trailing_bars in range(0, 5):
            leg_end = len(sample) - 1 - trailing_bars
            for leg_length in (24, 20, 16, 14, 12):
                leg_start = leg_end - leg_length + 1
                if leg_start < 0:
                    continue
                leg_rows = sample[leg_start : leg_end + 1]
                leg_closes = closes[leg_start : leg_end + 1]
                deltas = [
                    leg_closes[index] - leg_closes[index - 1]
                    for index in range(1, len(leg_closes))
                ]
                path = sum(abs(value) for value in deltas)
                net_progress = sign * (leg_closes[-1] - leg_closes[0])
                directional_closes = sum(sign * value > 0 for value in deltas)
                directional_efficiency = net_progress / max(path, 1e-9)
                directional_close_fraction = directional_closes / max(
                    len(deltas), 1
                )
                trend_side_ema20 = sum(
                    sign * (leg_closes[index] - ema20_values[leg_start + index])
                    >= -0.05 * atr14
                    for index in range(len(leg_closes))
                )
                trend_side_ema20_fraction = trend_side_ema20 / len(leg_closes)
                ema20_sides = [
                    1
                    if close_value > ema20_values[leg_start + index]
                    else -1
                    if close_value < ema20_values[leg_start + index]
                    else 0
                    for index, close_value in enumerate(leg_closes)
                ]
                ema20_crosses = sum(
                    ema20_sides[index]
                    and ema20_sides[index - 1]
                    and ema20_sides[index] != ema20_sides[index - 1]
                    for index in range(1, len(ema20_sides))
                )

                running_extreme = leg_closes[0]
                maximum_internal_pullback = 0.0
                for close_value in leg_closes[1:]:
                    if direction == "up":
                        running_extreme = max(running_extreme, close_value)
                        maximum_internal_pullback = max(
                            maximum_internal_pullback,
                            running_extreme - close_value,
                        )
                    else:
                        running_extreme = min(running_extreme, close_value)
                        maximum_internal_pullback = max(
                            maximum_internal_pullback,
                            close_value - running_extreme,
                        )

                bodies = [
                    abs(float(row["close"]) - float(row["open"]))
                    for row in leg_rows
                ]
                bar_ranges = [
                    max(float(row["high"]) - float(row["low"]), 1e-9)
                    for row in leg_rows
                ]
                body_to_range = [
                    body / bar_range
                    for body, bar_range in zip(bodies, bar_ranges)
                ]
                ordered_body_to_range = sorted(body_to_range)
                middle = len(ordered_body_to_range) // 2
                median_body_to_range = (
                    ordered_body_to_range[middle]
                    if len(ordered_body_to_range) % 2
                    else (
                        ordered_body_to_range[middle - 1]
                        + ordered_body_to_range[middle]
                    )
                    / 2.0
                )
                directional_bodies = sum(
                    sign * (float(row["close"]) - float(row["open"])) > 0
                    for row in leg_rows
                )
                directional_body_fraction = directional_bodies / len(leg_rows)
                adjacent_overlaps: list[float] = []
                for previous_row, next_row in zip(leg_rows, leg_rows[1:]):
                    overlap = max(
                        0.0,
                        min(
                            float(previous_row["high"]),
                            float(next_row["high"]),
                        )
                        - max(
                            float(previous_row["low"]),
                            float(next_row["low"]),
                        ),
                    )
                    smaller_range = min(
                        float(previous_row["high"]) - float(previous_row["low"]),
                        float(next_row["high"]) - float(next_row["low"]),
                    )
                    adjacent_overlaps.append(
                        overlap / max(smaller_range, 1e-9)
                    )
                mean_adjacent_range_overlap = sum(adjacent_overlaps) / max(
                    len(adjacent_overlaps), 1
                )
                high_overlap_fraction = sum(
                    overlap >= 0.65 for overlap in adjacent_overlaps
                ) / max(len(adjacent_overlaps), 1)
                opposite_bodies = [
                    max(
                        0.0,
                        -sign * (float(row["close"]) - float(row["open"])),
                    )
                    for row in leg_rows
                ]
                largest_body_share = max(bodies) / max(sum(bodies), 1e-9)

                trailing = sample[leg_end + 1 :]
                if trailing:
                    if direction == "up":
                        leg_extreme = max(float(row["high"]) for row in leg_rows)
                        recent_pullback = leg_extreme - min(
                            float(row["low"]) for row in trailing
                        )
                    else:
                        leg_extreme = min(float(row["low"]) for row in leg_rows)
                        recent_pullback = max(
                            float(row["high"]) for row in trailing
                        ) - leg_extreme
                else:
                    recent_pullback = 0.0

                metrics = {
                    "direction": direction,
                    "leg_start_time": int(leg_rows[0]["open_time"]),
                    "leg_end_time": int(leg_rows[-1]["open_time"]),
                    "leg_length_bars": leg_length,
                    "recent_pullback_bars": trailing_bars,
                    "net_progress_atr": net_progress / atr14,
                    "directional_efficiency": directional_efficiency,
                    "directional_close_fraction": directional_close_fraction,
                    "trend_side_ema20_fraction": trend_side_ema20_fraction,
                    "ema20_crosses": ema20_crosses,
                    "internal_pullback_atr": maximum_internal_pullback / atr14,
                    "internal_pullback_fraction": maximum_internal_pullback
                    / max(net_progress, 1e-9),
                    "recent_pullback_atr": recent_pullback / atr14,
                    "recent_pullback_fraction": recent_pullback
                    / max(net_progress, 1e-9),
                    "maximum_opposite_body_atr": max(opposite_bodies) / atr14,
                    "largest_body_share": largest_body_share,
                    "directional_body_fraction": directional_body_fraction,
                    "mean_adjacent_range_overlap": mean_adjacent_range_overlap,
                    "high_overlap_fraction": high_overlap_fraction,
                    "median_body_to_range": median_body_to_range,
                    "maximum_single_bar_range_atr": max(bar_ranges) / atr14,
                    "ema20_progress_atr": sign
                    * (ema20_values[leg_end] - ema20_values[leg_start])
                    / atr14,
                    "latest_close_vs_ema50_atr": sign
                    * (closes[-1] - ema50_values[-1])
                    / atr14,
                }
                previous_best = best_rejections.get(direction)
                if (
                    previous_best is None
                    or rejection_score(metrics) > rejection_score(previous_best)
                ):
                    best_rejections[direction] = metrics

                is_valid = (
                    metrics["net_progress_atr"] >= 1.80
                    and metrics["directional_efficiency"] >= 0.62
                    and metrics["directional_close_fraction"] >= 0.66
                    and metrics["directional_body_fraction"] >= 0.60
                    and metrics["trend_side_ema20_fraction"] >= 0.78
                    and metrics["ema20_crosses"] <= 1
                    and metrics["internal_pullback_atr"] <= 0.70
                    and metrics["internal_pullback_fraction"] <= 0.35
                    and metrics["recent_pullback_atr"] <= 0.85
                    and metrics["recent_pullback_fraction"] <= 0.35
                    and metrics["maximum_opposite_body_atr"] <= 0.50
                    and metrics["largest_body_share"] <= 0.42
                    and metrics["mean_adjacent_range_overlap"] <= 0.72
                    and metrics["high_overlap_fraction"] <= 0.60
                    and metrics["median_body_to_range"] >= 0.32
                    and metrics["maximum_single_bar_range_atr"] <= 2.00
                    and metrics["ema20_progress_atr"] >= 0.35
                    and metrics["latest_close_vs_ema50_atr"] >= -0.15
                )
                if not is_valid:
                    continue
                current_best = proofs.get(direction)
                if current_best is None or (
                    metrics["directional_efficiency"],
                    metrics["net_progress_atr"],
                    -metrics["recent_pullback_bars"],
                ) > (
                    current_best["directional_efficiency"],
                    current_best["net_progress_atr"],
                    -current_best["recent_pullback_bars"],
                ):
                    proofs[direction] = metrics

    valid_directions = sorted(proofs)
    result["proofs"] = proofs
    result["best_rejections"] = best_rejections
    result["valid_directions"] = valid_directions
    if valid_directions:
        result.update(
            {
                "valid": True,
                "direction": valid_directions[0]
                if len(valid_directions) == 1
                else "both",
                "reason": "recent_persistent_narrow_channel_proven",
            }
        )
    return result


def _quantile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = max(0.0, min(1.0, fraction)) * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _compress_edge_visits(
    visits: list[dict[str, float | int | str]]
) -> list[dict[str, float | int | str]]:
    """Collapse a nearby wick cluster into one independent edge test."""
    compressed: list[dict[str, float | int | str]] = []
    for visit in visits:
        if (
            compressed
            and visit["side"] == compressed[-1]["side"]
            and int(visit["index"]) - int(compressed[-1]["index"]) <= 2
        ):
            previous = compressed[-1]
            better = (
                float(visit["price"]) > float(previous["price"])
                if visit["side"] == "U"
                else float(visit["price"]) < float(previous["price"])
            )
            if better:
                compressed[-1] = visit
            continue
        compressed.append(visit)
    return compressed


def _independent_touch_count(indices: list[int], maximum_gap: int = 2) -> int:
    """Count separated edge tests; adjacent wick clusters are one test."""
    groups = 0
    previous = -10_000
    for index in sorted(indices):
        if index - previous > maximum_gap:
            groups += 1
        previous = index
    return groups


def _contact_boundary(
    segment: list[sqlite3.Row],
    atr14: float,
    side: str,
    raw_width: float,
) -> dict[str, Any]:
    """Choose a visible boundary from wick contacts and body containment.

    A range edge is normally the horizontal line repeatedly touched by wicks
    while candle bodies remain on the range side.  One isolated liquidity
    sweep must not stretch the whole rectangle to a rolling high/low.
    """
    highs = [float(row["high"]) for row in segment]
    lows = [float(row["low"]) for row in segment]
    opens = [float(row["open"]) for row in segment]
    closes = [float(row["close"]) for row in segment]
    extremes = highs if side == "upper" else lows
    outer = max(extremes) if side == "upper" else min(extremes)
    touch_tolerance = max(0.32 * atr14, 0.025 * raw_width)
    outer_tolerance = max(0.40 * atr14, 0.035 * raw_width)
    body_tolerance = max(0.06 * atr14, 0.008 * raw_width)
    allowed_body_violations = max(1, round(0.06 * len(segment)))
    allowed_close_violations = max(1, round(0.04 * len(segment)))

    def metrics(level: float, tolerance: float) -> dict[str, Any]:
        touches = [
            index
            for index, extreme in enumerate(extremes)
            if abs(extreme - level) <= tolerance
        ]
        if side == "upper":
            body_violation_indices = [
                index
                for index, (open_, close) in enumerate(zip(opens, closes))
                if max(open_, close) > level + body_tolerance
            ]
            close_violation_indices = [
                index
                for index, close in enumerate(closes)
                if close > level + body_tolerance
            ]
        else:
            body_violation_indices = [
                index
                for index, (open_, close) in enumerate(zip(opens, closes))
                if min(open_, close) < level - body_tolerance
            ]
            close_violation_indices = [
                index
                for index, close in enumerate(closes)
                if close < level - body_tolerance
            ]
        # The first bar may be the ingress/transition candle from the prior
        # price area.  Once the balance has been entered, however, a proposed
        # edge may not cut through later candle bodies before the true exit.
        interior_body_violations = sum(
            index > 0 for index in body_violation_indices
        )
        interior_close_violations = sum(
            index > 0 for index in close_violation_indices
        )
        return {
            "level": level,
            "touches": len(touches),
            "independent_touches": _independent_touch_count(touches),
            "body_violations": len(body_violation_indices),
            "close_violations": len(close_violation_indices),
            "interior_body_violations": interior_body_violations,
            "interior_close_violations": interior_close_violations,
        }

    # A genuine outer structural edge may consist of two separated pushes in
    # the same price band. Preserve that edge even when its exact extreme is
    # touched only once; this avoids over-shrinking a clear double top/bottom.
    outer_metrics = metrics(outer, outer_tolerance)
    if (
        outer_metrics["independent_touches"] >= 2
        and outer_metrics["body_violations"] <= allowed_body_violations
        and outer_metrics["close_violations"] <= allowed_close_violations
        and outer_metrics["interior_body_violations"] == 0
        and outer_metrics["interior_close_violations"] == 0
    ):
        return {
            **outer_metrics,
            "level": outer,
            "selection": "separated_outer_structural_tests",
            "touch_tolerance": outer_tolerance,
            "body_tolerance": body_tolerance,
        }

    midpoint = (max(highs) + min(lows)) / 2.0
    # Candidate levels must be structural wick contacts, not every bar's
    # rolling high/low.  Otherwise a dense sequence of ordinary internal
    # candles can outvote the visually obvious rejection line.
    pivot_levels: list[float] = [outer]
    for index in range(1, len(extremes) - 1):
        value = extremes[index]
        is_pivot = (
            value >= extremes[index - 1] and value > extremes[index + 1]
            if side == "upper"
            else value <= extremes[index - 1] and value < extremes[index + 1]
        )
        if is_pivot:
            pivot_levels.append(value)

    candidates: list[dict[str, Any]] = []
    for level in sorted(set(pivot_levels)):
        if side == "upper" and level <= midpoint:
            continue
        if side == "lower" and level >= midpoint:
            continue
        candidate = metrics(level, touch_tolerance)
        if (
            candidate["independent_touches"] < 2
            or candidate["body_violations"] > allowed_body_violations
            or candidate["close_violations"] > allowed_close_violations
            or candidate["interior_body_violations"] > 0
            or candidate["interior_close_violations"] > 0
        ):
            continue
        candidates.append(candidate)

    if not candidates:
        return {
            **outer_metrics,
            "level": outer,
            "selection": "outer_fallback_no_contained_contact_cluster",
            "touch_tolerance": outer_tolerance,
            "body_tolerance": body_tolerance,
        }

    # Independent contacts come first.  Close/body containment is a hard
    # quality condition above; among equally supported structural levels keep
    # the more external line before considering adjacent raw wick count.  This
    # prevents several neighbouring candles in one push from pulling an edge
    # into the middle of the balance.
    direction_tiebreak = 1.0 if side == "upper" else -1.0
    selected = max(
        candidates,
        key=lambda item: (
            int(item["independent_touches"]),
            -int(item["close_violations"]),
            -int(item["body_violations"]),
            direction_tiebreak * float(item["level"]),
            int(item["touches"]),
        ),
    )
    return {
        **selected,
        "selection": "structural_wick_contacts_with_body_containment",
        "touch_tolerance": touch_tolerance,
        "body_tolerance": body_tolerance,
    }


def horizontal_range_boundaries(
    segment: list[sqlite3.Row], atr14: float
) -> dict[str, Any]:
    """Return contact/body-defined upper and lower horizontal range edges."""
    if not segment:
        raise ValueError("horizontal range boundary segment is empty")
    highs = [float(row["high"]) for row in segment]
    lows = [float(row["low"]) for row in segment]
    raw_width = max(highs) - min(lows)
    upper_profile = _contact_boundary(segment, atr14, "upper", raw_width)
    lower_profile = _contact_boundary(segment, atr14, "lower", raw_width)
    upper = float(upper_profile["level"])
    lower = float(lower_profile["level"])
    if upper <= lower:
        upper = max(highs)
        lower = min(lows)
        upper_profile["selection"] = "full_envelope_invalid_contact_pair"
        lower_profile["selection"] = "full_envelope_invalid_contact_pair"
    return {
        "upper": upper,
        "lower": lower,
        "upper_profile": upper_profile,
        "lower_profile": lower_profile,
        "raw_upper": max(highs),
        "raw_lower": min(lows),
    }


def _directional_leg_metrics(
    segment: list[sqlite3.Row], atr14: float
) -> dict[str, Any]:
    """Measure whether a short candle sequence is a directional transition leg."""
    if len(segment) < 3 or atr14 <= 0:
        return {
            "direction": None,
            "progress_atr": 0.0,
            "efficiency": 0.0,
            "directional_close_fraction": 0.0,
            "has_displacement": False,
        }
    first_open = float(segment[0]["open"])
    closes = [float(row["close"]) for row in segment]
    net = closes[-1] - first_open
    direction = "up" if net > 0 else "down" if net < 0 else None
    sign = 1.0 if direction == "up" else -1.0
    path_points = [first_open, *closes]
    path = sum(
        abs(path_points[index] - path_points[index - 1])
        for index in range(1, len(path_points))
    )
    directional_steps = sum(
        sign * (path_points[index] - path_points[index - 1]) > 0
        for index in range(1, len(path_points))
    )
    has_displacement = False
    for row in segment:
        open_, high, low, close = map(
            float, (row["open"], row["high"], row["low"], row["close"])
        )
        body = abs(close - open_)
        location = (close - low) / max(high - low, 1e-9)
        if (
            direction == "up"
            and body >= 0.75 * atr14
            and location >= 0.65
        ) or (
            direction == "down"
            and body >= 0.75 * atr14
            and location <= 0.35
        ):
            has_displacement = True
            break
    return {
        "direction": direction,
        "progress_atr": abs(net) / atr14,
        "efficiency": abs(net) / max(path, 1e-9),
        "directional_close_fraction": directional_steps
        / max(len(path_points) - 1, 1),
        "has_displacement": has_displacement,
    }


def _trim_directional_ingress(
    segment: list[sqlite3.Row], atr14: float
) -> tuple[list[sqlite3.Row], int, dict[str, Any] | None]:
    """Exclude a directional entry leg while retaining its terminal edge pivot.

    A range may begin only after the one-way migration into the new price area
    has stopped.  The terminal candle is retained because its extreme can
    establish the first valid balance edge; earlier migration candles cannot
    count as range contacts.
    """
    if len(segment) < 15 or atr14 <= 0:
        return segment, 0, None
    maximum_end = min(10, len(segment) - 12)
    best_end: int | None = None
    best_metrics: dict[str, Any] | None = None
    for end_index in range(2, maximum_end + 1):
        metrics = _directional_leg_metrics(segment[: end_index + 1], atr14)
        qualifies = (
            metrics["direction"] is not None
            and float(metrics["progress_atr"]) >= 1.20
            and float(metrics["efficiency"]) >= 0.58
            and float(metrics["directional_close_fraction"]) >= 0.60
            and bool(metrics["has_displacement"])
        )
        if qualifies:
            best_end = end_index
            best_metrics = metrics
    if best_end is None:
        return segment, 0, None
    return segment[best_end:], best_end, {
        **(best_metrics or {}),
        "trimmed_bars": best_end,
        "terminal_time": int(segment[best_end]["open_time"]),
    }


def _prove_horizontal_range(
    segment: list[sqlite3.Row], atr14: float, base_index: int
) -> dict[str, Any] | None:
    """Prove a balanced horizontal range without using rolling extremes alone."""
    segment, ingress_trimmed_bars, ingress_profile = _trim_directional_ingress(
        segment, atr14
    )
    base_index += ingress_trimmed_bars
    if len(segment) < 12:
        return None
    highs = [float(row["high"]) for row in segment]
    lows = [float(row["low"]) for row in segment]
    closes = [float(row["close"]) for row in segment]
    # Quantiles provide a stable band for proving repeated rotations. Visible
    # boundaries are selected later from repeated wick contacts plus body
    # containment; isolated outer sweeps do not automatically enlarge the box.
    core_upper = _quantile(highs, 0.85)
    core_lower = _quantile(lows, 0.15)
    core_width = core_upper - core_lower
    if core_width < 1.20 * atr14 or core_width > 6.00 * atr14:
        return None

    # Do not let a terminal displacement/breakout candle become part of the
    # range simply because most earlier closes were inside. The lifecycle ends
    # before that candle; a later confirmation may still validate the break.
    last_open = float(segment[-1]["open"])
    last_high = float(segment[-1]["high"])
    last_low = float(segment[-1]["low"])
    last_close = closes[-1]
    last_body = abs(last_close - last_open)
    last_location = (last_close - last_low) / max(last_high - last_low, 1e-9)
    terminal_break_up = (
        last_close > core_upper + 0.20 * atr14
        and last_body >= 0.60 * atr14
        and last_location >= 0.65
    )
    terminal_break_down = (
        last_close < core_lower - 0.20 * atr14
        and last_body >= 0.60 * atr14
        and last_location <= 0.35
    )
    two_closes_up = (
        len(closes) >= 2
        and closes[-2] > core_upper + 0.12 * atr14
        and closes[-1] > core_upper + 0.12 * atr14
    )
    two_closes_down = (
        len(closes) >= 2
        and closes[-2] < core_lower - 0.12 * atr14
        and closes[-1] < core_lower - 0.12 * atr14
    )
    if terminal_break_up or terminal_break_down or two_closes_up or two_closes_down:
        return None

    tolerance = max(0.30 * atr14, 0.08 * core_width)
    visits: list[dict[str, float | int | str]] = []
    for index in range(1, len(segment) - 1):
        high = highs[index]
        low = lows[index]
        is_upper_pivot = high >= highs[index - 1] and high > highs[index + 1]
        is_lower_pivot = low <= lows[index - 1] and low < lows[index + 1]
        if is_upper_pivot and abs(high - core_upper) <= tolerance:
            visits.append(
                {
                    "side": "U",
                    "index": base_index + index,
                    "time": int(segment[index]["open_time"]),
                    "price": high,
                }
            )
        if is_lower_pivot and abs(low - core_lower) <= tolerance:
            visits.append(
                {
                    "side": "L",
                    "index": base_index + index,
                    "time": int(segment[index]["open_time"]),
                    "price": low,
                }
            )
    visits.sort(key=lambda item: int(item["index"]))
    visits = _compress_edge_visits(visits)
    upper_tests = [visit for visit in visits if visit["side"] == "U"]
    lower_tests = [visit for visit in visits if visit["side"] == "L"]
    if len(upper_tests) < 2 or len(lower_tests) < 2:
        return None
    if min(
        int(points[index]["index"]) - int(points[index - 1]["index"])
        for points in (upper_tests, lower_tests)
        for index in range(1, len(points))
    ) < 4:
        return None

    alternating: list[dict[str, float | int | str]] = []
    for visit in visits:
        if not alternating or visit["side"] != alternating[-1]["side"]:
            alternating.append(visit)
        else:
            previous = alternating[-1]
            better = (
                float(visit["price"]) > float(previous["price"])
                if visit["side"] == "U"
                else float(visit["price"]) < float(previous["price"])
            )
            if better:
                alternating[-1] = visit
    if len(alternating) < 4:
        return None

    upper_drift = max(float(item["price"]) for item in upper_tests) - min(
        float(item["price"]) for item in upper_tests
    )
    lower_drift = max(float(item["price"]) for item in lower_tests) - min(
        float(item["price"]) for item in lower_tests
    )
    if max(upper_drift, lower_drift) > max(0.65 * atr14, 0.22 * core_width):
        return None

    inside_closes = sum(
        1
        for close in closes
        if core_lower - 0.20 * atr14 <= close <= core_upper + 0.20 * atr14
    )
    if inside_closes / len(closes) < 0.75:
        return None
    net_progress = abs(closes[-1] - closes[0])
    indexed_closes = [
        {"index": index, "price": close} for index, close in enumerate(closes)
    ]
    slope, _ = _linear_slope(indexed_closes)
    if (
        net_progress > 0.70 * core_width
        or abs(slope) * (len(closes) - 1) > 0.80 * core_width
    ):
        return None

    boundary_profile = horizontal_range_boundaries(segment, atr14)
    upper = float(boundary_profile["upper"])
    lower = float(boundary_profile["lower"])
    width = upper - lower
    return {
        "start_time": int(segment[0]["open_time"]),
        "end_time": int(segment[-1]["open_time"]),
        "upper": upper,
        "lower": lower,
        "width_atr": width / atr14,
        "core_upper": core_upper,
        "core_lower": core_lower,
        "core_width_atr": core_width / atr14,
        "upper_tests": upper_tests,
        "lower_tests": lower_tests,
        "alternating_edge_visits": alternating,
        "rotation_count": len(alternating) - 1,
        "inside_close_fraction": inside_closes / len(closes),
        "upper_drift_atr": upper_drift / atr14,
        "lower_drift_atr": lower_drift / atr14,
        "boundary_method": "structural_contacts_after_ingress_trim_v5",
        "upper_boundary_profile": boundary_profile["upper_profile"],
        "lower_boundary_profile": boundary_profile["lower_profile"],
        "raw_upper": boundary_profile["raw_upper"],
        "raw_lower": boundary_profile["raw_lower"],
        "ingress_trimmed_bars": ingress_trimmed_bars,
        "ingress_profile": ingress_profile,
    }


def range_validation(rows: list[sqlite3.Row], atr14: float) -> dict[str, Any]:
    """Find a proven recent range and reject it after an accepted breakout."""
    sample = rows[-96:]
    result: dict[str, Any] = {
        "valid": False,
        "reason": "no_balanced_horizontal_range",
        "requirements": {
            "minimum_bars": 12,
            "independent_upper_tests": 2,
            "independent_lower_tests": 2,
            "same_side_min_gap_bars": 4,
            "minimum_alternating_edge_visits": 4,
            "minimum_width_atr": 1.20,
            "maximum_width_atr": 6.00,
            "minimum_inside_close_fraction": 0.75,
            "directional_ingress_excluded": True,
            "failed_break_return_keeps_range_active": True,
        },
    }
    if len(sample) < 12 or atr14 <= 0:
        return result

    proofs: list[dict[str, Any]] = []
    end_min = max(12, len(sample) - 18)
    for end in range(len(sample), end_min - 1, -1):
        for length in (60, 48, 36, 30, 24, 18, 12):
            start = end - length
            if start < 0:
                continue
            proof = _prove_horizontal_range(sample[start:end], atr14, start)
            if proof:
                proof["_start_index"] = start + int(
                    proof.get("ingress_trimmed_bars", 0)
                )
                proof["_end_index"] = end
                proofs.append(proof)
    if not proofs:
        return result

    proof = max(
        proofs,
        key=lambda item: (
            int(item["_end_index"]),
            int(item["rotation_count"]),
            int(item["_end_index"]) - int(item["_start_index"]),
        ),
    )
    following = sample[int(proof["_end_index"]) :]
    upper = float(proof["upper"])
    lower = float(proof["lower"])
    outside_up = 0
    outside_down = 0
    broken: dict[str, Any] | None = None
    previous_close = (
        float(sample[int(proof["_end_index"]) - 1]["close"])
        if int(proof["_end_index"]) > 0
        else float(following[0]["open"])
        if following
        else 0.0
    )
    for row_index, row in enumerate(following):
        open_, high, low, close = map(
            float, (row["open"], row["high"], row["low"], row["close"])
        )
        body = abs(close - open_)
        outside_up = outside_up + 1 if close > upper + 0.12 * atr14 else 0
        outside_down = outside_down + 1 if close < lower - 0.12 * atr14 else 0
        displaced_up = (
            close > upper + 0.20 * atr14
            and body >= 0.60 * atr14
            and close >= low + 0.65 * max(high - low, 1e-9)
        )
        displaced_down = (
            close < lower - 0.20 * atr14
            and body >= 0.60 * atr14
            and close <= low + 0.35 * max(high - low, 1e-9)
        )
        if outside_up >= 2 or outside_down >= 2 or displaced_up or displaced_down:
            direction = "up" if displaced_up or outside_up >= 2 else "down"
            follow_through = following[row_index + 1 : row_index + 1 + 4]
            returned_to_balance = (
                direction == "up"
                and any(
                    float(future["close"]) <= upper + 0.02 * atr14
                    for future in follow_through
                )
            ) or (
                direction == "down"
                and any(
                    float(future["close"]) >= lower - 0.02 * atr14
                    for future in follow_through
                )
            )
            if returned_to_balance:
                outside_up = 0
                outside_down = 0
                previous_close = close
                continue
            broken = {
                "time": int(row["open_time"]),
                "direction": direction,
                "close": close,
                "previous_close": previous_close,
                "displacement": displaced_up or displaced_down,
            }
            break
        previous_close = close

    proof.pop("_start_index", None)
    proof.pop("_end_index", None)
    result.update(proof)
    if broken:
        result.update(
            {
                "valid": False,
                "reason": "proven_range_already_broken",
                "broken_at": broken,
            }
        )
    else:
        result.update({"valid": True, "reason": "balanced_horizontal_range_proven"})
    return result


def authoritative_chart_range_validation(
    chart_ranges: list[dict[str, Any]],
    current: sqlite3.Row,
    atr14: float,
) -> dict[str, Any] | None:
    """Use user-visible orange rectangles before any inferred OHLC range.

    A manually added, moved, or resized rectangle is authoritative. Auto
    rectangles are a second choice. The rectangle remains eligible on its
    final bar and the immediately following bar so a displacement close can be
    evaluated against the range it just left.
    """
    bar_time = int(current["open_time"])
    close = float(current["close"])
    high = float(current["high"])
    low = float(current["low"])
    eligible: list[dict[str, Any]] = []
    for item in chart_ranges:
        start_time = int(item["start_time"])
        end_time = int(item["end_time"])
        if start_time > bar_time or bar_time > end_time + BAR_SECONDS:
            continue
        # The first bar immediately after the marked balance phase can be a
        # strong displacement candle that no longer overlaps the box. Time
        # adjacency is therefore sufficient; a price-overlap requirement
        # would reject precisely the cleanest range breakouts.
        eligible.append(item)
    if not eligible:
        return None

    chosen = max(
        eligible,
        key=lambda item: (
            str(item.get("source")) == "manual",
            bool(item.get("locked")),
            int(item["end_time"]),
            int(item["start_time"]),
        ),
    )
    upper = float(chosen["upper"])
    lower = float(chosen["lower"])
    source = str(chosen.get("source") or "auto")
    return {
        "valid": True,
        "reason": (
            "authoritative_manual_chart_range"
            if source == "manual"
            else "approved_visual_auto_range"
        ),
        "source": source,
        "locked": bool(chosen.get("locked")),
        "entity_id": str(chosen["entity_id"]),
        "start_time": int(chosen["start_time"]),
        "end_time": int(chosen["end_time"]),
        "upper": upper,
        "lower": lower,
        "width_atr": (upper - lower) / max(atr14, 1e-9),
        "chart_override": True,
        "requirements": {
            "definition": "visible_orange_rectangle",
            "manual_edits_have_priority": True,
        },
    }


def remove_unproven_wide_channel_hints(
    triggers: list[dict[str, Any]], validation: dict[str, Any]
) -> None:
    if validation.get("valid"):
        return
    for trigger in triggers:
        parts = [
            part.strip()
            for part in str(trigger["hypothesis"]).split(" / ")
            if part.strip() and "宽通道" not in part
        ]
        trigger["hypothesis"] = " / ".join(parts) or "通道类型待复核"
        trigger["evidence"]["wide_channel_gate"] = {
            "valid": False,
            "reason": validation.get("reason"),
        }


def remove_unproven_narrow_channel_hints(
    triggers: list[dict[str, Any]], validation: dict[str, Any]
) -> None:
    valid_directions = set(validation.get("valid_directions") or [])
    for trigger in triggers:
        expected_direction = "up" if trigger.get("direction") == "long" else "down"
        if expected_direction in valid_directions:
            continue
        parts = [
            part.strip()
            for part in str(trigger["hypothesis"]).split(" / ")
            if part.strip() and "窄通道" not in part
        ]
        trigger["hypothesis"] = " / ".join(parts) or "趋势状态待复核"
        trigger["evidence"]["narrow_channel_gate"] = {
            "valid": False,
            "expected_direction": expected_direction,
            "valid_directions": sorted(valid_directions),
            "reason": validation.get("reason"),
        }


def remove_unproven_range_hints(
    triggers: list[dict[str, Any]], validation: dict[str, Any]
) -> None:
    if validation.get("valid"):
        return
    replacements = {
        "震荡突破：位移突破 / 窄通道启动": "趋势位移 / 窄通道启动待复核",
        "震荡突破：位移突破 / 窄通道：等待回踩顺势参与": "窄通道：等待回踩顺势参与 / 趋势延续待复核",
        "震荡突破：位移突破": "趋势位移 / 状态转换待复核",
        "震荡内部：边缘反向 / 外层状态待复核": "外层状态待复核",
        "震荡内部：边缘反向 / 窄通道：等待回踩顺势参与": "窄通道：等待回踩顺势参与 / 外层状态待复核",
        "震荡内部：边缘反向 / 宽通道边缘：反向波段": "宽通道边缘：反向波段 / 外层状态待复核",
        "宽通道边缘：反向波段 / 震荡内部：边缘反向": "宽通道边缘：反向波段 / 外层状态待复核",
        "震荡内部：边缘反向": "外层状态待复核",
    }
    for trigger in triggers:
        trigger["hypothesis"] = replacements.get(
            str(trigger["hypothesis"]), trigger["hypothesis"]
        )
        trigger["evidence"]["range_gate"] = {
            "valid": False,
            "reason": validation.get("reason"),
            "upper": validation.get("upper"),
            "lower": validation.get("lower"),
            "broken_at": validation.get("broken_at"),
        }


def range_reversal_position_validation(
    current: sqlite3.Row | dict[str, Any],
    validation: dict[str, Any],
    atr14: float,
) -> dict[str, Any]:
    """Direction-specific location gate for reversals inside a marked range.

    A long reversal must still close in the lower third and a short reversal
    must still close in the upper third.  This prevents waiting for a large
    opposite candle that has already consumed the useful entry location.
    A sweep that reclaims the edge with a pin/doji body is explicitly marked
    as an early high-quality confirmation pattern.
    """
    result: dict[str, Any] = {
        "valid": False,
        "valid_directions": [],
        "reason": "no_valid_horizontal_range",
    }
    if not validation.get("valid"):
        return result
    upper = float(validation["upper"])
    lower = float(validation["lower"])
    width = upper - lower
    if width <= 0:
        result["reason"] = "invalid_range_width"
        return result

    open_ = float(current["open"])
    high = float(current["high"])
    low = float(current["low"])
    close = float(current["close"])
    candle_range = max(high - low, 1e-9)
    body = abs(close - open_)
    lower_wick = min(open_, close) - low
    upper_wick = high - max(open_, close)
    lower_third_ceiling = lower + width / 3.0
    upper_third_floor = upper - width / 3.0
    long_location_valid = lower <= close <= lower_third_ceiling
    short_location_valid = upper_third_floor <= close <= upper
    edge_tolerance = 0.10 * max(atr14, 1e-9)
    long_sweep_reclaim = (
        low <= lower + edge_tolerance
        and close >= lower
        and long_location_valid
    )
    short_sweep_reclaim = (
        high >= upper - edge_tolerance
        and close <= upper
        and short_location_valid
    )
    pin_or_doji = body / candle_range <= 0.35
    long_early_reclaim = (
        long_sweep_reclaim
        and pin_or_doji
        and lower_wick / candle_range >= 0.35
    )
    short_early_reclaim = (
        short_sweep_reclaim
        and pin_or_doji
        and upper_wick / candle_range >= 0.35
    )
    valid_directions = [
        direction
        for direction, accepted in (
            ("long", long_location_valid),
            ("short", short_location_valid),
        )
        if accepted
    ]
    result.update(
        {
            "valid": bool(valid_directions),
            "valid_directions": valid_directions,
            "reason": (
                "signal_close_inside_directional_outer_third"
                if valid_directions
                else "signal_close_left_directional_outer_third"
            ),
            "upper": upper,
            "lower": lower,
            "range_width": width,
            "lower_third_ceiling": lower_third_ceiling,
            "upper_third_floor": upper_third_floor,
            "signal_open": open_,
            "signal_high": high,
            "signal_low": low,
            "signal_close": close,
            "body_share": body / candle_range,
            "lower_wick_share": lower_wick / candle_range,
            "upper_wick_share": upper_wick / candle_range,
            "long_location_valid": long_location_valid,
            "short_location_valid": short_location_valid,
            "long_sweep_reclaim": long_sweep_reclaim,
            "short_sweep_reclaim": short_sweep_reclaim,
            "long_early_pin_or_doji_reclaim": long_early_reclaim,
            "short_early_pin_or_doji_reclaim": short_early_reclaim,
        }
    )
    return result


def add_early_range_reclaim_triggers(
    triggers: list[dict[str, Any]],
    validation: dict[str, Any],
) -> None:
    """Promote edge sweep/reclaim pin bars without waiting for displacement."""
    for direction, key, code in (
        ("long", "long_early_pin_or_doji_reclaim", "lower_range_liquidity_reclaim_pin"),
        ("short", "short_early_pin_or_doji_reclaim", "upper_range_liquidity_reclaim_pin"),
    ):
        if not validation.get(key):
            continue
        if any(item.get("code") == code for item in triggers):
            continue
        add_trigger(
            triggers,
            code,
            direction,
            "震荡内部：边缘反向",
            9,
            {
                "range_reversal_gate": validation,
                "confirmation": "range_edge_liquidity_sweep_reclaimed_by_pin_or_doji",
                "large_displacement_not_required": True,
            },
            "confirmed",
        )


def narrow_pullback_opportunity_validation(
    rows: list[sqlite3.Row],
    atr14: float,
    channel_validation: dict[str, Any],
    range_validation_result: dict[str, Any],
) -> dict[str, Any]:
    """Validate that a narrow-channel continuation entry is early and useful.

    The directional channel proof is necessary but not sufficient.  The
    current bar must make a shallow/moderate early pullback into a meaningful
    level (EMA20, a separated prior swing, or a marked range breakout edge).
    Third-and-later pullbacks and mature extended channels are rejected.
    """
    result: dict[str, Any] = {
        "valid": False,
        "valid_directions": [],
        "reason": "no_direction_matched_narrow_channel",
        "proofs": {},
        "requirements": {
            "meaningful_level_required": True,
            "maximum_pullback_number": 2,
            "maximum_pullback_atr": 0.75,
            "maximum_pullback_fraction": 0.35,
            "maximum_channel_age_bars": 20,
            "maximum_channel_progress_atr": 4.0,
            "maximum_post_pullback_trend_bars": 1,
            "maximum_close_distance_from_level_atr": 0.45,
            "trend_resumption_bar_required": True,
        },
    }
    if len(rows) < 12 or atr14 <= 0:
        result["reason"] = "insufficient_bars_or_atr"
        return result
    current = rows[-1]
    closes = [float(row["close"]) for row in rows]
    ema20_values = ema(closes, 20)
    current_ema20 = ema20_values[-1]
    pivot_highs = independent_turning_points(rows[:-1][-48:], "high")
    pivot_lows = independent_turning_points(rows[:-1][-48:], "low")
    proofs: dict[str, Any] = {}

    for channel_direction in channel_validation.get("valid_directions") or []:
        trade_direction = "long" if channel_direction == "up" else "short"
        proof = (channel_validation.get("proofs") or {}).get(channel_direction)
        if not proof:
            continue
        start_time = int(proof["leg_start_time"])
        start_index = next(
            (
                index
                for index, row in enumerate(rows)
                if int(row["open_time"]) >= start_time
            ),
            max(0, len(rows) - int(proof["leg_length_bars"]) - 1),
        )
        leg_rows = rows[start_index:]
        history_rows = leg_rows[:-1]
        if len(history_rows) < 3:
            continue
        sign = 1.0 if trade_direction == "long" else -1.0

        # Count separated countertrend episodes before the candidate.  The
        # candidate itself must be the first or second trend-resumption bar;
        # an arbitrary later continuation bar cannot be relabelled a pullback.
        episodes: list[dict[str, int | float]] = []
        episode_move = 0.0
        episode_bars = 0
        episode_start_index = 0
        in_episode = False
        for index in range(1, len(history_rows)):
            delta = float(history_rows[index]["close"]) - float(
                history_rows[index - 1]["close"]
            )
            countertrend = sign * delta < 0
            if countertrend:
                if not in_episode:
                    episode_start_index = index - 1
                in_episode = True
                episode_move += abs(delta)
                episode_bars += 1
            elif in_episode:
                if episode_bars >= 2 or episode_move >= 0.12 * atr14:
                    episodes.append(
                        {
                            "start_index": episode_start_index,
                            "end_index": index - 1,
                            "bars": episode_bars,
                            "move": episode_move,
                        }
                    )
                in_episode = False
                episode_move = 0.0
                episode_bars = 0
        if in_episode and (episode_bars >= 2 or episode_move >= 0.12 * atr14):
            episodes.append(
                {
                    "start_index": episode_start_index,
                    "end_index": len(history_rows) - 1,
                    "bars": episode_bars,
                    "move": episode_move,
                }
            )
        pullback_number = len(episodes)
        latest_episode = episodes[-1] if episodes else None
        post_pullback_trend_bars = (
            len(history_rows) - 1 - int(latest_episode["end_index"])
            if latest_episode
            else len(history_rows)
        )
        if latest_episode:
            pre_pullback_rows = history_rows[
                : int(latest_episode["start_index"]) + 1
            ]
            pullback_window = leg_rows[int(latest_episode["start_index"]) :]
        else:
            pre_pullback_rows = history_rows
            pullback_window = [current]

        current_range = max(
            float(current["high"]) - float(current["low"]), 1e-9
        )
        current_body_directional = (
            sign * (float(current["close"]) - float(current["open"])) > 0
        )
        current_close_follows = (
            sign
            * (
                float(current["close"])
                - float(history_rows[-1]["close"])
            )
            > 0
        )
        current_close_location = (
            (float(current["close"]) - float(current["low"])) / current_range
            if trade_direction == "long"
            else (float(current["high"]) - float(current["close"]))
            / current_range
        )
        trend_resumption_bar = (
            current_body_directional
            and current_close_follows
            and current_close_location >= 0.60
        )

        if trade_direction == "long":
            prior_extreme = max(
                float(row["high"]) for row in pre_pullback_rows
            )
            pullback_low = min(
                float(row["low"]) for row in pullback_window
            )
            pullback_depth = prior_extreme - pullback_low
            progress = prior_extreme - float(leg_rows[0]["close"])
            ema_retest = (
                pullback_low <= current_ema20 + 0.18 * atr14
                and float(current["close"]) >= current_ema20 - 0.08 * atr14
            )
            structural_levels = [
                float(point["price"]) for point in (pivot_highs[-4:] + pivot_lows[-4:])
                if float(point["price"]) <= float(current["close"]) + 0.03 * atr14
            ]
            range_edge = (
                float(range_validation_result["upper"])
                if range_validation_result.get("valid")
                and int(current["open_time"]) >= int(range_validation_result.get("end_time", 0))
                else None
            )
            touched = lambda level: (
                pullback_low - 0.10 * atr14
                <= level
                <= max(float(row["high"]) for row in pullback_window)
                + 0.10 * atr14
            )
        else:
            prior_extreme = min(
                float(row["low"]) for row in pre_pullback_rows
            )
            pullback_high = max(
                float(row["high"]) for row in pullback_window
            )
            pullback_depth = pullback_high - prior_extreme
            progress = float(leg_rows[0]["close"]) - prior_extreme
            ema_retest = (
                pullback_high >= current_ema20 - 0.18 * atr14
                and float(current["close"]) <= current_ema20 + 0.08 * atr14
            )
            structural_levels = [
                float(point["price"]) for point in (pivot_highs[-4:] + pivot_lows[-4:])
                if float(point["price"]) >= float(current["close"]) - 0.03 * atr14
            ]
            range_edge = (
                float(range_validation_result["lower"])
                if range_validation_result.get("valid")
                and int(current["open_time"]) >= int(range_validation_result.get("end_time", 0))
                else None
            )
            touched = lambda level: (
                min(float(row["low"]) for row in pullback_window)
                - 0.10 * atr14
                <= level
                <= pullback_high + 0.10 * atr14
            )

        touched_structural = [
            level
            for level in structural_levels
            if touched(level)
            and -0.03
            <= sign * (float(current["close"]) - level) / atr14
            <= 0.45
        ]
        range_edge_retest = (
            range_edge is not None
            and touched(range_edge)
            and -0.03
            <= sign * (float(current["close"]) - range_edge) / atr14
            <= 0.45
        )
        meaningful_level = ema_retest or bool(touched_structural) or range_edge_retest
        pullback_atr = max(0.0, pullback_depth) / atr14
        pullback_fraction = max(0.0, pullback_depth) / max(progress, 1e-9)
        age_bars = len(leg_rows) - 1
        progress_atr = max(0.0, progress) / atr14
        early = (
            1 <= pullback_number <= 2
            and post_pullback_trend_bars <= 1
            and age_bars <= 20
            and progress_atr <= 4.0
        )
        depth_valid = pullback_atr <= 0.75 and pullback_fraction <= 0.35
        valid = (
            meaningful_level
            and early
            and depth_valid
            and trend_resumption_bar
        )
        proofs[trade_direction] = {
            "valid": valid,
            "channel_direction": channel_direction,
            "pullback_number": pullback_number,
            "post_pullback_trend_bars": post_pullback_trend_bars,
            "channel_age_bars": age_bars,
            "channel_progress_atr": progress_atr,
            "pullback_depth_atr": pullback_atr,
            "pullback_fraction": pullback_fraction,
            "ema20_retest": ema_retest,
            "structural_levels_touched": touched_structural,
            "range_breakout_edge_retest": range_edge_retest,
            "meaningful_level": meaningful_level,
            "early_pullback": early,
            "depth_valid": depth_valid,
            "trend_resumption_bar": trend_resumption_bar,
            "candidate_close_location": current_close_location,
            "reason": (
                "early_shallow_pullback_at_meaningful_level"
                if valid
                else "pullback_is_deep_mature_repeated_or_not_at_meaningful_level"
            ),
        }

    valid_directions = [
        direction for direction, proof in proofs.items() if proof.get("valid")
    ]
    result.update(
        {
            "valid": bool(valid_directions),
            "valid_directions": valid_directions,
            "reason": (
                "early_narrow_channel_pullback_proven"
                if valid_directions
                else "no_early_shallow_pullback_at_meaningful_level"
            ),
            "proofs": proofs,
        }
    )
    return result


def clustered_tests(
    points: list[dict[str, float | int]], current_price: float, tolerance: float
) -> list[dict[str, float | int]]:
    return [
        point
        for point in points
        if abs(float(point["price"]) - current_price) <= tolerance
    ][-4:]


def add_trigger(
    triggers: list[dict[str, Any]],
    code: str,
    direction: str,
    hypothesis: str,
    score: int,
    evidence: dict[str, Any],
    lifecycle: str = "new",
) -> None:
    triggers.append(
        {
            "code": code,
            "direction": direction,
            "hypothesis": hypothesis,
            "score": score,
            "lifecycle": lifecycle,
            "evidence": evidence,
        }
    )


def reason_family(code: str) -> str:
    if "pullback" in code:
        return "trend_pullback"
    if "breakout" in code or "displacement" in code or "micro_range" in code:
        return "breakout"
    return "edge_reversal"


def direct_triggers(rows: list[sqlite3.Row], atr14: float, ema20: float, ema50: float) -> list[dict[str, Any]]:
    current, previous = rows[-1], rows[-2]
    prior = rows[:-1]
    open_, high, low, close = map(float, (current["open"], current["high"], current["low"], current["close"]))
    prev_open, prev_high, prev_low, prev_close = map(
        float, (previous["open"], previous["high"], previous["low"], previous["close"])
    )
    body = abs(close - open_)
    current_range = high - low
    upper_wick = high - max(open_, close)
    lower_wick = min(open_, close) - low
    location = close_location(current)
    recent8 = prior[-8:]
    recent12 = prior[-12:]
    recent24 = prior[-24:]
    top8 = max(float(row["high"]) for row in recent8)
    bottom8 = min(float(row["low"]) for row in recent8)
    top12 = max(float(row["high"]) for row in recent12)
    bottom12 = min(float(row["low"]) for row in recent12)
    top24 = max(float(row["high"]) for row in recent24)
    bottom24 = min(float(row["low"]) for row in recent24)
    triggers: list[dict[str, Any]] = []
    pivot_highs = independent_turning_points(prior[-36:], "high")
    pivot_lows = independent_turning_points(prior[-36:], "low")
    high_tests = clustered_tests(pivot_highs, high, 0.35 * atr14)
    low_tests = clustered_tests(pivot_lows, low, 0.35 * atr14)

    # Displacement threshold is intentionally permissive. The reviewer must
    # still prove a real range/channel break rather than a rolling-window break.
    if body >= 0.60 * atr14 and location >= 0.68 and close > top8:
        add_trigger(
            triggers,
            "bull_displacement_breakout",
            "long",
            "震荡突破：位移突破 / 窄通道启动",
            8,
            {"body_atr": body / atr14, "close": close, "broken_level": top8, "close_location": location},
        )
    if body >= 0.60 * atr14 and location <= 0.32 and close < bottom8:
        add_trigger(
            triggers,
            "bear_displacement_breakout",
            "short",
            "震荡突破：位移突破 / 窄通道启动",
            8,
            {"body_atr": body / atr14, "close": close, "broken_level": bottom8, "close_location": location},
        )

    # Sweep/rejection. A close back through the tested level can compensate for
    # a modest wick; this catches false breaks with a large opposite body.
    upper_test = high >= top12 - 0.25 * atr14 and (
        high >= top24 - 0.25 * atr14 or len(high_tests) >= 2
    )
    lower_test = low <= bottom12 + 0.25 * atr14 and (
        low <= bottom24 + 0.25 * atr14 or len(low_tests) >= 2
    )
    if upper_test and (
        upper_wick >= 0.25 * atr14
        or (close < top12 and close < open_ and location <= 0.45)
    ):
        add_trigger(
            triggers,
            "upper_edge_sweep_watch",
            "short",
            "震荡内部：边缘反向 / 宽通道边缘：反向波段",
            7,
            {
                "tested_level": top12,
                "high": high,
                "close": close,
                "upper_wick_atr": upper_wick / atr14,
                "reclaimed_below": close < top12,
            },
            "watch",
        )
    if lower_test and (
        lower_wick >= 0.25 * atr14
        or (close > bottom12 and close > open_ and location >= 0.55)
    ):
        add_trigger(
            triggers,
            "lower_edge_sweep_watch",
            "long",
            "震荡内部：边缘反向 / 宽通道边缘：反向波段",
            7,
            {
                "tested_level": bottom12,
                "low": low,
                "close": close,
                "lower_wick_atr": lower_wick / atr14,
                "reclaimed_above": close > bottom12,
            },
            "watch",
        )

    # A large rejection/climax bar is remembered even when the exact outer
    # boundary is still ambiguous. The reviewer must keep the first reversal
    # as observation; a later bar can confirm failed continuation.
    if (
        current_range >= 1.05 * atr14
        and upper_wick >= 0.30 * current_range
        and location <= 0.48
    ):
        add_trigger(
            triggers,
            "upper_climax_rejection_watch",
            "short",
            "宽通道边缘：反向波段 / 震荡内部：边缘反向",
            7,
            {
                "high": high,
                "low": low,
                "close": close,
                "range_atr": current_range / atr14,
                "upper_wick_share": upper_wick / current_range,
            },
            "watch",
        )
    if (
        current_range >= 1.05 * atr14
        and lower_wick >= 0.30 * current_range
        and location >= 0.52
    ):
        add_trigger(
            triggers,
            "lower_climax_rejection_watch",
            "long",
            "宽通道边缘：反向波段 / 震荡内部：边缘反向",
            7,
            {
                "high": high,
                "low": low,
                "close": close,
                "range_atr": current_range / atr14,
                "lower_wick_share": lower_wick / current_range,
            },
            "watch",
        )

    # Double tests and wedge-like three pushes use independent pivots, not
    # adjacent similar wicks.
    if (
        len(high_tests) >= 2
        and high >= float(high_tests[-1]["price"]) - 0.20 * atr14
        and close < open_
        and location <= 0.45
    ):
        add_trigger(
            triggers,
            "upper_edge_retest_reversal",
            "short",
            "震荡内部：边缘反向",
            6,
            {"prior_tests": high_tests, "current_high": high, "close": close},
        )
    if (
        len(low_tests) >= 2
        and low <= float(low_tests[-1]["price"]) + 0.20 * atr14
        and close > open_
        and location >= 0.55
    ):
        add_trigger(
            triggers,
            "lower_edge_retest_reversal",
            "long",
            "震荡内部：边缘反向",
            6,
            {"prior_tests": low_tests, "current_low": low, "close": close},
        )
    last_three_lows = pivot_lows[-3:]
    if (
        len(last_three_lows) == 3
        and float(last_three_lows[0]["price"]) > float(last_three_lows[1]["price"]) > float(last_three_lows[2]["price"])
        and low >= float(last_three_lows[-1]["price"]) - 0.20 * atr14
        and close > open_
        and location >= 0.55
    ):
        add_trigger(
            triggers,
            "three_push_down_reversal",
            "long",
            "宽通道边缘：反向波段",
            7,
            {"three_lows": last_three_lows, "current_low": low, "close": close},
        )
    last_three_highs = pivot_highs[-3:]
    if (
        len(last_three_highs) == 3
        and float(last_three_highs[0]["price"]) < float(last_three_highs[1]["price"]) < float(last_three_highs[2]["price"])
        and high <= float(last_three_highs[-1]["price"]) + 0.20 * atr14
        and close < open_
        and location <= 0.45
    ):
        add_trigger(
            triggers,
            "three_push_up_reversal",
            "short",
            "宽通道边缘：反向波段",
            7,
            {"three_highs": last_three_highs, "current_high": high, "close": close},
        )

    # Local compression break. This is weaker than a full displacement and is
    # sent to Terra unless another structural trigger raises the score.
    local_top4 = max(float(row["high"]) for row in prior[-4:])
    local_bottom4 = min(float(row["low"]) for row in prior[-4:])
    if body >= 0.30 * atr14 and location >= 0.65 and close > local_top4:
        add_trigger(
            triggers,
            "micro_range_breakout_long",
            "long",
            "震荡突破：位移突破",
            6,
            {"body_atr": body / atr14, "broken_level": local_top4, "close": close},
        )
    if body >= 0.30 * atr14 and location <= 0.35 and close < local_bottom4:
        add_trigger(
            triggers,
            "micro_range_breakout_short",
            "short",
            "震荡突破：位移突破",
            6,
            {"body_atr": body / atr14, "broken_level": local_bottom4, "close": close},
        )

    # Strong failure of the most recent two-bar push. This catches a reversal
    # from a locally established edge without pretending that the whole
    # 8/12-bar rolling extreme is a boundary.
    if (
        body >= 0.65 * atr14
        and location <= 0.25
        and close < min(float(row["low"]) for row in prior[-2:])
    ):
        add_trigger(
            triggers,
            "local_upmove_failure_short",
            "short",
            "震荡内部：边缘反向 / 宽通道顺势：在有利边缘跟随主方向",
            7,
            {
                "body_atr": body / atr14,
                "broken_two_bar_low": min(float(row["low"]) for row in prior[-2:]),
                "close": close,
            },
            "confirmed",
        )
    if (
        body >= 0.65 * atr14
        and location >= 0.75
        and close > max(float(row["high"]) for row in prior[-2:])
    ):
        add_trigger(
            triggers,
            "local_downmove_failure_long",
            "long",
            "震荡内部：边缘反向 / 宽通道顺势：在有利边缘跟随主方向",
            7,
            {
                "body_atr": body / atr14,
                "broken_two_bar_high": max(float(row["high"]) for row in prior[-2:]),
                "close": close,
            },
            "confirmed",
        )

    # Follow-through after a recent breakout, including the first pullback that
    # holds the broken level.
    prior_without_previous = rows[:-2]
    prior_top8 = max(float(row["high"]) for row in prior_without_previous[-8:])
    prior_bottom8 = min(float(row["low"]) for row in prior_without_previous[-8:])
    if prev_close > prior_top8 and close >= prior_top8 and (
        close > prev_close or (low <= prior_top8 + 0.25 * atr14 and location >= 0.60)
    ):
        add_trigger(
            triggers,
            "bull_breakout_followthrough_or_retest",
            "long",
            "震荡突破：位移突破 / 窄通道：等待回踩顺势参与",
            7,
            {
                "broken_level": prior_top8,
                "previous_close": prev_close,
                "current_low": low,
                "current_close": close,
            },
            "confirmed",
        )
    if prev_close < prior_bottom8 and close <= prior_bottom8 and (
        close < prev_close or (high >= prior_bottom8 - 0.25 * atr14 and location <= 0.40)
    ):
        add_trigger(
            triggers,
            "bear_breakout_followthrough_or_retest",
            "short",
            "震荡突破：位移突破 / 窄通道：等待回踩顺势参与",
            7,
            {
                "broken_level": prior_bottom8,
                "previous_close": prev_close,
                "current_high": high,
                "current_close": close,
            },
            "confirmed",
        )

    # Trend pullbacks are candidates only. EMA direction is supporting context,
    # never proof of a channel by itself.
    closes = [float(row["close"]) for row in rows]
    ema20_series = ema(closes, 20)
    ema_slope = ema20_series[-1] - ema20_series[-4]
    if ema_slope > 0.15 * atr14 and ema20 > ema50 and low <= ema20 + 0.30 * atr14 and close > ema20 and location >= 0.55:
        add_trigger(
            triggers,
            "bull_trend_pullback",
            "long",
            "窄通道：等待回踩顺势参与 / 宽通道顺势：在有利边缘跟随主方向",
            5,
            {"ema20": ema20, "ema50": ema50, "ema20_slope_atr": ema_slope / atr14, "low": low, "close": close},
            "watch",
        )
    if ema_slope < -0.15 * atr14 and ema20 < ema50 and high >= ema20 - 0.30 * atr14 and close < ema20 and location <= 0.45:
        add_trigger(
            triggers,
            "bear_trend_pullback",
            "short",
            "窄通道：等待回踩顺势参与 / 宽通道顺势：在有利边缘跟随主方向",
            5,
            {"ema20": ema20, "ema50": ema50, "ema20_slope_atr": ema_slope / atr14, "high": high, "close": close},
            "watch",
        )

    # A large reversal/climax bar becomes a watch. The next bars decide whether
    # failed continuation or opposite follow-through is present.
    previous_range = prev_high - prev_low
    if previous_range >= 1.35 * atr14:
        if prev_close <= prev_low + 0.30 * previous_range and close > prev_close and low >= prev_low - 0.15 * atr14:
            add_trigger(
                triggers,
                "bear_climax_failed_continuation",
                "long",
                "宽通道边缘：反向波段",
                7,
                {"climax_low": prev_low, "climax_close": prev_close, "current_low": low, "current_close": close},
                "confirmed",
            )
        if prev_close >= prev_high - 0.30 * previous_range and close < prev_close and high <= prev_high + 0.15 * atr14:
            add_trigger(
                triggers,
                "bull_climax_failed_continuation",
                "short",
                "宽通道边缘：反向波段",
                7,
                {"climax_high": prev_high, "climax_close": prev_close, "current_high": high, "current_close": close},
                "confirmed",
            )

    # Follow-through after the first reversal of a three-bar directional push.
    before_previous = rows[-5:-2]
    if (
        len(before_previous) == 3
        and float(previous["low"]) < min(float(row["low"]) for row in before_previous)
        and prev_close > prev_open
        and close > prev_close
        and close > open_
        and low >= prev_low - 0.15 * atr14
    ):
        add_trigger(
            triggers,
            "three_bar_selloff_second_reversal",
            "long",
            "宽通道边缘：反向波段",
            7,
            {
                "first_reversal_low": prev_low,
                "first_reversal_close": prev_close,
                "current_low": low,
                "current_close": close,
            },
            "confirmed",
        )
    if (
        len(before_previous) == 3
        and float(previous["high"]) > max(float(row["high"]) for row in before_previous)
        and prev_close < prev_open
        and close < prev_close
        and close < open_
        and high <= prev_high + 0.15 * atr14
    ):
        add_trigger(
            triggers,
            "three_bar_rally_second_reversal",
            "short",
            "宽通道边缘：反向波段",
            7,
            {
                "first_reversal_high": prev_high,
                "first_reversal_close": prev_close,
                "current_high": high,
                "current_close": close,
            },
            "confirmed",
        )

    return triggers


def confirm_memory(
    rows: list[sqlite3.Row], memories: list[dict[str, Any]], atr14: float
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    current, previous = rows[-1], rows[-2]
    now = int(current["open_time"])
    open_, high, low, close = map(float, (current["open"], current["high"], current["low"], current["close"]))
    prev_close = float(previous["close"])
    location = close_location(current)
    confirmations: list[dict[str, Any]] = []
    surviving: list[dict[str, Any]] = []
    for memory in memories:
        age = (now - int(memory["source_bar_time"])) // BAR_SECONDS
        if age <= 0 or age > MEMORY_BARS:
            continue
        direction = memory["direction"]
        extreme = float(memory["extreme"])
        if direction == "long":
            invalidated = low < extreme - 0.25 * atr14
            confirmed = not invalidated and close > prev_close and close > open_ and location >= 0.58
        else:
            invalidated = high > extreme + 0.25 * atr14
            confirmed = not invalidated and close < prev_close and close < open_ and location <= 0.42
        if invalidated:
            continue
        if confirmed:
            add_trigger(
                confirmations,
                f"{memory['source_code']}_followthrough",
                direction,
                memory["hypothesis"],
                max(7, min(9, int(memory["score"]) + 1)),
                {
                    "source_bar_time": int(memory["source_bar_time"]),
                    "source_extreme": extreme,
                    "source_level": memory.get("reference_level"),
                    "current_close": close,
                    "age_bars": age,
                    "confirmation": "failed_continuation_and_opposite_followthrough",
                },
                "confirmed",
            )
            # Keep the source observation alive until expiry. A first apparent
            # confirmation may still be judged OBSERVE by AI; a later failure
            # or second reversal must be eligible for another review.
            surviving.append(memory)
            continue
        surviving.append(memory)
    return confirmations, surviving


def memories_from_triggers(
    triggers: list[dict[str, Any]], current: sqlite3.Row, existing: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    output = list(existing)
    for trigger in triggers:
        if trigger["lifecycle"] != "watch":
            continue
        direction = trigger["direction"]
        current_time = int(current["open_time"])
        if any(
            item["direction"] == direction
            and 0 <= current_time - int(item["source_bar_time"]) <= 3 * BAR_SECONDS
            for item in output
        ):
            continue
        output.append(
            {
                "direction": direction,
                "source_code": trigger["code"],
                "source_bar_time": current_time,
                "extreme": float(current["low"] if direction == "long" else current["high"]),
                "reference_level": trigger["evidence"].get("tested_level"),
                "hypothesis": trigger["hypothesis"],
                "score": trigger["score"],
            }
        )
    # Deduplicate same-direction watches from the same source bar.
    deduped: dict[tuple[str, int], dict[str, Any]] = {}
    for item in output:
        deduped[(item["direction"], int(item["source_bar_time"]))] = item
    return list(deduped.values())[-8:]


def candidate_for(
    rows: list[sqlite3.Row],
    vendor: str,
    symbol: str,
    memories: list[dict[str, Any]] | None = None,
    chart_ranges: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    memories = list(memories or [])
    if len(rows) < 40:
        return None, memories
    current = rows[-1]
    closes = [float(row["close"]) for row in rows]
    atr14 = atr(rows)
    if atr14 <= 0 or not math.isfinite(atr14):
        return None, memories
    ema20 = ema(closes, 20)[-1]
    ema50 = ema(closes, 50)[-1]
    direct = direct_triggers(rows, atr14, ema20, ema50)
    confirmed, surviving = confirm_memory(rows, memories, atr14)
    triggers = direct + confirmed
    channel_validation = wide_channel_validation(rows[:-1], atr14)
    remove_unproven_wide_channel_hints(triggers, channel_validation)
    horizontal_range_validation = authoritative_chart_range_validation(
        list(chart_ranges or []), current, atr14
    )
    if horizontal_range_validation is None:
        horizontal_range_validation = range_validation(rows[:-1], atr14)
    remove_unproven_range_hints(triggers, horizontal_range_validation)
    range_reversal_validation = range_reversal_position_validation(
        current, horizontal_range_validation, atr14
    )
    add_early_range_reclaim_triggers(triggers, range_reversal_validation)
    tight_channel_validation = narrow_channel_validation(rows[:-1], atr14)
    remove_unproven_narrow_channel_hints(triggers, tight_channel_validation)
    narrow_pullback_validation = narrow_pullback_opportunity_validation(
        rows,
        atr14,
        tight_channel_validation,
        horizontal_range_validation,
    )
    next_memories = memories_from_triggers(direct, current, surviving)
    if not triggers:
        return None, next_memories

    # Keep competing interpretations. The reviewer must choose one or reject
    # all; the gate never decides market state.
    directions = sorted({trigger["direction"] for trigger in triggers})
    dominant = max(triggers, key=lambda item: (int(item["score"]), item["lifecycle"] == "confirmed"))
    score = max(int(trigger["score"]) for trigger in triggers)
    lifecycle = (
        "confirmed"
        if any(trigger["lifecycle"] == "confirmed" for trigger in triggers)
        else "watch"
        if any(trigger["lifecycle"] == "watch" for trigger in triggers)
        else "new"
    )
    prior = rows[:-1]
    recent24 = prior[-24:]
    recent72 = rows[-72:]
    candidate = {
        "vendor": vendor,
        "symbol": symbol,
        "timeframe": TIMEFRAME,
        "bar_time": int(current["open_time"]),
        "close": float(current["close"]),
        "atr14": round(atr14, 8),
        "ema20": round(ema20, 8),
        "ema50": round(ema50, 8),
        "window": {
            "high24": max(float(row["high"]) for row in recent24),
            "low24": min(float(row["low"]) for row in recent24),
        },
        "direction_hint": dominant["direction"] if len(directions) == 1 else "conflict",
        "setup_hint": dominant["hypothesis"],
        "reason": dominant["code"],
        "reason_codes": [trigger["code"] for trigger in triggers],
        "reason_families": sorted({reason_family(trigger["code"]) for trigger in triggers}),
        "candidate_score": score,
        "candidate_lifecycle": lifecycle,
        "hypotheses": triggers,
        "wide_channel_validation": channel_validation,
        "narrow_channel_validation": tight_channel_validation,
        "narrow_pullback_validation": narrow_pullback_validation,
        "range_validation": horizontal_range_validation,
        "range_reversal_validation": range_reversal_validation,
        "chart_ranges": list(chart_ranges or []),
        "active_memories": next_memories,
        "needs_sol": score >= 8 or lifecycle == "confirmed" or len(directions) > 1,
        "recent_ohlc": [
            [
                int(row["open_time"]),
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                None if row["volume"] is None else float(row["volume"]),
            ]
            for row in recent72
        ],
    }
    return candidate, next_memories


def should_emit_candidate(
    candidate: dict[str, Any], previous: dict[str, Any] | None
) -> bool:
    """Debounce repeated hypotheses without hiding a new confirmation."""
    score = int(candidate.get("candidate_score", 0))
    if score < 7:
        return False
    if not previous:
        return True
    now = int(candidate["bar_time"])
    previous_time = int(previous.get("bar_time", 0))
    previous_codes = set(previous.get("reason_codes", []))
    current_codes = set(candidate.get("reason_codes", []))
    previous_families = set(previous.get("reason_families", []))
    current_families = set(candidate.get("reason_families", []))
    if candidate.get("direction_hint") != previous.get("direction_hint"):
        return True
    lifecycle_rank = {"watch": 0, "new": 1, "confirmed": 2}
    if lifecycle_rank.get(str(candidate.get("candidate_lifecycle")), 0) > lifecycle_rank.get(
        str(previous.get("candidate_lifecycle")), 0
    ):
        return True
    if current_families - previous_families:
        return True
    if score > int(previous.get("candidate_score", 0)):
        return True
    # Low-score EMA/retest observations are sampled sparsely. Structural
    # score-7/8 candidates may be reconsidered after one intervening bar.
    cooldown_bars = 6 if score <= 5 else 4 if score == 6 else 3
    return now - previous_time >= cooldown_bars * BAR_SECONDS


def load_memory(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": MEMORY_VERSION, "symbols": {}, "emissions": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": MEMORY_VERSION, "symbols": {}, "emissions": {}}
    if payload.get("version") != MEMORY_VERSION:
        return {"version": MEMORY_VERSION, "symbols": {}, "emissions": {}}
    payload.setdefault("symbols", {})
    payload.setdefault("emissions", {})
    return payload


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", delete=False, dir=path.parent
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        temporary = Path(handle.name)
    temporary.replace(path)


def recent_signals(conn: sqlite3.Connection, vendor: str, symbol: str, bar_time: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id,bar_time,signal_price,direction,setup_type,grade,
               reasons_json,context_json,created_at
        FROM signals
        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time<?
          AND setup_type NOT IN (
              '震荡下八分之一触碰',
              '震荡上八分之一触碰'
          )
        ORDER BY bar_time DESC,id DESC LIMIT 3
        """,
        (vendor, symbol, TIMEFRAME, bar_time),
    ).fetchall()
    output: list[dict[str, Any]] = []
    for row in rows:
        try:
            context = json.loads(row["context_json"] or "{}")
        except json.JSONDecodeError:
            context = {}
        output.append(
            {
                "id": row["id"],
                "bar_time": row["bar_time"],
                "signal_price": row["signal_price"],
                "direction": row["direction"],
                "setup_type": row["setup_type"],
                "grade": row["grade"],
                "reasons": json.loads(row["reasons_json"] or "[]"),
                "confirmation_price": context.get("confirmation_price"),
                "invalidation_price": context.get("invalidation_price"),
                "created_at": row["created_at"],
            }
        )
    return output


def load_chart_ranges(
    conn: sqlite3.Connection,
    vendor: str,
    symbol: str,
    through_time: int,
) -> list[dict[str, Any]]:
    try:
        rows = conn.execute(
            """
            SELECT entity_id,start_time,end_time,upper,lower,
                   source,locked,status,created_at,updated_at
            FROM chart_ranges
            WHERE vendor=? AND symbol=? AND timeframe=? AND status='active'
              AND start_time<=? AND end_time>=?
            ORDER BY locked DESC,source='manual' DESC,start_time
            """,
            (
                vendor,
                symbol,
                TIMEFRAME,
                through_time + BAR_SECONDS,
                through_time - 144 * BAR_SECONDS,
            ),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [dict(item) for item in rows]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_DB.parent / "candidate_queue.json")
    parser.add_argument("--memory", type=Path, default=DEFAULT_DB.parent / "candidate_memory.json")
    args = parser.parse_args()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    memory_payload = load_memory(args.memory)
    candidates: list[dict[str, Any]] = []
    for vendor, symbol in WATCHLIST:
        rows = conn.execute(
            """
            SELECT open_time,open,high,low,close,volume FROM candles
            WHERE vendor=? AND symbol=? AND timeframe=? AND is_final=1
            ORDER BY open_time DESC LIMIT 120
            """,
            (vendor, symbol, TIMEFRAME),
        ).fetchall()
        latest_bar_time = int(rows[0]["open_time"]) if rows else 0
        key = f"{vendor}:{symbol}:{TIMEFRAME}"
        candidate, memories = candidate_for(
            list(reversed(rows)),
            vendor,
            symbol,
            memory_payload["symbols"].get(key, []),
            load_chart_ranges(conn, vendor, symbol, latest_bar_time),
        )
        memory_payload["symbols"][key] = memories
        if candidate and should_emit_candidate(
            candidate, memory_payload["emissions"].get(key)
        ):
            candidate["recent_signals"] = recent_signals(
                conn, vendor, symbol, int(candidate["bar_time"])
            )
            candidates.append(candidate)
            memory_payload["emissions"][key] = {
                "bar_time": candidate["bar_time"],
                "direction_hint": candidate["direction_hint"],
                "reason_codes": candidate["reason_codes"],
                "reason_families": candidate["reason_families"],
                "candidate_score": candidate["candidate_score"],
                "candidate_lifecycle": candidate["candidate_lifecycle"],
            }
    payload = {"version": 4, "candidates": candidates}
    atomic_json(args.output, payload)
    atomic_json(args.memory, memory_payload)
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
