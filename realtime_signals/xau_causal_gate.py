#!/usr/bin/env python3
"""One-way causal gate for a SHA256-locked frozen candle replay.

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
from dataclasses import replace
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
RULE_SET_KEY = os.environ.get("CAUSAL_RULE_SET", "louie")
RULE_SET_ID = os.environ.get(
    "CAUSAL_RULE_SET_ID",
    "louie_case_enhanced_ema20_no_fixed_target_v3_20260813",
)
RULE_SET_SHA256 = os.environ.get("CAUSAL_RULE_SET_SHA256", "")
LOUIE_CASE_SUPPLEMENT_RULE_SET_KEY = "louie_course_target_cases"
LOUIE_STRUCTURAL_V4_RULE_SET_KEY = "louie_structural_trailing_v4"
LOUIE_STRUCTURAL_V5_RULE_SET_KEY = "louie_structural_trailing_v5"
LOUIE_STRUCTURAL_V5_NEXTBAR_OPPOSITE_RULE_SET_KEY = (
    "louie_structural_trailing_v5_nextbar_opposite"
)
LOUIE_STRUCTURAL_V6_NEXTBAR_OPPOSITE_RULE_SET_KEY = (
    "louie_structural_trailing_v6_nextbar_opposite"
)
LOUIE_STRUCTURAL_V5_SESSION_FILTER10_RULE_SET_KEY = (
    "louie_structural_trailing_v5_nextbar_opposite_session_filter10"
)
LOUIE_RULE_SET_KEYS = {
    "louie",
    "louie_course_target",
    LOUIE_CASE_SUPPLEMENT_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V4_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V5_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V5_NEXTBAR_OPPOSITE_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V6_NEXTBAR_OPPOSITE_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V5_SESSION_FILTER10_RULE_SET_KEY,
}
LOUIE_V5_RULE_SET_KEYS = {
    LOUIE_CASE_SUPPLEMENT_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V5_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V5_NEXTBAR_OPPOSITE_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V6_NEXTBAR_OPPOSITE_RULE_SET_KEY,
    LOUIE_STRUCTURAL_V5_SESSION_FILTER10_RULE_SET_KEY,
}
LOUIE_V6_RULE_SET_KEYS = {
    LOUIE_STRUCTURAL_V6_NEXTBAR_OPPOSITE_RULE_SET_KEY,
}
LOUIE_CASE_FAMILIES = {
    "signal_bar_entry",
    "pullback_count",
    "gap",
    "market_cycle",
    "breakout_retest_second_leg",
    "wedge_or_climax",
    "risk_or_management_context",
    "no_specific_case",
}
LOUIE_SUPPLEMENTAL_CASE_LENSES = {
    "signal_context_matrix",
    "pullback_count_reset",
    "regime_transition",
    "channel_geometry",
    "breakout_acceptance_failure",
    "reversal_or_trap",
    "gap_interpretation",
    "trading_range_behavior",
    "no_additional_case",
}
LOUIE_BROOKS_CASE_LENSES = {
    "terminology_chart_basics",
    "candle_signal_bar_quality",
    "pullback_bar_count",
    "buying_selling_pressure",
    "gap_context",
    "market_cycle_always_in",
    "trend",
    "breakout",
    "channel_microchannel",
    "trading_range",
    "support_resistance",
    "measured_move_context",
    "reversal_mtr",
    "final_flag",
    "wedge",
    "double_top_bottom",
    "triangle",
    "head_shoulders",
    "rounded_top_bottom",
    "climax",
    "trader_equation_probability_context",
    "swing_scalp_context",
    "order_stop_actual_risk_context",
    "scaling_profit_management_context",
    "late_trend_entry",
    "no_matching_brooks_case",
}
LOUIE_BROOKS_SOURCE_FAMILIES = {
    "course_01_18_price_action_foundations",
    "course_19_29_patterns_reversals",
    "course_30_36_execution_management_context",
    "course_37_42_how_to_trade",
    "course_43_47_channels_ranges",
    "chart_encyclopedia_8800_cases",
    "books_bar_by_bar_trends_ranges_reversals",
    "no_specific_brooks_source",
}
CUSTOM_RULE_SET_KEYS = {
    "user_custom",
    "user_custom_v2",
    "user_custom_v2_ema20_two_close_legacy",
    "user_custom_v2_strict_narrow_channel_legacy",
    "user_custom_v2_any_pullback_legacy",
    "user_custom_v2_anchor_candle_contact_legacy",
    "user_custom_v2_anchor_required_legacy",
    "user_custom_v2_five_close_legacy",
    "user_custom_v2_unanchored_legacy",
    "user_custom_v2_range30_legacy",
    "user_custom_v2_legacy",
    "user_custom_v2_effective_swing_sr_legacy",
}
CUSTOM_V2_RULE_SET_KEY = "user_custom_v2"
CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY = (
    "user_custom_v2_effective_swing_sr_legacy"
)
CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY = (
    "user_custom_v2_ema20_two_close_legacy"
)
CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY = (
    "user_custom_v2_strict_narrow_channel_legacy"
)
CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY = "user_custom_v2_any_pullback_legacy"
CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY = (
    "user_custom_v2_anchor_candle_contact_legacy"
)
CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_KEY = "user_custom_v2_anchor_required_legacy"
CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_KEY = "user_custom_v2_five_close_legacy"
CUSTOM_V2_UNANCHORED_LEGACY_RULE_SET_KEY = "user_custom_v2_unanchored_legacy"
CUSTOM_V2_RANGE30_LEGACY_RULE_SET_KEY = "user_custom_v2_range30_legacy"
CUSTOM_V2_LEGACY_RULE_SET_KEY = "user_custom_v2_legacy"
CUSTOM_V2_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_UNANCHORED_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_RANGE30_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_EFFECTIVE_SWING_SR_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_RANGE30_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_UNANCHORED_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_RANGE30_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_RULE_SET_ID = "tvfloat_user_custom_v2_range_lifecycle_bound_20260812"
CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_ID = (
    "tvfloat_user_custom_v2_effective_swing_sr_20260812"
)
CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_ID = (
    "tvfloat_user_custom_v2_strict_narrow_channel_ema20_two_close_any_pullback_20260812"
)
CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_ID = (
    "tvfloat_user_custom_v2_strict_narrow_channel_any_pullback_20260812"
)
CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_ID = (
    "tvfloat_user_custom_v2_any_pullback_body50_anchor_contact_20260811"
)
CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_ID = (
    "tvfloat_user_custom_v2_anchor_candle_contact_first_pullback_20260811"
)
CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_ID = "tvfloat_user_custom_v2_anchor_required_first_pullback_20260811"
CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_ID = "tvfloat_user_custom_v2_five_close_breakout_20260811"
CUSTOM_V2_UNANCHORED_LEGACY_RULE_SET_ID = "tvfloat_user_custom_v2_range30_unanchored_pullback_20260810"
CUSTOM_V2_RANGE30_LEGACY_RULE_SET_ID = "tvfloat_user_custom_v2_range30_one_sided_20260810"
CUSTOM_V2_LEGACY_RULE_SET_ID = "tvfloat_user_custom_v2_four_setups_20260810"
CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout_effective_swing_sr"
)
CUSTOM_V2_RULE_VERSION = "custom_v2_range_lifecycle_bound_effective_swing_sr"
CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout"
)
CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_strict_narrow_channel_any_pullback_body50_anchor_contact_five_close_breakout"
)
CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_any_pullback_body50_anchor_contact_five_close_breakout"
)
CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_anchor_candle_contact_five_close_breakout"
)
CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_VERSION = "custom_v2_range30_one_sided_anchor_required_five_close_breakout"
CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_VERSION = "custom_v2_range30_one_sided_unanchored_pullback_five_close_breakout"
CUSTOM_V2_UNANCHORED_LEGACY_RULE_VERSION = "custom_v2_range30_one_sided_unanchored_pullback"
CUSTOM_V2_RANGE30_LEGACY_RULE_VERSION = "custom_v2_range30_one_sided"
CUSTOM_V2_LEGACY_RULE_VERSION = "custom_v2"
CUSTOM_V2_RULE_VERSIONS_BY_KEY = {
    CUSTOM_V2_RULE_SET_KEY: CUSTOM_V2_RULE_VERSION,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY: (
        CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION
    ),
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY: (
        CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION
    ),
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY: (
        CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION
    ),
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY: CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_VERSION,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY: (
        CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_VERSION
    ),
    CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_KEY: CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_VERSION,
    CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_KEY: CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_VERSION,
    CUSTOM_V2_UNANCHORED_LEGACY_RULE_SET_KEY: CUSTOM_V2_UNANCHORED_LEGACY_RULE_VERSION,
    CUSTOM_V2_RANGE30_LEGACY_RULE_SET_KEY: CUSTOM_V2_RANGE30_LEGACY_RULE_VERSION,
    CUSTOM_V2_LEGACY_RULE_SET_KEY: CUSTOM_V2_LEGACY_RULE_VERSION,
}
CUSTOM_V2_FIVE_CLOSE_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_STRICT_ANCHOR_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_REQUIRED_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_CANDLE_CONTACT_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_ANCHOR_NAMES = {
    "trend_leg_50_percent",
    "ema20",
    "prior_breakout_edge_zone",
}
TWO_DAYS_SECONDS = 2 * 24 * 60 * 60
CUSTOM_V2_ACTIVE_SETUPS = {
    "震荡真突破": "range_true_breakout",
    "震荡反转": "range_reversal",
    "窄通道回调顺势": "narrow_channel_pullback",
    "支撑压力反转": "support_resistance_reversal",
}
CUSTOM_V2_ANY_PULLBACK_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_ANY_PULLBACK_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS = {
    CUSTOM_V2_RULE_SET_KEY,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_SET_KEY,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY,
}
CUSTOM_V2_LEGACY_SETUPS = {
    "震荡真突破": "range_true_breakout",
    "震荡反转": "range_reversal",
    "窄通道首次回调顺势": "narrow_channel_first_pullback",
    "支撑压力反转": "support_resistance_reversal",
}


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_data(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"frozen data SHA256 mismatch: {digest}")
    payload = json.loads(raw)
    bars = payload.get("bars")
    symbol = payload.get("symbol")
    timeframe_minutes = payload.get("timeframe_minutes")
    if not isinstance(symbol, str) or not symbol.strip():
        raise SystemExit("unexpected frozen symbol/timeframe")
    if isinstance(timeframe_minutes, bool) or not isinstance(timeframe_minutes, int) or timeframe_minutes <= 0:
        raise SystemExit("unexpected frozen symbol/timeframe")
    if not isinstance(bars, list) or not bars:
        raise SystemExit(f"expected at least one frozen bar, got {len(bars) if isinstance(bars, list) else '?'}")
    return payload, bars


def enrich(bars: list[dict[str, Any]], timeframe_minutes: int = 5) -> list[dict[str, Any]]:
    if isinstance(timeframe_minutes, bool) or not isinstance(timeframe_minutes, int) or timeframe_minutes <= 0:
        raise ValueError(f"timeframe_minutes must be a positive integer, got {timeframe_minutes!r}")
    result: list[dict[str, Any]] = []
    ema20: float | None = None
    ema50: float | None = None
    # V1 custom historically exposed EMA50 and must remain reproducible.  The
    # V2 user rule explicitly returns to the Louie EMA20-only contract.
    include_ema50 = RULE_SET_KEY == "user_custom"
    atr14: float | None = None
    prev_close: float | None = None
    for idx, bar in enumerate(bars):
        close = float(bar["close"])
        high = float(bar["high"])
        low = float(bar["low"])
        ema20 = close if ema20 is None else close * (2 / 21) + ema20 * (19 / 21)
        if include_ema50:
            ema50 = close if ema50 is None else close * (2 / 51) + ema50 * (49 / 51)
        true_range = high - low if prev_close is None else max(
            high - low, abs(high - prev_close), abs(low - prev_close)
        )
        atr14 = true_range if atr14 is None else (atr14 * 13 + true_range) / 14
        enriched_bar = {
            **bar,
            "idx": idx,
            "ema20": ema20,
            "atr14": atr14,
            "close_time": int(bar["time"]) + timeframe_minutes * 60,
        }
        if include_ema50:
            enriched_bar["ema50"] = ema50
        else:
            # V2 is EMA20-only even if an upstream frozen row accidentally carries EMA50.
            enriched_bar.pop("ema50", None)
        result.append(enriched_bar)
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


def effective_swing_reference(
    bars: list[dict[str, Any]], idx: int, *, direction: str
) -> dict[str, Any] | None:
    """Return the latest causally confirmed swing low/high before ``idx``.

    A pivot at ``i`` becomes known only after ``i + 1`` closes.  Until a newer
    same-side pivot is confirmed, the prior one remains the effective
    structure reference.  This intentionally models the user's moving
    "previous low/previous high" definition; it is not a nearest-price search
    and has no elapsed-day requirement.
    """

    if direction not in {"long", "short"}:
        raise ValueError("direction must be long or short")
    pivot_idx: int | None = None
    for candidate_idx in range(idx - 1, 0, -1):
        previous = bars[candidate_idx - 1]
        candidate = bars[candidate_idx]
        following = bars[candidate_idx + 1]
        is_confirmed = (
            float(candidate["low"]) < float(previous["low"])
            and float(candidate["low"]) < float(following["low"])
            if direction == "long"
            else float(candidate["high"]) > float(previous["high"])
            and float(candidate["high"]) > float(following["high"])
        )
        if is_confirmed:
            pivot_idx = candidate_idx
            break
    if pivot_idx is None:
        return None
    bar = bars[pivot_idx]
    return {
        "idx": pivot_idx,
        "kind": "effective_swing_low" if direction == "long" else "effective_swing_high",
        "price": float(bar["low"] if direction == "long" else bar["high"]),
        "confirmed_at_idx": pivot_idx + 1,
        "confirmed_at_time": int(bars[pivot_idx + 1]["close_time"]),
        "open_time": int(bar["time"]),
        "beijing_open_time": bar.get("beijing_open_time"),
        "open": float(bar["open"]),
        "high": float(bar["high"]),
        "low": float(bar["low"]),
        "close": float(bar["close"]),
    }


def effective_swing_support_resistance(
    bars: list[dict[str, Any]], idx: int
) -> dict[str, Any] | None:
    if RULE_SET_KEY not in CUSTOM_V2_EFFECTIVE_SWING_SR_RULE_SET_KEYS or idx <= 0:
        return None
    return {
        "through_idx": idx,
        "no_future_bars": True,
        "confirmation_rule": "three_bar_pivot_confirmed_after_the_right_bar_closes",
        "replacement_rule": "latest_confirmed_same_side_swing_replaces_the_prior_effective_reference",
        "effective_support": effective_swing_reference(bars, idx, direction="long"),
        "effective_resistance": effective_swing_reference(bars, idx, direction="short"),
    }


def historical_support_resistance(
    bars: list[dict[str, Any]], idx: int, *, limit_per_side: int = 6
) -> dict[str, Any] | None:
    """Expose nearest historical candle levels strictly older than two days.

    This is an advisory causal inventory, not a distance threshold or a
    mechanical signal gate.  V2 does not require the reference candle to be a
    three-bar pivot, so every old candle remains eligible and the model still
    has to validate the old body/wick and current rejection under the rules.
    """

    if (
        RULE_SET_KEY not in CUSTOM_V2_RULE_SET_KEYS
        or RULE_SET_KEY in CUSTOM_V2_EFFECTIVE_SWING_SR_RULE_SET_KEYS
        or idx <= 0
    ):
        return None
    current = bars[idx]
    current_close_time = int(current["close_time"])
    current_low = float(current["low"])
    current_high = float(current["high"])
    supports: list[dict[str, Any]] = []
    resistances: list[dict[str, Any]] = []
    for reference_idx in range(idx):
        reference = bars[reference_idx]
        age_seconds = current_close_time - int(reference["close_time"])
        if age_seconds <= TWO_DAYS_SECONDS:
            continue
        body_low = min(float(reference["open"]), float(reference["close"]))
        body_high = max(float(reference["open"]), float(reference["close"]))
        base = {
            "idx": reference_idx,
            "open_time": int(reference["time"]),
            "beijing_open_time": reference.get("beijing_open_time"),
            "age_seconds": age_seconds,
            "age_days": round(age_seconds / 86400, 6),
            "open": float(reference["open"]),
            "high": float(reference["high"]),
            "low": float(reference["low"]),
            "close": float(reference["close"]),
            "body_low": body_low,
            "body_high": body_high,
        }
        supports.append(
            {
                **base,
                "kind": "historical_candle_support",
                "distance_to_current_interaction": abs(current_low - body_low),
            }
        )
        resistances.append(
            {
                **base,
                "kind": "historical_candle_resistance",
                "distance_to_current_interaction": abs(current_high - body_high),
            }
        )
    supports.sort(key=lambda row: (row["distance_to_current_interaction"], -row["age_seconds"], -row["idx"]))
    resistances.sort(key=lambda row: (row["distance_to_current_interaction"], -row["age_seconds"], -row["idx"]))
    return {
        "through_idx": idx,
        "no_future_bars": True,
        "minimum_age_rule": "strictly_more_than_2_elapsed_days",
        "minimum_age_seconds_exclusive": TWO_DAYS_SECONDS,
        "selection": "nearest historical candle levels for visual review only; no pivot or price-distance gate",
        "supports": supports[:limit_per_side],
        "resistances": resistances[:limit_per_side],
    }


def range_proof_functions() -> tuple[Any, Any, Any]:
    """Resolve the shared proof helpers in script and package import modes."""

    try:
        from candidate_filter_v2 import atr as proof_atr, custom_v2_range_validation, range_validation
    except ImportError:  # Imported as part of the realtime_signals package in tests.
        from .candidate_filter_v2 import atr as proof_atr, custom_v2_range_validation, range_validation
    return proof_atr, range_validation, custom_v2_range_validation


ACTIVE_RANGE_LIFECYCLE_CONSISTENCY: dict[str, Any] | None = None
ACTIVE_RANGE_LIFECYCLE_BARS_ID: int | None = None


def fresh_custom_range_consistency(
    bars: list[dict[str, Any]], idx: int
) -> dict[str, Any] | None:
    """Run the closed-bar detector without rewriting the lifecycle registry."""

    if RULE_SET_KEY not in CUSTOM_RULE_SET_KEYS:
        return None
    proof_atr, range_validation, custom_v2_range_validation = range_proof_functions()
    validation = (
        custom_v2_range_validation
        if RULE_SET_KEY in CUSTOM_V2_RANGE30_RULE_SET_KEYS
        else range_validation
    )

    rows = [
        {
            **bar,
            "open_time": int(bar["time"]),
            "is_final": 1,
        }
        for bar in bars[: idx + 1]
    ]
    if not rows:
        return {
            "through_idx": idx,
            "through_bar_time": None,
            "closed_bar_count": 0,
            "no_future_bars": True,
            "proof_status": "not_proven",
            "proof": {"valid": False, "reason": "insufficient_bars_or_atr"},
        }
    try:
        validation_kwargs = (
            {
                "true_break_consecutive_closes": 5,
                "maximum_touch_cluster_gap": 5,
            }
            if RULE_SET_KEY in CUSTOM_V2_FIVE_CLOSE_RULE_SET_KEYS
            else {}
        )
        proof = validation(rows, proof_atr(rows), **validation_kwargs)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        proof = {"valid": False, "reason": "range_validation_error", "error": str(exc)}
    if proof.get("valid") is True and proof.get("reason") in {
        "balanced_horizontal_range_proven",
        "one_sided_horizontal_edge_proven",
    }:
        proof_status = "active"
    elif proof.get("reason") == "proven_range_already_broken":
        proof_status = "broken"
    else:
        proof_status = "not_proven"
    public_keys = (
        "valid",
        "reason",
        "start_time",
        "end_time",
        "upper",
        "lower",
        "core_upper",
        "core_lower",
        "upper_tests",
        "lower_tests",
        "alternating_edge_visits",
        "rotation_count",
        "boundary_method",
        "requirements",
        "broken_at",
        "kind",
        "active_edge",
        "start_idx",
        "end_idx",
        "span_bars",
        "touch_span_bars",
        "upper_zone_low",
        "upper_zone_high",
        "lower_zone_low",
        "lower_zone_high",
        "midpoint",
        "upper_touch_indices",
        "lower_touch_indices",
        "independent_touch_indices",
        "independent_touch_times",
        "independent_touch_count",
        "edge_level",
        "edge_zone_low",
        "edge_zone_high",
        "body_accepted_outside",
        "range_lifecycle_id",
    )
    public_proof = {key: proof[key] for key in public_keys if key in proof}
    recognized = proof.get("recognized_structures")
    if isinstance(recognized, list):
        public_proof["recognized_structures"] = [
            {key: item[key] for key in public_keys if key in item}
            for item in recognized
            if isinstance(item, dict)
        ]
    return {
        "through_idx": idx,
        "through_bar_time": int(rows[-1]["open_time"]),
        "closed_bar_count": len(rows),
        "no_future_bars": True,
        "proof_status": proof_status,
        "proof": public_proof,
    }


def _range_proof_rows(consistency: dict[str, Any] | None) -> list[dict[str, Any]]:
    proof = consistency.get("proof") if isinstance(consistency, dict) else None
    if not isinstance(proof, dict):
        return []
    rows = [proof]
    recognized = proof.get("recognized_structures")
    if isinstance(recognized, list):
        rows.extend(item for item in recognized if isinstance(item, dict))
    unique: dict[str, dict[str, Any]] = {}
    for row in rows:
        lifecycle_id = row.get("range_lifecycle_id")
        if isinstance(lifecycle_id, str) and lifecycle_id.startswith("range-lifecycle-"):
            unique[lifecycle_id] = dict(row)
    return list(unique.values())


def _update_registered_range_lifecycle(
    proof: dict[str, Any], bars: list[dict[str, Any]], idx: int
) -> dict[str, Any]:
    """Advance one immutable-geometry lifecycle using only the five-close rule."""
    updated = dict(proof)
    end_idx = int(updated["end_idx"])
    if updated.get("reason") == "proven_range_already_broken" and isinstance(
        updated.get("broken_at"), dict
    ):
        return updated
    if updated["kind"] == "two_sided_range":
        upper_boundary = float(updated["upper_zone_high"])
        lower_boundary = float(updated["lower_zone_low"])
        watch_up = watch_down = True
    else:
        active_edge = str(updated["active_edge"])
        upper_boundary = float(
            updated.get("edge_zone_high", updated[f"{active_edge}_zone_high"])
        )
        lower_boundary = float(
            updated.get("edge_zone_low", updated[f"{active_edge}_zone_low"])
        )
        watch_up = active_edge == "upper"
        watch_down = active_edge == "lower"
    outside_up = 0
    outside_down = 0
    broken: dict[str, Any] | None = None
    for bar_idx in range(end_idx + 1, idx + 1):
        close = float(bars[bar_idx]["close"])
        outside_up = outside_up + 1 if watch_up and close > upper_boundary else 0
        outside_down = outside_down + 1 if watch_down and close < lower_boundary else 0
        if outside_up >= 5 or outside_down >= 5:
            direction = "up" if outside_up >= 5 else "down"
            broken = {
                "time": int(bars[bar_idx]["time"]),
                "direction": direction,
                "close": close,
                "previous_close": float(bars[bar_idx - 1]["close"]),
                "displacement": False,
                "confirmation_closes": 5,
                "confirmation_indices": list(range(bar_idx - 4, bar_idx + 1)),
            }
            break
    if broken is None:
        updated["valid"] = True
        updated["reason"] = (
            "balanced_horizontal_range_proven"
            if updated["kind"] == "two_sided_range"
            else "one_sided_horizontal_edge_proven"
        )
        updated.pop("broken_at", None)
    else:
        updated["valid"] = False
        updated["reason"] = "proven_range_already_broken"
        updated["broken_at"] = broken
    return updated


def _same_unterminated_range_episode(
    registered: dict[str, Any], fresh: dict[str, Any]
) -> bool:
    """Recognize a shifted detector window without changing the stable ID."""
    if registered.get("valid") is not True:
        return False
    if registered.get("kind") != fresh.get("kind") or registered.get(
        "active_edge"
    ) != fresh.get("active_edge"):
        return False
    if registered.get("kind") == "two_sided_range":
        return bool(
            set(registered.get("upper_touch_indices", []))
            & set(fresh.get("upper_touch_indices", []))
        ) and bool(
            set(registered.get("lower_touch_indices", []))
            & set(fresh.get("lower_touch_indices", []))
        )
    edge = str(registered.get("active_edge"))
    return len(
        set(registered.get(f"{edge}_touch_indices", []))
        & set(fresh.get(f"{edge}_touch_indices", []))
    ) >= 2


def reconcile_range_lifecycle_registry(
    bars: list[dict[str, Any]], idx: int, state: dict[str, Any]
) -> dict[str, Any] | None:
    """Persist every proven active range until its only legal termination."""
    global ACTIVE_RANGE_LIFECYCLE_BARS_ID, ACTIVE_RANGE_LIFECYCLE_CONSISTENCY
    if RULE_SET_KEY != CUSTOM_V2_RULE_SET_KEY or idx < 0 or idx >= len(bars):
        ACTIVE_RANGE_LIFECYCLE_CONSISTENCY = None
        ACTIVE_RANGE_LIFECYCLE_BARS_ID = None
        return None
    stored = state.get("range_lifecycles")
    registry = {
        str(key): dict(value)
        for key, value in stored.items()
        if isinstance(stored, dict)
        and isinstance(key, str)
        and isinstance(value, dict)
    } if isinstance(stored, dict) else {}
    fresh = fresh_custom_range_consistency(bars, idx)
    fresh_rows = _range_proof_rows(fresh)
    fresh_ids: list[str] = []
    for row in fresh_rows:
        lifecycle_id = str(row["range_lifecycle_id"])
        canonical_id = lifecycle_id
        if lifecycle_id not in registry:
            continuation = next(
                (
                    (registered_id, registered)
                    for registered_id, registered in registry.items()
                    if _same_unterminated_range_episode(registered, row)
                ),
                None,
            )
            if continuation is None:
                # First proof fixes geometry and formation evidence permanently.
                registry[lifecycle_id] = row
            else:
                canonical_id = continuation[0]
                aliases = set(continuation[1].get("range_lifecycle_alias_ids", []))
                aliases.add(lifecycle_id)
                continuation[1]["range_lifecycle_alias_ids"] = sorted(aliases)
        fresh_ids.append(canonical_id)
    registry = {
        lifecycle_id: _update_registered_range_lifecycle(proof, bars, idx)
        for lifecycle_id, proof in registry.items()
    }
    current_time = int(bars[idx]["time"])
    def rank(item: tuple[str, dict[str, Any]]) -> tuple[int, int, int, str]:
        lifecycle_id, proof = item
        broken_now = int(
            proof.get("reason") == "proven_range_already_broken"
            and isinstance(proof.get("broken_at"), dict)
            and proof["broken_at"].get("time") == current_time
        )
        active = int(proof.get("valid") is True)
        fresh_now = int(lifecycle_id in fresh_ids)
        return broken_now, active, fresh_now, lifecycle_id
    ordered = sorted(registry.items(), key=rank, reverse=True)
    if not ordered:
        ACTIVE_RANGE_LIFECYCLE_CONSISTENCY = fresh
        ACTIVE_RANGE_LIFECYCLE_BARS_ID = id(bars)
        state["range_lifecycles"] = {}
        return fresh
    primary_id, primary = ordered[0]
    public_primary = dict(primary)
    public_primary["recognized_structures"] = [
        dict(proof) for _, proof in sorted(registry.items())
    ]
    status = (
        "active"
        if any(proof.get("valid") is True for proof in registry.values())
        else "broken"
    )
    consistency = {
        "through_idx": idx,
        "through_bar_time": current_time,
        "closed_bar_count": idx + 1,
        "no_future_bars": True,
        "proof_status": status,
        "primary_range_lifecycle_id": primary_id,
        "proof": public_primary,
    }
    state["range_lifecycles"] = registry
    ACTIVE_RANGE_LIFECYCLE_CONSISTENCY = consistency
    ACTIVE_RANGE_LIFECYCLE_BARS_ID = id(bars)
    return consistency


def custom_range_consistency(bars: list[dict[str, Any]], idx: int) -> dict[str, Any] | None:
    """Return the persisted active registry in CLI mode, otherwise a pure proof."""
    if (
        RULE_SET_KEY == CUSTOM_V2_RULE_SET_KEY
        and ACTIVE_RANGE_LIFECYCLE_CONSISTENCY is not None
        and ACTIVE_RANGE_LIFECYCLE_BARS_ID == id(bars)
    ):
        if ACTIVE_RANGE_LIFECYCLE_CONSISTENCY.get("through_idx") == idx:
            return ACTIVE_RANGE_LIFECYCLE_CONSISTENCY
    return fresh_custom_range_consistency(bars, idx)


def strict_narrow_channel_consistency(bars: list[dict[str, Any]], idx: int) -> dict[str, Any] | None:
    if RULE_SET_KEY not in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS or idx < 0:
        return None
    try:
        from strict_narrow_channel import config_from_env, scan_strict_narrow_channels
    except ModuleNotFoundError:
        from .strict_narrow_channel import config_from_env, scan_strict_narrow_channels

    selected_config = config_from_env()
    if RULE_SET_KEY == CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY:
        selected_config = replace(
            selected_config,
            enforce_directional_ema20_close_streak=False,
        )
    scan = scan_strict_narrow_channels(bars, through_idx=idx, config=selected_config)
    recent_completed = [
        event
        for event in scan["completed_events"]
        if isinstance(event.get("ended_idx"), int) and int(event["ended_idx"]) >= idx - 24
    ]
    return {
        "through_idx": idx,
        "through_bar_time": scan["through_bar_time"],
        "no_future_data": True,
        "configuration": scan["configuration"],
        "active_events": scan["active_events"],
        "recent_completed_events": recent_completed,
        "candidates": scan["candidates"],
        "first_detected_on_through_idx": scan["first_detected_on_through_idx"],
        "ended_on_through_idx": scan["ended_on_through_idx"],
    }


def structure_hints(bars: list[dict[str, Any]], idx: int) -> dict[str, Any]:
    """Closed-bar structure context computed only from bars <= idx.

    Most flags only help decide when a PNG is useful.  Range consistency and
    the active V2 strict-channel consistency are deterministic causal proofs;
    the gate consumes them for the relevant setup and persists them in the
    hash-chained decision record.
    """
    if idx <= 0:
        result: dict[str, Any] = {"suggest_snapshot": False, "flags": []}
        consistency = custom_range_consistency(bars, idx)
        if consistency is not None:
            result["range_consistency"] = consistency
        historical = historical_support_resistance(bars, idx)
        if historical is not None:
            result["historical_support_resistance"] = historical
        effective_swings = effective_swing_support_resistance(bars, idx)
        if effective_swings is not None:
            result["effective_swing_support_resistance"] = effective_swings
        narrow = strict_narrow_channel_consistency(bars, idx)
        if narrow is not None:
            result["strict_narrow_channel_consistency"] = narrow
        return result
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
    if idx >= 1 and "ema50" in cur:
        prev_spread = float(bars[idx - 1]["ema20"]) - float(bars[idx - 1]["ema50"])
        cur_spread = float(cur["ema20"]) - float(cur["ema50"])
        if prev_spread <= 0 < cur_spread:
            flags.append("ema20_cross_above")
        elif prev_spread >= 0 > cur_spread:
            flags.append("ema20_cross_below")
    elif idx >= 1:
        prev_spread = float(bars[idx - 1]["close"]) - float(bars[idx - 1]["ema20"])
        cur_spread = float(cur["close"]) - float(cur["ema20"])
        if prev_spread <= 0 < cur_spread:
            flags.append("price_cross_above_ema20")
        elif prev_spread >= 0 > cur_spread:
            flags.append("price_cross_below_ema20")
    if atr > 0 and abs(float(cur["close"]) - float(cur["ema20"])) > 1.2 * atr:
        flags.append("ema_deviation")
    result = {"suggest_snapshot": bool(flags), "flags": flags}
    consistency = custom_range_consistency(bars, idx)
    if consistency is not None:
        result["range_consistency"] = consistency
        if consistency.get("proof_status") == "active":
            result["suggest_snapshot"] = True
            if "active_range_consistency_review" not in flags:
                flags.append("active_range_consistency_review")
    historical = historical_support_resistance(bars, idx)
    if historical is not None:
        result["historical_support_resistance"] = historical
        support_touch = any(
            float(cur["low"]) <= float(row["body_low"])
            and float(cur["high"]) >= float(row["low"])
            for row in historical["supports"]
        )
        resistance_touch = any(
            float(cur["high"]) >= float(row["body_high"])
            and float(cur["low"]) <= float(row["high"])
            for row in historical["resistances"]
        )
        if support_touch or resistance_touch:
            result["suggest_snapshot"] = True
            if "old_support_resistance_interaction" not in flags:
                flags.append("old_support_resistance_interaction")
    effective_swings = effective_swing_support_resistance(bars, idx)
    if effective_swings is not None:
        result["effective_swing_support_resistance"] = effective_swings
        support = effective_swings.get("effective_support")
        resistance = effective_swings.get("effective_resistance")
        support_touch = isinstance(support, dict) and float(cur["low"]) <= float(support["price"]) <= float(cur["high"])
        resistance_touch = isinstance(resistance, dict) and float(cur["low"]) <= float(resistance["price"]) <= float(cur["high"])
        if support_touch or resistance_touch:
            result["suggest_snapshot"] = True
            if "effective_swing_interaction" not in flags:
                flags.append("effective_swing_interaction")
    narrow = strict_narrow_channel_consistency(bars, idx)
    if narrow is not None:
        result["strict_narrow_channel_consistency"] = narrow
        if narrow["first_detected_on_through_idx"] or narrow["ended_on_through_idx"]:
            result["suggest_snapshot"] = True
            if "strict_narrow_channel_state_change" not in flags:
                flags.append("strict_narrow_channel_state_change")
    return result


def validate_state_rule_set(state: dict[str, Any]) -> None:
    if state.get("rule_set_id") != RULE_SET_ID or state.get("rule_set_sha256") != RULE_SET_SHA256:
        raise SystemExit("causal gate rule-set identity differs from the initialized ledger")


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
    public_bar = {
        "open_time": int(bar["time"]),
        "beijing_open_time": bar["beijing_open_time"],
        "beijing_close_time": datetime.fromtimestamp(int(bar["close_time"]), BEIJING).strftime("%Y-%m-%d %H:%M"),
        "open": float(bar["open"]),
        "high": float(bar["high"]),
        "low": float(bar["low"]),
        "close": float(bar["close"]),
        "volume": int(bar.get("volume") or 0),
        "ema20": round(float(bar["ema20"]), 6),
        "atr14": round(float(bar["atr14"]), 6),
        "gap_from_previous_minutes": gap_minutes,
    }
    if "ema50" in bar:
        public_bar["ema50"] = round(float(bar["ema50"]), 6)
    return {
        "done": False,
        "idx": idx,
        "remaining_including_current": len(bars) - idx,
        "bar": public_bar,
        "confirmed_pivots": confirmed_pivots(bars, idx),
        "structure_hint": structure_hints(bars, idx),
        "chain_sha256_before_decision": chain,
        "rule_set_id": RULE_SET_ID,
        "rule_set_sha256": RULE_SET_SHA256,
        "causal_rule": "commit idx before gate releases idx+1; evidence/max_used_idx must be <= idx",
    }


def cmd_init(args: argparse.Namespace) -> int:
    payload, raw_bars = load_data(args.data)
    bars = enrich(raw_bars, int(payload["timeframe_minutes"]))
    if START_IDX < 0 or START_IDX >= len(bars):
        raise SystemExit(f"CAUSAL_START_IDX must be in [0, {len(bars) - 1}], got {START_IDX}")
    args.out.mkdir(parents=True, exist_ok=True)
    state = {
        "next_idx": START_IDX,
        "chain_sha256": "0" * 64,
        "data_sha256": EXPECTED_SHA256,
        "rule_set_id": RULE_SET_ID,
        "rule_set_sha256": RULE_SET_SHA256,
        "range_lifecycles": {},
    }
    reconcile_range_lifecycle_registry(bars, START_IDX, state)
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
        "rule_set_key": RULE_SET_KEY,
        "rule_set_id": RULE_SET_ID,
        "rule_set_sha256": RULE_SET_SHA256,
        "anti_lookahead": "one-way gate; the next bar is returned only after current decision is hash-chained",
    }
    write_json(args.out / "manifest.json", manifest)
    print(json.dumps(current_payload(bars, START_IDX, state["chain_sha256"]), ensure_ascii=False))
    return 0


def parse_evidence(text: str) -> list[int]:
    if not text.strip():
        return []
    values = [int(part) for part in text.split(",")]
    if len(values) != len(set(values)):
        raise SystemExit("duplicate evidence index")
    return values


def numeric(context: dict[str, Any], key: str) -> float:
    value = context.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise SystemExit(f"signal_context.{key} must be a finite number")
    return float(value)


def integer(context: dict[str, Any], key: str, *, maximum: int) -> int:
    value = context.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > maximum:
        raise SystemExit(f"signal_context.{key} must be an integer in [0, {maximum}]")
    return value


def price_equal(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-9)


def parse_signal_context(raw: str) -> dict[str, Any] | None:
    if not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"signal_context is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit("signal_context must be a JSON object")
    return value


def parse_case_context(raw: str) -> dict[str, Any] | None:
    if not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"case_context is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit("case_context must be a JSON object")
    return value


def validate_louie_case_context(
    idx: int,
    context: dict[str, Any] | None,
    evidence: list[int],
    *,
    require_supplemental: bool = False,
    require_brooks_full_corpus: bool = False,
) -> dict[str, Any]:
    if not isinstance(context, dict):
        raise SystemExit("Louie case-enhanced decision requires case_context")
    text_fields = {
        "market_state",
        "background",
        "location",
        "acceptance_follow_through",
        "trigger",
        "success_failure_boundary",
    }
    required = {*text_fields, "case_families", "evidence_indices"}
    if require_supplemental:
        required.update({"supplemental_case_lenses", "v4_execution_unchanged"})
    if require_brooks_full_corpus:
        required.update(
            {
                "brooks_case_lenses",
                "brooks_source_families",
                "v5_0818_execution_unchanged",
            }
        )
    missing = sorted(required - set(context))
    extra = sorted(set(context) - required)
    if missing:
        raise SystemExit(f"Louie case_context is missing required fields: {missing}")
    if extra:
        raise SystemExit(f"Louie case_context has unsupported fields: {extra}")
    normalized = dict(context)
    for key in text_fields:
        value = context.get(key)
        if not isinstance(value, str) or not value.strip():
            raise SystemExit(f"Louie case_context.{key} must be a non-blank string")
        normalized[key] = value.strip()
    families = context.get("case_families")
    if (
        not isinstance(families, list)
        or not families
        or any(not isinstance(value, str) or value not in LOUIE_CASE_FAMILIES for value in families)
        or len(families) != len(set(families))
    ):
        raise SystemExit("Louie case_context.case_families must be a unique non-empty list of allowed families")
    if "no_specific_case" in families and len(families) != 1:
        raise SystemExit("Louie case_context.no_specific_case cannot be mixed with another case family")
    indices = context.get("evidence_indices")
    if (
        not isinstance(indices, list)
        or not indices
        or idx not in indices
        or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > idx
            for value in indices
        )
        or len(indices) != len(set(indices))
    ):
        raise SystemExit(
            "Louie case_context.evidence_indices must be unique causal indices containing current idx"
        )
    if not set(indices).issubset(set(evidence)):
        raise SystemExit("Louie evidence_indices must include every case_context evidence index")
    normalized["case_families"] = list(families)
    normalized["evidence_indices"] = list(indices)
    if require_supplemental:
        lenses = context.get("supplemental_case_lenses")
        if (
            not isinstance(lenses, list)
            or not lenses
            or any(
                not isinstance(value, str) or value not in LOUIE_SUPPLEMENTAL_CASE_LENSES
                for value in lenses
            )
            or len(lenses) != len(set(lenses))
        ):
            raise SystemExit(
                "Louie V5 case_context.supplemental_case_lenses must be a unique "
                "non-empty list of allowed lenses"
            )
        if "no_additional_case" in lenses and len(lenses) != 1:
            raise SystemExit(
                "Louie V5 case_context.no_additional_case cannot be mixed with another lens"
            )
        if context.get("v4_execution_unchanged") is not True:
            raise SystemExit("Louie V5 requires case_context.v4_execution_unchanged=true")
        normalized["supplemental_case_lenses"] = list(lenses)
        normalized["v4_execution_unchanged"] = True
    if require_brooks_full_corpus:
        brooks_lenses = context.get("brooks_case_lenses")
        if (
            not isinstance(brooks_lenses, list)
            or not brooks_lenses
            or any(
                not isinstance(value, str) or value not in LOUIE_BROOKS_CASE_LENSES
                for value in brooks_lenses
            )
            or len(brooks_lenses) != len(set(brooks_lenses))
        ):
            raise SystemExit(
                "Louie V6 case_context.brooks_case_lenses must be a unique "
                "non-empty list of allowed lenses"
            )
        source_families = context.get("brooks_source_families")
        if (
            not isinstance(source_families, list)
            or not source_families
            or any(
                not isinstance(value, str) or value not in LOUIE_BROOKS_SOURCE_FAMILIES
                for value in source_families
            )
            or len(source_families) != len(set(source_families))
        ):
            raise SystemExit(
                "Louie V6 case_context.brooks_source_families must be a unique "
                "non-empty list of allowed source families"
            )
        no_matching_case = "no_matching_brooks_case" in brooks_lenses
        no_specific_source = "no_specific_brooks_source" in source_families
        if no_matching_case:
            if len(brooks_lenses) != 1 or source_families != ["no_specific_brooks_source"]:
                raise SystemExit(
                    "Louie V6 no_matching_brooks_case requires the exclusive "
                    "no_specific_brooks_source family"
                )
        elif no_specific_source:
            raise SystemExit(
                "Louie V6 no_specific_brooks_source is only valid with "
                "no_matching_brooks_case"
            )
        if context.get("v5_0818_execution_unchanged") is not True:
            raise SystemExit(
                "Louie V6 requires case_context.v5_0818_execution_unchanged=true"
            )
        normalized["brooks_case_lenses"] = list(brooks_lenses)
        normalized["brooks_source_families"] = list(source_families)
        normalized["v5_0818_execution_unchanged"] = True
    return normalized


def range_numeric(value: dict[str, Any], key: str) -> float:
    candidate = value.get(key)
    if isinstance(candidate, bool) or not isinstance(candidate, (int, float)) or not math.isfinite(float(candidate)):
        raise SystemExit(f"signal_context.range.{key} must be a finite number")
    return float(candidate)


def range_integer(value: dict[str, Any], key: str, *, maximum: int) -> int:
    candidate = value.get(key)
    if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 0 or candidate > maximum:
        raise SystemExit(f"signal_context.range.{key} must be an integer in [0, {maximum}]")
    return candidate


def range_touch_indices(
    value: dict[str, Any], key: str, *, minimum: int, maximum: int
) -> list[int]:
    indices = value.get(key)
    if (
        not isinstance(indices, list)
        or len(indices) < minimum
        or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 or item > maximum for item in indices)
        or indices != sorted(set(indices))
    ):
        raise SystemExit(
            f"signal_context.range.{key} must contain at least {minimum} unique causal indices in order"
        )
    minimum_independent_gap = (
        6 if RULE_SET_KEY in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS else 4
    )
    if any(
        indices[position] - indices[position - 1] < minimum_independent_gap
        for position in range(1, len(indices))
    ):
        raise SystemExit(
            f"signal_context.range.{key} contains touches within five bars that belong to one cluster"
        )
    return indices


def range_wick_touches_zone(
    bar: dict[str, Any], *, active_edge: str, zone_low: float, zone_high: float
) -> bool:
    """Require the direction-relevant wick, rather than the body, to touch an edge band."""
    open_price = float(bar["open"])
    close_price = float(bar["close"])
    high = float(bar["high"])
    low = float(bar["low"])
    body_low = min(open_price, close_price)
    body_high = max(open_price, close_price)
    if active_edge == "upper":
        return high > body_high and high >= zone_low and body_high <= zone_low
    if active_edge == "lower":
        return low < body_low and low <= zone_high and body_low >= zone_high
    raise SystemExit("range active_edge must be upper or lower")


def validate_range_geometry(
    bars: list[dict[str, Any]],
    idx: int,
    context: dict[str, Any],
    structure_indices: list[int],
) -> dict[str, Any]:
    value = context.get("range")
    if not isinstance(value, dict):
        raise SystemExit("signal_context.range must be an object")
    if RULE_SET_KEY not in CUSTOM_V2_RANGE30_RULE_SET_KEYS:
        geometry = {
            key: range_numeric(value, key)
            for key in (
                "upper_zone_low",
                "upper_zone_high",
                "lower_zone_low",
                "lower_zone_high",
                "midpoint",
            )
        }
        geometry["kind"] = "two_sided_range"
        return validate_two_sided_price_order(geometry)

    kind = value.get("kind")
    if kind not in {"two_sided_range", "one_sided_edge"}:
        raise SystemExit("signal_context.range.kind must be two_sided_range or one_sided_edge")
    start_idx = range_integer(value, "start_idx", maximum=idx)
    end_idx = range_integer(value, "end_idx", maximum=idx)
    if end_idx < start_idx or end_idx - start_idx + 1 < 30:
        raise SystemExit("custom V2 range must span at least 30 closed bars inclusive")
    geometry: dict[str, Any] = {"kind": kind, "start_idx": start_idx, "end_idx": end_idx}
    if RULE_SET_KEY == CUSTOM_V2_RULE_SET_KEY:
        lifecycle_id = value.get("range_lifecycle_id")
        if not isinstance(lifecycle_id, str) or not lifecycle_id.startswith(
            "range-lifecycle-"
        ):
            raise SystemExit(
                "active Custom V2 range signal must record range.range_lifecycle_id"
            )
        geometry["range_lifecycle_id"] = lifecycle_id
    required_indices = {start_idx, end_idx}

    if kind == "two_sided_range":
        geometry.update(
            {
                key: range_numeric(value, key)
                for key in (
                    "upper_zone_low",
                    "upper_zone_high",
                    "lower_zone_low",
                    "lower_zone_high",
                    "midpoint",
                )
            }
        )
        upper_touches = range_touch_indices(value, "upper_touch_indices", minimum=2, maximum=idx)
        lower_touches = range_touch_indices(value, "lower_touch_indices", minimum=2, maximum=idx)
        if any(touch < start_idx or touch > end_idx for touch in [*upper_touches, *lower_touches]):
            raise SystemExit("two-sided range touches must lie inside the recorded range span")
        strict_wick_contacts = RULE_SET_KEY in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS
        invalid_upper_touch = any(
            (
                not range_wick_touches_zone(
                    bars[touch],
                    active_edge="upper",
                    zone_low=geometry["upper_zone_low"],
                    zone_high=geometry["upper_zone_high"],
                )
                if strict_wick_contacts
                else not geometry["upper_zone_low"]
                <= float(bars[touch]["high"])
                <= geometry["upper_zone_high"]
            )
            for touch in upper_touches
        )
        if invalid_upper_touch:
            raise SystemExit(
                "two-sided upper touch must be a direction-relevant wick contact; body-only occupancy does not count"
            )
        invalid_lower_touch = any(
            (
                not range_wick_touches_zone(
                    bars[touch],
                    active_edge="lower",
                    zone_low=geometry["lower_zone_low"],
                    zone_high=geometry["lower_zone_high"],
                )
                if strict_wick_contacts
                else not geometry["lower_zone_low"]
                <= float(bars[touch]["low"])
                <= geometry["lower_zone_high"]
            )
            for touch in lower_touches
        )
        if invalid_lower_touch:
            raise SystemExit(
                "two-sided lower touch must be a direction-relevant wick contact; body-only occupancy does not count"
            )
        geometry["upper_touch_indices"] = upper_touches
        geometry["lower_touch_indices"] = lower_touches
        required_indices.update(upper_touches)
        required_indices.update(lower_touches)
        validate_two_sided_price_order(geometry)
    else:
        active_edge = value.get("active_edge")
        if active_edge not in {"upper", "lower"}:
            raise SystemExit("one-sided range active_edge must be upper or lower")
        zone_low = range_numeric(value, f"{active_edge}_zone_low")
        zone_high = range_numeric(value, f"{active_edge}_zone_high")
        if zone_low > zone_high:
            raise SystemExit("one-sided edge zone is inverted")
        touches = range_touch_indices(value, f"{active_edge}_touch_indices", minimum=3, maximum=idx)
        if touches[0] < start_idx or touches[-1] > end_idx or touches[-1] - touches[0] + 1 < 30:
            raise SystemExit("one-sided edge first/last independent touches must span at least 30 bars")
        if active_edge == "upper":
            invalid_touch = any(
                (
                    not range_wick_touches_zone(
                        bars[touch], active_edge="upper", zone_low=zone_low, zone_high=zone_high
                    )
                    if RULE_SET_KEY in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS
                    else not zone_low <= float(bars[touch]["high"]) <= zone_high
                )
                for touch in touches
            )
            if invalid_touch:
                raise SystemExit(
                    "one-sided upper touch must be a direction-relevant wick contact; body-only occupancy does not count"
                )
            body_outside = any(
                max(float(bar["open"]), float(bar["close"])) > zone_high
                for bar in bars[touches[0] : touches[-1] + 1]
            )
        else:
            invalid_touch = any(
                (
                    not range_wick_touches_zone(
                        bars[touch], active_edge="lower", zone_low=zone_low, zone_high=zone_high
                    )
                    if RULE_SET_KEY in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS
                    else not zone_low <= float(bars[touch]["low"]) <= zone_high
                )
                for touch in touches
            )
            if invalid_touch:
                raise SystemExit(
                    "one-sided lower touch must be a direction-relevant wick contact; body-only occupancy does not count"
                )
            body_outside = any(
                min(float(bar["open"]), float(bar["close"])) < zone_low
                for bar in bars[touches[0] : touches[-1] + 1]
            )
        if body_outside:
            raise SystemExit("one-sided edge formation contains body acceptance outside the edge zone")
        geometry.update(
            {
                "active_edge": active_edge,
                f"{active_edge}_zone_low": zone_low,
                f"{active_edge}_zone_high": zone_high,
                f"{active_edge}_touch_indices": touches,
            }
        )
        required_indices.update(touches)
        if any(key in value for key in ({"upper_zone_low", "upper_zone_high"} if active_edge == "lower" else {"lower_zone_low", "lower_zone_high"})):
            raise SystemExit("one-sided edge must not invent the missing opposite edge")
        if "midpoint" in value:
            raise SystemExit("one-sided edge must not invent a range midpoint")

    if not required_indices.issubset(set(structure_indices)):
        raise SystemExit("range start/end/touch indices must be included in signal_context.structure_indices")
    return geometry


def actual_range_lifecycle_by_id(
    bars: list[dict[str, Any]], idx: int, lifecycle_id: str
) -> dict[str, Any]:
    """Resolve one exact causal range lifecycle from the current-bar proof."""
    consistency = custom_range_consistency(bars, idx)
    proof = consistency.get("proof") if isinstance(consistency, dict) else None
    if not isinstance(proof, dict):
        raise SystemExit("active Custom V2 signal has no causal range proof")
    candidates = [proof]
    recognized = proof.get("recognized_structures")
    if isinstance(recognized, list):
        candidates.extend(item for item in recognized if isinstance(item, dict))
    matches = [
        item for item in candidates if item.get("range_lifecycle_id") == lifecycle_id
    ]
    if not matches:
        raise SystemExit(
            "range.range_lifecycle_id must resolve to an actual causal lifecycle"
        )
    first = matches[0]
    if any(item != first for item in matches[1:]):
        raise SystemExit(
            "range.range_lifecycle_id resolves to conflicting causal lifecycle records"
        )
    return first


def validate_actual_range_lifecycle_binding(
    bars: list[dict[str, Any]],
    idx: int,
    geometry: dict[str, Any],
    *,
    expected_family: str,
) -> None:
    """Bind a range signal to the exact causal lifecycle proven at this bar."""
    if RULE_SET_KEY != CUSTOM_V2_RULE_SET_KEY:
        return
    actual = actual_range_lifecycle_by_id(
        bars, idx, str(geometry["range_lifecycle_id"])
    )
    if expected_family == "range_reversal" and actual.get("valid") is not True:
        raise SystemExit("range reversal must bind an active, not terminated, lifecycle")
    if expected_family == "range_true_breakout" and not (
        actual.get("reason") == "proven_range_already_broken"
        and isinstance(actual.get("broken_at"), dict)
        and actual["broken_at"].get("time")
        == int(bars[idx].get("time", bars[idx]["close_time"]))
        and actual["broken_at"].get("confirmation_closes") == 5
    ):
        raise SystemExit(
            "range breakout must bind the lifecycle terminated by the current fifth outside close"
        )

    exact_keys = ["kind", "start_idx", "end_idx"]
    if geometry["kind"] == "two_sided_range":
        exact_keys.extend(
            [
                "upper_zone_low",
                "upper_zone_high",
                "lower_zone_low",
                "lower_zone_high",
                "midpoint",
                "upper_touch_indices",
                "lower_touch_indices",
            ]
        )
    else:
        edge = geometry["active_edge"]
        exact_keys.extend(
            [
                "active_edge",
                f"{edge}_zone_low",
                f"{edge}_zone_high",
                f"{edge}_touch_indices",
            ]
        )
    for key in exact_keys:
        submitted = geometry.get(key)
        proven = actual.get(key)
        if isinstance(submitted, float) or isinstance(proven, float):
            if not isinstance(submitted, (int, float)) or not isinstance(
                proven, (int, float)
            ) or not price_equal(float(submitted), float(proven)):
                raise SystemExit(
                    f"range lifecycle binding mismatch for {key}: submitted={submitted}, proven={proven}"
                )
        elif submitted != proven:
            raise SystemExit(
                f"range lifecycle binding mismatch for {key}: submitted={submitted}, proven={proven}"
            )


def validate_prior_edge_lifecycle_binding(
    bars: list[dict[str, Any]],
    idx: int,
    prior_zone: dict[str, Any],
    *,
    zone_low: float,
    zone_high: float,
) -> None:
    """Prevent a pullback anchor from inventing or borrowing another range edge."""
    if RULE_SET_KEY != CUSTOM_V2_RULE_SET_KEY:
        return
    lifecycle_id = prior_zone.get("range_lifecycle_id")
    if not isinstance(lifecycle_id, str) or not lifecycle_id.startswith(
        "range-lifecycle-"
    ):
        raise SystemExit(
            "prior_breakout_edge_zone must record its actual range_lifecycle_id"
        )
    actual = actual_range_lifecycle_by_id(bars, idx, lifecycle_id)
    edge = prior_zone.get("edge")
    if edge not in {"upper", "lower"}:
        raise SystemExit("prior breakout edge zone edge must be upper or lower")
    if actual.get("kind") == "one_sided_edge" and actual.get("active_edge") != edge:
        raise SystemExit("prior breakout edge belongs to a different range lifecycle edge")
    actual_low = actual.get(f"{edge}_zone_low")
    actual_high = actual.get(f"{edge}_zone_high")
    if not isinstance(actual_low, (int, float)) or not isinstance(
        actual_high, (int, float)
    ):
        raise SystemExit("prior breakout edge is absent from the bound range lifecycle")
    if not price_equal(zone_low, float(actual_low)) or not price_equal(
        zone_high, float(actual_high)
    ):
        raise SystemExit(
            "prior breakout edge prices do not match the bound range lifecycle"
        )


def validate_two_sided_price_order(geometry: dict[str, Any]) -> dict[str, Any]:
    if geometry["upper_zone_low"] > geometry["upper_zone_high"]:
        raise SystemExit("upper edge zone is inverted")
    if geometry["lower_zone_low"] > geometry["lower_zone_high"]:
        raise SystemExit("lower edge zone is inverted")
    if geometry["lower_zone_high"] >= geometry["upper_zone_low"]:
        raise SystemExit("range edge zones overlap or are inverted")
    if not geometry["lower_zone_high"] < geometry["midpoint"] < geometry["upper_zone_low"]:
        raise SystemExit("range midpoint must lie strictly between the two edge zones")
    return geometry


def recent_edge_touch_indices(
    bars: list[dict[str, Any]],
    idx: int,
    *,
    active_edge: str,
    zone_low: float,
    zone_high: float,
    lookback_bars: int = 5,
) -> list[int]:
    """Return completed pre-signal bars whose full range touched the active edge.

    Five bars is the existing Custom V2 contact-cluster boundary.  A touch in
    this window makes a new edge-rejection bar part of the same recent
    touch/shallow-retest episode instead of a fresh range reversal.
    """
    if active_edge not in {"upper", "lower"}:
        raise SystemExit("range reversal active edge must be upper or lower")
    start = max(0, idx - lookback_bars)
    return [
        bar_idx
        for bar_idx in range(start, idx)
        if float(bars[bar_idx]["low"]) <= zone_high
        and float(bars[bar_idx]["high"]) >= zone_low
    ]


def validate_custom_v2_signal_context(
    bars: list[dict[str, Any]],
    idx: int,
    *,
    setup: str,
    direction: str,
    context: dict[str, Any] | None,
) -> dict[str, Any]:
    setup_families = (
        CUSTOM_V2_ACTIVE_SETUPS
        if RULE_SET_KEY in CUSTOM_V2_ANY_PULLBACK_RULE_SET_KEYS
        else CUSTOM_V2_LEGACY_SETUPS
    )
    if setup not in setup_families:
        allowed = "、".join(setup_families)
        raise SystemExit(f"custom V2 SIGNAL setup must be one of: {allowed}")
    if not isinstance(context, dict):
        raise SystemExit("custom V2 SIGNAL requires signal_context")
    expected_family = setup_families[setup]
    expected_rule_version = CUSTOM_V2_RULE_VERSIONS_BY_KEY.get(RULE_SET_KEY)
    if context.get("rule_version") != expected_rule_version or context.get("family") != expected_family:
        raise SystemExit(
            "signal_context rule_version/family must be "
            f"rule_version={expected_rule_version}, family={expected_family} for setup={setup}"
        )
    if context.get("signal_bar_idx") != idx:
        raise SystemExit("signal_context.signal_bar_idx must equal current idx")
    structure_indices = context.get("structure_indices")
    if (
        not isinstance(structure_indices, list)
        or not structure_indices
        or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > idx for value in structure_indices)
        or idx not in structure_indices
    ):
        raise SystemExit("signal_context.structure_indices must contain current idx and no future index")

    current = bars[idx]
    entry = numeric(context, "entry_trigger_price")
    stop = numeric(context, "initial_stop_price")
    stop_reference_idx = integer(context, "initial_stop_reference_idx", maximum=idx)
    if stop_reference_idx not in structure_indices:
        raise SystemExit("initial_stop_reference_idx must be included in structure_indices")
    expected_stop_extreme = float(
        bars[stop_reference_idx]["low" if direction == "long" else "high"]
    )
    if not price_equal(stop, expected_stop_extreme):
        raise SystemExit("initial_stop_price must match the recorded reference-bar extreme")
    if direction == "long" and not stop < entry:
        raise SystemExit("long custom V2 stop must be below entry")
    if direction == "short" and not stop > entry:
        raise SystemExit("short custom V2 stop must be above entry")

    if expected_family in {"range_true_breakout", "range_reversal"}:
        geometry = validate_range_geometry(bars, idx, context, structure_indices)
        validate_actual_range_lifecycle_binding(
            bars, idx, geometry, expected_family=expected_family
        )
    else:
        geometry = {}

    if expected_family == "range_true_breakout":
        expected_variant = (
            "fifth_consecutive_close_outside_edge"
            if RULE_SET_KEY in CUSTOM_V2_FIVE_CLOSE_RULE_SET_KEYS
            else "initial_close_outside_edge"
        )
        if context.get("variant") != expected_variant:
            raise SystemExit(f"range true breakout variant must be {expected_variant}")
        expected_entry = float(current["high"] if direction == "long" else current["low"])
        expected_stop = float(current["low"] if direction == "long" else current["high"])
        if not price_equal(entry, expected_entry) or not price_equal(stop, expected_stop):
            raise SystemExit("range true breakout entry/stop must use the signal-bar extreme")
        active_edge = geometry.get("active_edge", "upper" if direction == "long" else "lower")
        expected_edge = "upper" if direction == "long" else "lower"
        if active_edge != expected_edge:
            raise SystemExit("range true breakout direction does not match the active range edge")
        if direction == "long" and not float(current["close"]) > geometry["upper_zone_high"]:
            raise SystemExit("long range true breakout must close above the upper edge zone")
        if direction == "short" and not float(current["close"]) < geometry["lower_zone_low"]:
            raise SystemExit("short range true breakout must close below the lower edge zone")
        if RULE_SET_KEY in CUSTOM_V2_FIVE_CLOSE_RULE_SET_KEYS:
            boundary = (
                float(geometry["upper_zone_high"])
                if direction == "long"
                else float(geometry["lower_zone_low"])
            )
            if idx < 4:
                raise SystemExit("range true breakout requires five completed outside closes")
            closes = [float(bar["close"]) for bar in bars[idx - 4 : idx + 1]]
            confirmed = (
                all(close > boundary for close in closes)
                if direction == "long"
                else all(close < boundary for close in closes)
            )
            if not confirmed:
                raise SystemExit("range true breakout requires five consecutive closes beyond the outer edge")
            if context.get("break_confirmation_closes") != 5:
                raise SystemExit("range true breakout must record break_confirmation_closes=5")
            confirmation_indices = context.get("break_confirmation_indices")
            expected_confirmation_indices = list(range(idx - 4, idx + 1))
            if confirmation_indices != expected_confirmation_indices:
                raise SystemExit(
                    "range true breakout must record the exact five consecutive break_confirmation_indices"
                )
            if any(index not in structure_indices for index in confirmation_indices):
                raise SystemExit(
                    "break_confirmation_indices must all be included in structure_indices"
                )

    elif expected_family == "range_reversal":
        variant = context.get("variant")
        if variant not in {"failed_breakout_reentry", "edge_rejection"}:
            raise SystemExit(
                "range reversal variant is invalid; must be one of: "
                "failed_breakout_reentry, edge_rejection"
            )
        expected_entry = float(current["low"] if direction == "short" else current["high"])
        if not price_equal(entry, expected_entry):
            raise SystemExit("range reversal entry must use the signal-bar breakout extreme")
        active_edge = geometry.get("active_edge", "upper" if direction == "short" else "lower")
        expected_edge = "upper" if direction == "short" else "lower"
        if active_edge != expected_edge:
            raise SystemExit("range reversal direction does not match the active range edge")
        if direction == "short":
            if variant == "failed_breakout_reentry" and not float(current["close"]) < geometry["upper_zone_low"]:
                raise SystemExit("failed upside breakout reversal must close below the upper edge zone")
            if variant == "edge_rejection" and not float(current["close"]) <= geometry["upper_zone_high"]:
                raise SystemExit("upper-edge rejection may not close above the upper edge zone")
        else:
            if variant == "failed_breakout_reentry" and not float(current["close"]) > geometry["lower_zone_high"]:
                raise SystemExit("failed downside breakout reversal must close above the lower edge zone")
            if variant == "edge_rejection" and not float(current["close"]) >= geometry["lower_zone_low"]:
                raise SystemExit("lower-edge rejection may not close below the lower edge zone")
        if variant == "edge_rejection" and context.get("recent_shallow_retest_breakout_bias") is not False:
            raise SystemExit("edge rejection must explicitly rule out the recent shallow-retest breakout-bias case")
        if variant == "edge_rejection":
            zone_low = float(geometry[f"{active_edge}_zone_low"])
            zone_high = float(geometry[f"{active_edge}_zone_high"])
            recent_touches = recent_edge_touch_indices(
                bars,
                idx,
                active_edge=active_edge,
                zone_low=zone_low,
                zone_high=zone_high,
            )
            if recent_touches:
                touch_labels = [
                    str(bars[bar_idx].get("beijing_open_time", bar_idx))
                    for bar_idx in recent_touches
                ]
                raise SystemExit(
                    "edge rejection is invalid after a touch within the prior five bars; "
                    "this is the same recent shallow-retest breakout-bias episode; "
                    f"recent_touch_times={touch_labels}"
                )
        if geometry["kind"] == "two_sided_range":
            opposite_edge = numeric(context, "opposite_edge_price")
            risk = abs(entry - stop)
            midpoint_reward = entry - geometry["midpoint"] if direction == "short" else geometry["midpoint"] - entry
            opposite_reward = entry - opposite_edge if direction == "short" else opposite_edge - entry
            if not midpoint_reward > risk or not opposite_reward > 2 * risk:
                raise SystemExit("range reversal fails the strict midpoint and opposite-edge reward/risk filters")
        elif context.get("range_reversal_rr_mode") != "not_applicable_one_sided_edge":
            raise SystemExit("one-sided range reversal must mark the two-sided RR filter as not applicable")

    elif expected_family in {"narrow_channel_pullback", "narrow_channel_first_pullback"}:
        if RULE_SET_KEY in CUSTOM_V2_STRICT_ANCHOR_RULE_SET_KEYS:
            allowed_variants = {"anchor_touch_pullback"}
        elif RULE_SET_KEY in {
            CUSTOM_V2_FIVE_CLOSE_LEGACY_RULE_SET_KEY,
            CUSTOM_V2_UNANCHORED_LEGACY_RULE_SET_KEY,
        }:
            allowed_variants = {"anchor_touch_pullback", "unanchored_first_pullback"}
        else:
            allowed_variants = {"anchor_touch_pullback", "flag_or_range_pullback"}
        if context.get("variant") not in allowed_variants:
            raise SystemExit(
                "narrow-channel pullback variant is invalid; must be one of: "
                + ", ".join(sorted(allowed_variants))
            )
        if RULE_SET_KEY in CUSTOM_V2_ANY_PULLBACK_RULE_SET_KEYS:
            if context.get("first_pullback_required") is not False:
                raise SystemExit(
                    "active narrow-channel setup must record first_pullback_required=false"
                )
        elif context.get("first_pullback") is not True:
            raise SystemExit("legacy narrow-channel setup requires the first pullback")
        if (
            RULE_SET_KEY not in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS
            and (
                context.get("continuous_directional_leg") is not True
                or context.get("stepwise_advance") is not False
            )
        ):
            raise SystemExit("narrow-channel setup requires a continuous leg, not stepwise advance")
        leg_start = integer(context, "trend_leg_start_idx", maximum=idx)
        leg_end = integer(context, "trend_leg_end_idx", maximum=idx)
        pullback_start = integer(context, "pullback_start_idx", maximum=idx)
        if not leg_start < leg_end < pullback_start <= idx:
            raise SystemExit("narrow-channel leg/pullback indices are out of order")
        strict_channel_proof: dict[str, Any] | None = None
        if RULE_SET_KEY in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS:
            trend_leg_indices = context.get("trend_leg_indices")
            expected_leg_indices = list(range(leg_start, leg_end + 1))
            if trend_leg_indices != expected_leg_indices:
                raise SystemExit(
                    "strict narrow-channel trend_leg_indices must be the exact contiguous frozen leg"
                )
            if pullback_start != leg_end + 1:
                raise SystemExit(
                    "strict narrow-channel pullback must begin immediately after the directional leg"
                )
            pullback_indices = context.get("pullback_indices")
            expected_pullback_indices = list(range(pullback_start, idx + 1))
            if pullback_indices != expected_pullback_indices:
                raise SystemExit(
                    "strict narrow-channel pullback_indices must include every contiguous pullback bar"
                )
            if structure_indices != sorted(set(structure_indices)):
                raise SystemExit(
                    "strict narrow-channel structure_indices must be ordered and unique"
                )
            required_path_indices = set(expected_leg_indices + expected_pullback_indices)
            if not required_path_indices.issubset(structure_indices):
                raise SystemExit(
                    "strict narrow-channel structure_indices must include the complete leg and pullback"
                )
            try:
                from strict_narrow_channel import config_from_env, scan_strict_narrow_channels
            except ModuleNotFoundError:
                from .strict_narrow_channel import config_from_env, scan_strict_narrow_channels

            selected_config = config_from_env()
            if RULE_SET_KEY == CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_SET_KEY:
                selected_config = replace(
                    selected_config,
                    enforce_directional_ema20_close_streak=False,
                )
            strict_scan = scan_strict_narrow_channels(
                bars,
                through_idx=leg_end,
                config=selected_config,
            )
            expected_channel_direction = "up" if direction == "long" else "down"
            matching_channels = [
                event
                for event in strict_scan["active_events"]
                if event.get("direction") == expected_channel_direction
                and event.get("start_idx") == leg_start
                and event.get("last_updated_idx") == leg_end
            ]
            if len(matching_channels) != 1:
                raise SystemExit(
                    "narrow-channel directional leg is not a causally registered active strict channel "
                    "at trend_leg_end_idx"
                )
            strict_channel_proof = matching_channels[0]
            if strict_channel_proof.get("hard_conditions_passed") is not True:
                raise SystemExit("narrow-channel directional leg failed strict OHLC/ATR hard conditions")
            context["strict_narrow_channel"] = strict_channel_proof
        fifty = numeric(context, "fifty_percent_price")
        if strict_channel_proof is not None:
            expected_fifty = (
                float(strict_channel_proof["start_price"])
                + float(strict_channel_proof["directional_extreme_price"])
            ) / 2
        else:
            expected_fifty = (
                (float(bars[leg_start]["low"]) + float(bars[leg_end]["high"])) / 2
                if direction == "long"
                else (float(bars[leg_start]["high"]) + float(bars[leg_end]["low"])) / 2
            )
        if RULE_SET_KEY in CUSTOM_V2_STRICT_ANCHOR_RULE_SET_KEYS and not price_equal(fifty, expected_fifty):
            raise SystemExit("narrow-channel fifty_percent_price does not match the frozen directional leg")
        pullback_bars = bars[pullback_start : idx + 1]
        prior_pullback_bars = bars[pullback_start:idx]
        if direction == "long":
            if RULE_SET_KEY in CUSTOM_V2_ANY_PULLBACK_RULE_SET_KEYS:
                if any(
                    min(float(bar["open"]), float(bar["close"])) < fifty
                    for bar in pullback_bars
                ):
                    raise SystemExit(
                        "long narrow-channel pullback body crossed below the trend-leg 50% level"
                    )
            elif RULE_SET_KEY == CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY:
                if any(float(bar["low"]) < fifty for bar in prior_pullback_bars):
                    raise SystemExit("long narrow-channel pullback exceeded the trend-leg 50% level before the signal candle")
                if any(float(bar["close"]) < fifty for bar in pullback_bars):
                    raise SystemExit("long narrow-channel pullback closed below the trend-leg 50% level")
            elif min(float(bar["low"]) for bar in pullback_bars) < fifty:
                raise SystemExit("long narrow-channel pullback exceeded the trend-leg 50% level")
            if any(float(bar["close"]) < float(bar["ema20"]) for bar in pullback_bars):
                raise SystemExit("long narrow-channel pullback closed below EMA20")
        else:
            if RULE_SET_KEY in CUSTOM_V2_ANY_PULLBACK_RULE_SET_KEYS:
                if any(
                    max(float(bar["open"]), float(bar["close"])) > fifty
                    for bar in pullback_bars
                ):
                    raise SystemExit(
                        "short narrow-channel pullback body crossed above the trend-leg 50% level"
                    )
            elif RULE_SET_KEY == CUSTOM_V2_ANCHOR_CANDLE_CONTACT_LEGACY_RULE_SET_KEY:
                if any(float(bar["high"]) > fifty for bar in prior_pullback_bars):
                    raise SystemExit("short narrow-channel pullback exceeded the trend-leg 50% level before the signal candle")
                if any(float(bar["close"]) > fifty for bar in pullback_bars):
                    raise SystemExit("short narrow-channel pullback closed above the trend-leg 50% level")
            elif max(float(bar["high"]) for bar in pullback_bars) > fifty:
                raise SystemExit("short narrow-channel pullback exceeded the trend-leg 50% level")
            if any(float(bar["close"]) > float(bar["ema20"]) for bar in pullback_bars):
                raise SystemExit("short narrow-channel pullback closed above EMA20")
        prior_zone = context.get("prior_breakout_edge_zone")
        if prior_zone is not None:
            if not isinstance(prior_zone, dict):
                raise SystemExit("prior_breakout_edge_zone must be an object or null")
            zone_low = numeric(prior_zone, "low")
            zone_high = numeric(prior_zone, "high")
            if zone_low > zone_high:
                raise SystemExit("prior breakout edge zone is inverted")
            validate_prior_edge_lifecycle_binding(
                bars,
                idx,
                prior_zone,
                zone_low=zone_low,
                zone_high=zone_high,
            )
            if RULE_SET_KEY in CUSTOM_V2_STRICT_ANCHOR_RULE_SET_KEYS:
                expected_edge = "upper" if direction == "long" else "lower"
                if prior_zone.get("edge") != expected_edge:
                    raise SystemExit("prior breakout edge zone does not match the continuation direction")
                if "zone_low" in prior_zone and not price_equal(numeric(prior_zone, "zone_low"), zone_low):
                    raise SystemExit("prior breakout edge zone_low does not match low")
                if "zone_high" in prior_zone and not price_equal(numeric(prior_zone, "zone_high"), zone_high):
                    raise SystemExit("prior breakout edge zone_high does not match high")
                source_indices = prior_zone.get("source_indices")
                if (
                    not isinstance(source_indices, list)
                    or len(source_indices) < 2
                    or any(isinstance(value, bool) or not isinstance(value, int) for value in source_indices)
                    or source_indices != sorted(set(source_indices))
                    or any(value < 0 or value >= pullback_start or value not in structure_indices for value in source_indices)
                ):
                    raise SystemExit("prior breakout edge zone requires ordered causal source_indices before the pullback")
                if any(
                    float(bars[value]["high"]) < zone_low or float(bars[value]["low"]) > zone_high
                    for value in source_indices
                ):
                    raise SystemExit("prior breakout edge source_indices do not touch the recorded price zone")
            if direction == "long" and any(float(bar["close"]) < zone_low for bar in pullback_bars):
                raise SystemExit("long pullback closed below the prior lower-range upper-edge zone")
            if direction == "short" and any(float(bar["close"]) > zone_high for bar in pullback_bars):
                raise SystemExit("short pullback closed above the prior upper-range lower-edge zone")
        touches = context.get("touch_anchors")
        consolidation = context.get("consolidation_kind")
        if context["variant"] == "anchor_touch_pullback":
            if not isinstance(touches, list) or not touches:
                raise SystemExit("anchor-touch pullback requires at least one recorded anchor")
            if RULE_SET_KEY in CUSTOM_V2_STRICT_ANCHOR_RULE_SET_KEYS:
                if any(not isinstance(anchor, str) for anchor in touches):
                    raise SystemExit("anchor-touch pullback anchor names must be strings")
                reported_anchors = set(touches)
                if len(reported_anchors) != len(touches) or not reported_anchors <= CUSTOM_V2_ANCHOR_NAMES:
                    raise SystemExit("anchor-touch pullback contains duplicate or unsupported anchor names")

                actual_anchors: set[str] = set()
                signal_open = float(current["open"])
                signal_close = float(current["close"])
                signal_ema20 = float(current["ema20"])
                if RULE_SET_KEY in CUSTOM_V2_CANDLE_CONTACT_RULE_SET_KEYS:
                    if direction == "long":
                        contact_low = float(current["low"])
                        contact_high = max(signal_open, signal_close)
                    else:
                        contact_low = min(signal_open, signal_close)
                        contact_high = float(current["high"])

                    def accepted_point_contact(level: float) -> bool:
                        if not contact_low <= level <= contact_high:
                            return False
                        return signal_close >= level if direction == "long" else signal_close <= level

                    if accepted_point_contact(fifty):
                        actual_anchors.add("trend_leg_50_percent")
                    if accepted_point_contact(signal_ema20):
                        actual_anchors.add("ema20")
                    if prior_zone is not None and contact_low <= zone_high and contact_high >= zone_low:
                        accepted_zone = signal_close >= zone_low if direction == "long" else signal_close <= zone_high
                        if accepted_zone:
                            actual_anchors.add("prior_breakout_edge_zone")
                    if not actual_anchors:
                        raise SystemExit(
                            "narrow-channel signal-side wick/body must intersect and close on the valid side of "
                            "trend-leg 50%, EMA20, or the prior breakout edge zone"
                        )
                    if reported_anchors != actual_anchors:
                        raise SystemExit(
                            "touch_anchors does not exactly match the frozen signal-side wick/body contact and close evidence"
                        )
                else:
                    if direction == "long":
                        wick_low = float(current["low"])
                        wick_high = min(signal_open, signal_close)
                    else:
                        wick_low = max(signal_open, signal_close)
                        wick_high = float(current["high"])
                    if wick_low <= fifty <= wick_high:
                        actual_anchors.add("trend_leg_50_percent")
                    if wick_low <= signal_ema20 <= wick_high:
                        actual_anchors.add("ema20")
                    if prior_zone is not None and wick_low <= zone_high and wick_high >= zone_low:
                        actual_anchors.add("prior_breakout_edge_zone")
                    if not actual_anchors:
                        raise SystemExit(
                            "narrow-channel signal wick must touch trend-leg 50%, EMA20, or the prior breakout edge zone"
                        )
                    if reported_anchors != actual_anchors:
                        raise SystemExit("touch_anchors does not exactly match the frozen signal-wick evidence")
        elif context["variant"] == "unanchored_first_pullback":
            if touches != [] or consolidation is not None:
                raise SystemExit("unanchored first pullback must not invent anchors or consolidation")
        elif consolidation not in {"bull_flag", "bear_flag", "range"}:
            raise SystemExit("no-anchor pullback requires a bull/bear flag or a proven range")

    elif expected_family == "support_resistance_reversal":
        if RULE_SET_KEY in CUSTOM_V2_EFFECTIVE_SWING_SR_RULE_SET_KEYS:
            if context.get("variant") not in {"first_rejection", "reclaim_after_swing_break"}:
                raise SystemExit(
                    "effective-swing reversal variant is invalid; must be one of: "
                    "first_rejection, reclaim_after_swing_break"
                )
            expected_swing = effective_swing_reference(bars, idx, direction=direction)
            if expected_swing is None:
                raise SystemExit("support/resistance reversal requires a causally confirmed effective swing")
            swing_idx = integer(context, "swing_reference_idx", maximum=idx - 1)
            swing_confirmation_idx = integer(
                context, "swing_confirmation_idx", maximum=idx
            )
            swing_price = numeric(context, "swing_price")
            expected_kind = "effective_swing_low" if direction == "long" else "effective_swing_high"
            if context.get("swing_kind") != expected_kind:
                raise SystemExit("support/resistance reversal swing_kind does not match direction")
            if (
                swing_idx != int(expected_swing["idx"])
                or swing_confirmation_idx != int(expected_swing["confirmed_at_idx"])
                or not price_equal(swing_price, float(expected_swing["price"]))
            ):
                raise SystemExit(
                    "support/resistance reversal must reference the latest causally confirmed effective swing"
                )
            if swing_idx not in structure_indices or swing_confirmation_idx not in structure_indices:
                raise SystemExit("effective swing and its confirmation bar must be in structure_indices")
            expected_entry = float(current["high"] if direction == "long" else current["low"])
            if not price_equal(entry, expected_entry):
                raise SystemExit("support/resistance reversal entry must use the signal-bar extreme")
            if context["variant"] == "first_rejection":
                prior_close = float(bars[idx - 1]["close"])
                prior_was_outside = (
                    prior_close < swing_price
                    if direction == "long"
                    else prior_close > swing_price
                )
                if prior_was_outside:
                    raise SystemExit(
                        "first_rejection cannot hide an existing outside-close run; use reclaim_after_swing_break"
                    )
                valid_rejection = (
                    float(current["low"]) <= swing_price < float(current["close"])
                    if direction == "long"
                    else float(current["high"]) >= swing_price > float(current["close"])
                )
                if not valid_rejection:
                    raise SystemExit("signal bar does not reject the effective swing price")
                expected_stop = float(current["low"] if direction == "long" else current["high"])
            else:
                breach_idx = integer(context, "breach_bar_idx", maximum=idx - 1)
                if breach_idx < swing_confirmation_idx:
                    raise SystemExit("effective-swing breach cannot precede swing confirmation")
                breach = bars[breach_idx]
                def closes_outside(bar: dict[str, Any]) -> bool:
                    return (
                        float(bar["close"]) < swing_price
                        if direction == "long"
                        else float(bar["close"]) > swing_price
                    )

                expected_breach_idx = idx - 1
                if not closes_outside(bars[expected_breach_idx]):
                    raise SystemExit(
                        "effective-swing reclaim requires the immediately prior closed bar to remain outside"
                    )
                while (
                    expected_breach_idx - 1 >= swing_confirmation_idx
                    and closes_outside(bars[expected_breach_idx - 1])
                ):
                    expected_breach_idx -= 1
                if breach_idx != expected_breach_idx:
                    raise SystemExit(
                        "breach_bar_idx must be the first bar of the contiguous outside-close run"
                    )
                valid_reclaim = (
                    float(breach["close"]) < swing_price < float(current["close"])
                    if direction == "long"
                    else float(breach["close"]) > swing_price > float(current["close"])
                )
                if not valid_reclaim:
                    raise SystemExit("effective-swing reclaim does not match the breach/reclaim closes")
                interaction_indices = set(range(breach_idx, idx + 1))
                if not interaction_indices.issubset(structure_indices):
                    raise SystemExit(
                        "effective-swing reclaim structure_indices must contain the complete outside/reclaim sequence"
                    )
                expected_stop = (
                    min(float(bar["low"]) for bar in bars[breach_idx : idx + 1])
                    if direction == "long"
                    else max(float(bar["high"]) for bar in bars[breach_idx : idx + 1])
                )
            if not price_equal(stop, expected_stop):
                raise SystemExit("support/resistance reversal stop must be the interaction-sequence extreme")
            return context

        if context.get("variant") not in {"first_rejection", "reclaim_after_body_break"}:
            raise SystemExit(
                "support/resistance reversal variant is invalid; must be one of: "
                "first_rejection, reclaim_after_body_break"
            )
        reference_idx = integer(context, "reference_bar_idx", maximum=idx)
        reference = bars[reference_idx]
        age_seconds = int(current["close_time"]) - int(reference["close_time"])
        if age_seconds <= TWO_DAYS_SECONDS:
            raise SystemExit("support/resistance reference must be strictly more than two elapsed days old")
        reported_age = context.get("reference_age_seconds")
        if isinstance(reported_age, bool) or not isinstance(reported_age, int) or reported_age != age_seconds:
            raise SystemExit("support/resistance reference_age_seconds does not match frozen bar time")
        reference_body_level = numeric(context, "reference_body_level")
        reference_wick_level = numeric(context, "reference_wick_level")
        if direction == "long":
            actual_body = min(float(reference["open"]), float(reference["close"]))
            actual_wick = float(reference["low"])
            expected_entry = float(current["high"])
        else:
            actual_body = max(float(reference["open"]), float(reference["close"]))
            actual_wick = float(reference["high"])
            expected_entry = float(current["low"])
        if not price_equal(reference_body_level, actual_body) or not price_equal(reference_wick_level, actual_wick):
            raise SystemExit("support/resistance reference body/wick levels do not match the frozen old bar")
        if not price_equal(entry, expected_entry):
            raise SystemExit("support/resistance reversal entry must use the signal-bar extreme")
        case = context.get("interaction_case")
        current_body_low = min(float(current["open"]), float(current["close"]))
        current_body_high = max(float(current["open"]), float(current["close"]))
        if context["variant"] == "first_rejection":
            if direction == "long" and case == "wick_between_body_and_wick":
                valid_case = actual_wick <= float(current["low"]) <= actual_body
            elif direction == "long" and case == "wick_below_wick_body_above":
                valid_case = float(current["low"]) < actual_wick and current_body_low >= actual_wick
            elif direction == "short" and case == "wick_between_body_and_wick":
                valid_case = actual_body <= float(current["high"]) <= actual_wick
            elif direction == "short" and case == "wick_above_wick_body_below":
                valid_case = float(current["high"]) > actual_wick and current_body_high <= actual_wick
            else:
                valid_case = False
            if not valid_case:
                raise SystemExit("support/resistance first-rejection interaction case does not match OHLC")
            expected_stop = float(current["low"] if direction == "long" else current["high"])
        else:
            breach_idx = integer(context, "breach_bar_idx", maximum=idx)
            if breach_idx >= idx:
                raise SystemExit("reclaim signal requires an earlier breach bar")
            breach = bars[breach_idx]
            if direction == "long":
                breach_body_low = min(float(breach["open"]), float(breach["close"]))
                valid_reclaim = float(breach["low"]) < actual_wick and breach_body_low < actual_wick and float(current["close"]) > actual_wick
                expected_stop = min(float(bar["low"]) for bar in bars[breach_idx : idx + 1])
            else:
                breach_body_high = max(float(breach["open"]), float(breach["close"]))
                valid_reclaim = float(breach["high"]) > actual_wick and breach_body_high > actual_wick and float(current["close"]) < actual_wick
                expected_stop = max(float(bar["high"]) for bar in bars[breach_idx : idx + 1])
            if not valid_reclaim:
                raise SystemExit("support/resistance reclaim does not match the breach/reclaim OHLC sequence")
        if not price_equal(stop, expected_stop):
            raise SystemExit("support/resistance reversal stop must be the interaction-sequence extreme")
    return context


def cmd_step(args: argparse.Namespace) -> int:
    payload, raw_bars = load_data(args.data)
    bars = enrich(raw_bars, int(payload["timeframe_minutes"]))
    state = json.loads(state_path(args.out).read_text(encoding="utf-8"))
    validate_state_rule_set(state)
    idx = int(state["next_idx"])
    if idx >= len(bars):
        print(json.dumps(current_payload(bars, idx, state["chain_sha256"]), ensure_ascii=False))
        return 0
    if args.idx != idx:
        raise SystemExit(f"gate expected idx={idx}, received idx={args.idx}")
    if args.max_used_idx != idx:
        raise SystemExit("max_used_idx must equal the currently released idx")
    range_observation = reconcile_range_lifecycle_registry(bars, idx, state)
    evidence = parse_evidence(args.evidence)
    if any(value < 0 or value > idx for value in evidence):
        raise SystemExit("future/invalid evidence index")
    if args.decision == "SIGNAL" and args.direction == "none":
        raise SystemExit("SIGNAL requires long or short direction")
    if args.decision != "SIGNAL" and args.direction != "none":
        raise SystemExit("only SIGNAL may have a direction")
    if not args.reason.strip() or not args.setup.strip():
        raise SystemExit("setup/reason must not be blank")
    signal_context = parse_signal_context(args.signal_context)
    case_context = parse_case_context(args.case_context)
    if RULE_SET_KEY in LOUIE_RULE_SET_KEYS:
        case_context = validate_louie_case_context(
            idx,
            case_context,
            evidence,
            require_supplemental=RULE_SET_KEY in LOUIE_V5_RULE_SET_KEYS,
            require_brooks_full_corpus=RULE_SET_KEY in LOUIE_V6_RULE_SET_KEYS,
        )
    elif case_context is not None:
        raise SystemExit("non-Louie decisions must omit case_context")
    if RULE_SET_KEY in CUSTOM_V2_RULE_SET_KEYS:
        if args.decision == "SIGNAL":
            signal_context = validate_custom_v2_signal_context(
                bars,
                idx,
                setup=args.setup.strip(),
                direction=args.direction,
                context=signal_context,
            )
            if not set(signal_context["structure_indices"]).issubset(evidence):
                raise SystemExit("custom V2 evidence_indices must include every signal_context structure index")
        elif signal_context is not None:
            raise SystemExit("custom V2 non-SIGNAL decisions must omit signal_context")
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
    if signal_context is not None:
        record["signal_context"] = signal_context
    if case_context is not None:
        record["case_context"] = case_context
    if RULE_SET_KEY in CUSTOM_V2_RANGE30_RULE_SET_KEYS:
        if range_observation is not None:
            record["range_observation"] = range_observation
    if RULE_SET_KEY in CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_SET_KEYS:
        narrow_channel_observation = strict_narrow_channel_consistency(bars, idx)
        if narrow_channel_observation is not None:
            record["strict_narrow_channel_observation"] = narrow_channel_observation
    record["record_sha256"] = hashlib.sha256(canonical(record)).hexdigest()
    new_chain = hashlib.sha256((state["chain_sha256"] + record["record_sha256"]).encode("ascii")).hexdigest()
    record["chain_sha256"] = new_chain
    with ledger_path(args.out).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    state["next_idx"] = idx + 1
    state["chain_sha256"] = new_chain
    if state["next_idx"] < len(bars):
        reconcile_range_lifecycle_registry(bars, int(state["next_idx"]), state)
    write_json(state_path(args.out), state)
    print(json.dumps(current_payload(bars, idx + 1, new_chain), ensure_ascii=False))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    payload, raw_bars = load_data(args.data)
    bars = enrich(raw_bars, int(payload["timeframe_minutes"]))
    state = json.loads(state_path(args.out).read_text(encoding="utf-8"))
    validate_state_rule_set(state)
    idx = int(state["next_idx"])
    if idx < len(bars):
        reconcile_range_lifecycle_registry(bars, idx, state)
        write_json(state_path(args.out), state)
    print(json.dumps(current_payload(bars, idx, state["chain_sha256"]), ensure_ascii=False))
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
    step.add_argument("--signal-context", default="")
    step.add_argument("--case-context", default="")
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
