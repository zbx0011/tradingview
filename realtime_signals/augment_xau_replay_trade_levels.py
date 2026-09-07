#!/usr/bin/env python3
"""Add causal entry and fixed initial-stop plans.

The original signal objects are copied without changing any existing field.  A
new ``trade_plan`` field is derived from the exact causal-gate payload that was
available when the signal bar closed.  The immediately following bar is used
only to decide whether the one-bar entry window triggered.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

ZERO = Decimal("0")
CUSTOM_V2_RULE_VERSION = "custom_v2"
CUSTOM_V2_RANGE30_RULE_VERSION = "custom_v2_range30_one_sided"
CUSTOM_V2_UNANCHORED_RULE_VERSION = "custom_v2_range30_one_sided_unanchored_pullback"
CUSTOM_V2_FIVE_CLOSE_RULE_VERSION = "custom_v2_range30_one_sided_unanchored_pullback_five_close_breakout"
CUSTOM_V2_ANCHOR_REQUIRED_RULE_VERSION = "custom_v2_range30_one_sided_anchor_required_five_close_breakout"
CUSTOM_V2_ANCHOR_CANDLE_CONTACT_RULE_VERSION = "custom_v2_range30_one_sided_anchor_candle_contact_five_close_breakout"
CUSTOM_V2_ANY_PULLBACK_BODY50_RULE_VERSION = (
    "custom_v2_range30_one_sided_any_pullback_body50_anchor_contact_five_close_breakout"
)
CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout_effective_swing_sr"
)
CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_VERSION = (
    "custom_v2_range_lifecycle_bound_effective_swing_sr"
)
CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout"
)
CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION = (
    "custom_v2_range30_one_sided_strict_narrow_channel_any_pullback_body50_anchor_contact_five_close_breakout"
)
CUSTOM_V2_RULE_VERSIONS = {
    CUSTOM_V2_RULE_VERSION,
    CUSTOM_V2_RANGE30_RULE_VERSION,
    CUSTOM_V2_UNANCHORED_RULE_VERSION,
    CUSTOM_V2_FIVE_CLOSE_RULE_VERSION,
    CUSTOM_V2_ANCHOR_REQUIRED_RULE_VERSION,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_RULE_VERSION,
    CUSTOM_V2_ANY_PULLBACK_BODY50_RULE_VERSION,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_VERSION,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION,
}
CUSTOM_V2_RANGE30_RULE_VERSIONS = {
    CUSTOM_V2_RANGE30_RULE_VERSION,
    CUSTOM_V2_UNANCHORED_RULE_VERSION,
    CUSTOM_V2_FIVE_CLOSE_RULE_VERSION,
    CUSTOM_V2_ANCHOR_REQUIRED_RULE_VERSION,
    CUSTOM_V2_ANCHOR_CANDLE_CONTACT_RULE_VERSION,
    CUSTOM_V2_ANY_PULLBACK_BODY50_RULE_VERSION,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_VERSION,
    CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION,
    CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION,
    CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION,
}
CUSTOM_V2_UNANCHORED_RULE_VERSIONS = {
    CUSTOM_V2_UNANCHORED_RULE_VERSION,
    CUSTOM_V2_FIVE_CLOSE_RULE_VERSION,
}
CUSTOM_V2_ANCHOR_NAMES = {
    "trend_leg_50_percent",
    "ema20",
    "prior_breakout_edge_zone",
}
CUSTOM_V2_RANGE_BREAKOUT = "range_true_breakout"
CUSTOM_V2_SETUP_FAMILIES = {
    "震荡真突破": "range_true_breakout",
    "震荡反转": "range_reversal",
    "窄通道首次回调顺势": "narrow_channel_first_pullback",
    "窄通道回调顺势": "narrow_channel_pullback",
    "支撑压力反转": "support_resistance_reversal",
}


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decimal_price(value: Any) -> Decimal:
    return Decimal(str(value))


def json_number(value: Decimal, places: int | None = None) -> float:
    if places is not None:
        value = value.quantize(Decimal(1).scaleb(-places))
    return float(value)


def iter_gate_payloads(turn_logs_dir: Path) -> Iterable[dict[str, Any]]:
    """Yield structured current-bar payloads returned by the causal gate."""

    for path in sorted(turn_logs_dir.glob("turn_*.jsonl")):
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                item = event.get("item") or {}
                if item.get("type") != "mcp_tool_call" or item.get("status") != "completed":
                    continue
                result = item.get("result") or {}
                for content in result.get("content") or []:
                    if content.get("type") != "text":
                        continue
                    try:
                        payload = json.loads(content.get("text", ""))
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if (
                        isinstance(payload, dict)
                        and isinstance(payload.get("idx"), int)
                        and isinstance(payload.get("bar"), dict)
                        and isinstance(payload.get("confirmed_pivots"), list)
                    ):
                        yield payload


def load_gate_payloads(turn_logs_dir: Path) -> dict[int, dict[str, Any]]:
    payloads: dict[int, dict[str, Any]] = {}
    for payload in iter_gate_payloads(turn_logs_dir):
        idx = int(payload["idx"])
        previous = payloads.get(idx)
        if previous is not None and canonical_json(previous) != canonical_json(payload):
            raise ValueError(f"conflicting causal-gate payloads for idx={idx}")
        payloads[idx] = payload
    return payloads


def recover_missing_gate_payloads(
    raw_dir: Path,
    payloads: dict[int, dict[str, Any]],
    data_file: Path | None,
) -> tuple[dict[int, dict[str, Any]], dict[str, Any] | None]:
    """Deterministically reconstruct payloads omitted by a completed turn log.

    The replay ledger is the authority for the pre-decision chain.  Missing
    public gate payloads are recomputed with the exact frozen-data gate module
    and are accepted only when their bar time and pre-decision chain match the
    ledger.  This never asks the model for a replacement decision and never
    reads bars beyond the payload's own index.
    """

    manifest = json.loads((raw_dir / "manifest.json").read_text(encoding="utf-8"))
    progress = json.loads(
        (raw_dir / "orchestrator_progress.json").read_text(encoding="utf-8")
    )
    start_idx = int(progress["start_idx"])
    end_idx_exclusive = int(progress["end_idx_exclusive"])
    expected_indices = set(range(start_idx, end_idx_exclusive))
    missing = sorted(expected_indices - set(payloads))
    if not missing:
        return payloads, None
    if data_file is None:
        raise ValueError(
            "causal-gate payload coverage mismatch and --data-file was not supplied; "
            f"missing={missing}"
        )
    data_file = data_file.resolve()
    if file_sha256(data_file) != str(manifest["data_sha256"]):
        raise ValueError("recovery data file SHA256 does not match replay manifest")

    decisions: dict[int, dict[str, Any]] = {}
    with (raw_dir / "decisions.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            decisions[int(record["idx"])] = record
    if set(decisions) != expected_indices:
        raise ValueError("decision ledger coverage does not match recovery interval")

    gate_path = Path(__file__).with_name("xau_causal_gate.py").resolve()
    if not gate_path.is_file():
        raise ValueError(f"exact causal-gate source is missing: {gate_path}")

    environment = {
        "XAU_EXPECTED_SHA": str(manifest["data_sha256"]),
        "CAUSAL_RULE_SET": str(manifest["rule_set_key"]),
        "CAUSAL_RULE_SET_ID": str(manifest["rule_set_id"]),
        "CAUSAL_RULE_SET_SHA256": str(manifest.get("rule_set_sha256") or ""),
    }
    previous_environment = {name: os.environ.get(name) for name in environment}
    os.environ.update(environment)
    try:
        spec = importlib.util.spec_from_file_location(
            "xau_causal_gate_payload_recovery", gate_path
        )
        if spec is None or spec.loader is None:
            raise ValueError(f"could not load exact causal-gate source: {gate_path}")
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        frozen_payload, raw_bars = gate.load_data(data_file)
        bars = gate.enrich(raw_bars, int(frozen_payload["timeframe_minutes"]))
        for idx in missing:
            decision = decisions[idx]
            recovered = gate.current_payload(
                bars, idx, str(decision["previous_chain_sha256"])
            )
            if int(recovered["bar"]["open_time"]) != int(decision["bar_open_time"]):
                raise ValueError(f"recovered bar time mismatch at idx={idx}")
            if recovered["chain_sha256_before_decision"] != decision[
                "previous_chain_sha256"
            ]:
                raise ValueError(f"recovered pre-decision chain mismatch at idx={idx}")
            if recovered["rule_set_id"] != manifest["rule_set_id"]:
                raise ValueError(f"recovered rule-set mismatch at idx={idx}")
            payloads[idx] = recovered
    finally:
        for name, value in previous_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    recovery = {
        "version": 1,
        "method": "deterministic_recompute_from_frozen_data_and_exact_gate_source",
        "causal_guarantee": "recovered payloads use only bars through their own idx and the ledger pre-decision chain",
        "gate_source": gate_path.name,
        "gate_source_sha256": file_sha256(gate_path),
        "data_sha256": manifest["data_sha256"],
        "rule_set_id": manifest["rule_set_id"],
        "recovered_indices": missing,
        "source_payload_count": len(payloads) - len(missing),
        "final_payload_count": len(payloads),
    }
    return payloads, recovery


def latest_pivot(
    pivots: list[dict[str, Any]], *, kind: str, predicate: Any
) -> dict[str, Any] | None:
    candidates = [
        pivot
        for pivot in pivots
        if pivot.get("kind") == kind and predicate(decimal_price(pivot["price"]))
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda pivot: int(pivot["idx"]))


def resolve_signal_idx(
    signal: dict[str, Any], payloads: dict[int, dict[str, Any]]
) -> int:
    if "idx" in signal:
        return int(signal["idx"])
    if "bar_open_time" not in signal:
        raise ValueError("signal has neither idx nor bar_open_time")
    open_time = int(signal["bar_open_time"])
    matches = [
        idx
        for idx, payload in payloads.items()
        if int(payload["bar"]["open_time"]) == open_time
    ]
    if len(matches) != 1:
        raise ValueError(
            f"expected one causal-gate bar for signal open_time={open_time}, got {matches}"
        )
    return matches[0]


def build_custom_v2_trade_plan(
    signal: dict[str, Any], payloads: dict[int, dict[str, Any]], idx: int
) -> dict[str, Any]:
    context = signal.get("signal_context")
    if not isinstance(context, dict) or context.get("rule_version") not in CUSTOM_V2_RULE_VERSIONS:
        raise ValueError(f"missing custom V2 signal_context at idx={idx}")
    context_rule_version = str(context["rule_version"])
    side = signal["side"]
    if side not in {"L", "S"}:
        raise ValueError(f"unsupported custom V2 signal side at idx={idx}: {side!r}")
    current = payloads.get(idx)
    if current is None:
        raise ValueError(f"missing custom V2 signal payload at idx={idx}")
    family = str(context.get("family"))
    expected_family = CUSTOM_V2_SETUP_FAMILIES.get(str(signal.get("setup")))
    if expected_family is None or family != expected_family:
        raise ValueError(f"unsupported or mismatched custom V2 setup/family at idx={idx}")
    range_geometry = context.get("range")
    if family in {"range_true_breakout", "range_reversal"}:
        if not isinstance(range_geometry, dict):
            raise ValueError(f"missing custom V2 range geometry at idx={idx}")
        if context_rule_version in CUSTOM_V2_RANGE30_RULE_VERSIONS:
            kind = range_geometry.get("kind")
            if kind not in {"two_sided_range", "one_sided_edge"}:
                raise ValueError(f"invalid custom V2 range kind at idx={idx}")
            start_idx = range_geometry.get("start_idx")
            end_idx = range_geometry.get("end_idx")
            if not isinstance(start_idx, int) or not isinstance(end_idx, int) or end_idx > idx or end_idx - start_idx + 1 < 30:
                raise ValueError(f"invalid custom V2 30-bar range span at idx={idx}")
            if kind == "one_sided_edge":
                active_edge = range_geometry.get("active_edge")
                expected_edge = "upper" if (family == "range_true_breakout" and side == "L") or (family == "range_reversal" and side == "S") else "lower"
                if active_edge not in {"upper", "lower"} or active_edge != expected_edge:
                    raise ValueError(f"invalid custom V2 one-sided active edge at idx={idx}")
                touches = range_geometry.get(f"{active_edge}_touch_indices")
                if not isinstance(touches, list) or len(touches) < 3 or touches[-1] - touches[0] + 1 < 30:
                    raise ValueError(f"invalid custom V2 one-sided touch span at idx={idx}")
            else:
                if len(range_geometry.get("upper_touch_indices") or []) < 2 or len(range_geometry.get("lower_touch_indices") or []) < 2:
                    raise ValueError(f"invalid custom V2 two-sided touches at idx={idx}")
    if family in {"narrow_channel_first_pullback", "narrow_channel_pullback"} and context_rule_version in CUSTOM_V2_UNANCHORED_RULE_VERSIONS:
        variant = context.get("variant")
        if variant not in {"anchor_touch_pullback", "unanchored_first_pullback"}:
            raise ValueError(f"invalid active custom V2 narrow-channel variant at idx={idx}")
        if variant == "unanchored_first_pullback" and (
            context.get("touch_anchors") != [] or context.get("consolidation_kind") is not None
        ):
            raise ValueError(f"unanchored first pullback invents anchors/consolidation at idx={idx}")
    if family in {"narrow_channel_first_pullback", "narrow_channel_pullback"} and context_rule_version in {
        CUSTOM_V2_ANCHOR_REQUIRED_RULE_VERSION,
        CUSTOM_V2_ANCHOR_CANDLE_CONTACT_RULE_VERSION,
        CUSTOM_V2_ANY_PULLBACK_BODY50_RULE_VERSION,
        CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_VERSION,
        CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION,
        CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION,
        CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION,
    }:
        anchors = context.get("touch_anchors")
        if context.get("variant") != "anchor_touch_pullback":
            raise ValueError(f"active custom V2 narrow-channel signal must be anchor_touch_pullback at idx={idx}")
        if (
            not isinstance(anchors, list)
            or not anchors
            or any(not isinstance(anchor, str) for anchor in anchors)
            or len(set(anchors)) != len(anchors)
            or not set(anchors) <= CUSTOM_V2_ANCHOR_NAMES
        ):
            raise ValueError(f"active custom V2 narrow-channel signal requires valid non-empty touch_anchors at idx={idx}")
        if context_rule_version in {
            CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_VERSION,
            CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION,
            CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION,
            CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION,
        }:
            proof = context.get("strict_narrow_channel")
            if (
                not isinstance(proof, dict)
                or proof.get("event_type") != "strict_narrow_channel"
                or proof.get("hard_conditions_passed") is not True
                or proof.get("is_active") is not True
                or proof.get("start_idx") != context.get("trend_leg_start_idx")
                or proof.get("last_updated_idx") != context.get("trend_leg_end_idx")
            ):
                raise ValueError(
                    f"active custom V2 signal is missing the causal strict-channel proof at idx={idx}"
                )
    next_payload = payloads.get(idx + 1)
    try:
        entry = decimal_price(context["entry_trigger_price"])
        stop = decimal_price(context["initial_stop_price"])
    except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
        raise ValueError(f"invalid custom V2 entry/stop fields at idx={idx}") from exc
    risk = abs(entry - stop)
    if risk <= ZERO or (side == "L" and stop >= entry) or (side == "S" and stop <= entry):
        raise ValueError(f"invalid custom V2 entry/stop geometry at idx={idx}")

    stop_reference_idx = context.get("initial_stop_reference_idx")
    if (
        isinstance(stop_reference_idx, bool)
        or not isinstance(stop_reference_idx, int)
        or stop_reference_idx < 0
        or stop_reference_idx > idx
    ):
        raise ValueError(f"invalid custom V2 stop reference at idx={idx}")
    valid_open_time = None
    valid_beijing_open_time = None
    if next_payload is not None:
        valid_open_time = int(next_payload["bar"]["open_time"])
        valid_beijing_open_time = next_payload["bar"].get("beijing_open_time")

    if family == CUSTOM_V2_RANGE_BREAKOUT:
        entry_plan = {
            "mode": "range_true_breakout_state_machine",
            "side": "long" if side == "L" else "short",
            "trigger_reference": "initial_breakout_signal_bar_extreme",
            "planned_entry_price": json_number(entry),
            "trigger_condition": (
                "confirmation path: idx+2 strictly breaks confirmation-bar extreme; "
                "healthy-pullback path: a later bar touches the initial signal-bar extreme"
            ),
            "valid_bar_idx": idx + 1,
            "valid_bar_open_time": valid_open_time,
            "valid_bar_beijing_open_time": valid_beijing_open_time,
            "later_bars_allowed": True,
            "status": "CONDITIONAL_PENDING",
            "simulated_fill_price": None,
            "initial_signal_bar": {
                "idx": idx,
                "open": current["bar"]["open"],
                "high": current["bar"]["high"],
                "low": current["bar"]["low"],
                "close": current["bar"]["close"],
            },
            "confirmation_path": {
                "confirmation_bar_idx": idx + 1,
                "requires_same_direction_body": True,
                "entry_bar_idx": idx + 2,
                "strict_break": True,
                "later_bar_after_entry_bar_allowed": False,
            },
            "healthy_pullback_path": {
                "starts_at_idx": idx + 1,
                "entry_reference_price": json_number(entry),
                "touch_equality_triggers": True,
                "later_bars_allowed": True,
                "cancel_on_signal_bar_risk_extreme_break": True,
                "cancel_on_close_beyond_range_edge_zone": True,
            },
        }
        structural_exit = {
            "mode": "failed_breakout_next_bar_break",
            "range": copy.deepcopy(range_geometry),
            "arm_on_close_beyond_edge_zone": True,
            "valid_for_immediate_next_bar_only": True,
            "strict_break": True,
        }
        fill_adjusted_risk = None
    else:
        if next_payload is None:
            triggered = False
            fill = None
            status = "EXPIRED_NO_NEXT_BAR"
            next_bar_observation = None
        else:
            next_bar = next_payload["bar"]
            if side == "L":
                triggered = decimal_price(next_bar["high"]) > entry
                fill = max(entry, decimal_price(next_bar["open"])) if triggered else None
            else:
                triggered = decimal_price(next_bar["low"]) < entry
                fill = min(entry, decimal_price(next_bar["open"])) if triggered else None
            status = "TRIGGERED" if triggered else "EXPIRED_UNTRIGGERED"
            next_bar_observation = {
                "open": next_bar["open"],
                "high": next_bar["high"],
                "low": next_bar["low"],
                "close": next_bar["close"],
            }
        entry_plan = {
            "mode": "next_bar_signal_break",
            "side": "long" if side == "L" else "short",
            "trigger_reference": "recorded_custom_v2_signal_or_structure_extreme",
            "planned_entry_price": json_number(entry),
            "trigger_condition": "idx+1 strictly breaks the recorded entry trigger",
            "valid_bar_idx": idx + 1,
            "valid_bar_open_time": valid_open_time,
            "valid_bar_beijing_open_time": valid_beijing_open_time,
            "later_bars_allowed": False,
            "status": status,
            "simulated_fill_price": json_number(fill) if fill is not None else None,
            "next_bar_observation": next_bar_observation,
        }
        structural_exit = None
        if family == "range_reversal":
            structural_exit = {
                "mode": "range_reacceptance_then_touch",
                "range": copy.deepcopy(range_geometry),
                "arm_on_first_close_beyond_edge_zone": True,
                "touch_equality_triggers": True,
                "later_bars_allowed": True,
            }
        fill_adjusted_risk = abs(fill - stop) if fill is not None else None

    stop_methods = {
        "range_true_breakout": "initial_breakout_signal_bar_risk_extreme",
        "range_reversal": "failed_breakout_excursion_or_range_structure_extreme",
        "narrow_channel_first_pullback": "complete_pullback_or_consolidation_extreme",
        "narrow_channel_pullback": "complete_pullback_or_consolidation_extreme",
        "support_resistance_reversal": "old_level_interaction_sequence_extreme",
    }
    risk_reward: dict[str, Any] = {
        "planned_risk": json_number(risk),
        "planned_reward": None,
        "planned_reward_risk_ratio": None,
        "fill_adjusted_risk": json_number(fill_adjusted_risk) if fill_adjusted_risk is not None else None,
        "fill_adjusted_reward": None,
        "fill_adjusted_reward_risk_ratio": None,
        "not_applicable_reason": "no_fixed_take_profit_at_entry",
    }
    if family == "range_reversal":
        geometry = range_geometry or {}
        if geometry.get("kind", "two_sided_range") == "one_sided_edge":
            if context.get("range_reversal_rr_mode") != "not_applicable_one_sided_edge":
                raise ValueError(f"one-sided range reversal lacks its RR not-applicable marker at idx={idx}")
            risk_reward["signal_eligibility"] = {
                "mode": "not_applicable_one_sided_edge",
                "midpoint_distance": None,
                "opposite_edge_distance": None,
                "used_only_as_signal_filter_not_fixed_target": True,
            }
        else:
            midpoint = decimal_price(geometry["midpoint"])
            opposite = decimal_price(context["opposite_edge_price"])
            midpoint_distance = entry - midpoint if side == "S" else midpoint - entry
            opposite_distance = entry - opposite if side == "S" else opposite - entry
            risk_reward["signal_eligibility"] = {
                "mode": "two_sided_range_strict_filter",
                "midpoint_distance": json_number(midpoint_distance),
                "midpoint_distance_strictly_greater_than_risk": midpoint_distance > risk,
                "opposite_edge_distance": json_number(opposite_distance),
                "opposite_edge_distance_strictly_greater_than_two_risk": opposite_distance > 2 * risk,
                "used_only_as_signal_filter_not_fixed_target": True,
            }

    return {
        "rule_version": (
            "custom_v2_range_lifecycle_bound_trade_plan_v1_20260812"
            if context_rule_version == CUSTOM_V2_STRICT_NARROW_CHANNEL_RULE_VERSION
            else "custom_v2_effective_swing_sr_trade_plan_v1_20260812"
            if context_rule_version == CUSTOM_V2_EFFECTIVE_SWING_SR_LEGACY_RULE_VERSION
            else "custom_v2_strict_narrow_channel_ema20_two_close_any_pullback_trade_plan_v1_20260812"
            if context_rule_version == CUSTOM_V2_EMA20_TWO_CLOSE_LEGACY_RULE_VERSION
            else "custom_v2_strict_narrow_channel_any_pullback_trade_plan_v1_20260812"
            if context_rule_version == CUSTOM_V2_STRICT_NARROW_CHANNEL_LEGACY_RULE_VERSION
            else "custom_v2_any_pullback_body50_anchor_contact_trade_plan_v1_20260811"
            if context_rule_version == CUSTOM_V2_ANY_PULLBACK_BODY50_RULE_VERSION
            else "custom_v2_anchor_candle_contact_trade_plan_v1_20260811"
            if context_rule_version == CUSTOM_V2_ANCHOR_CANDLE_CONTACT_RULE_VERSION
            else "custom_v2_anchor_required_trade_plan_v1_20260811"
            if context_rule_version == CUSTOM_V2_ANCHOR_REQUIRED_RULE_VERSION
            else "custom_v2_five_close_breakout_trade_plan_v1_20260811"
            if context_rule_version == CUSTOM_V2_FIVE_CLOSE_RULE_VERSION
            else "custom_v2_range30_unanchored_pullback_trade_plan_v1_20260810"
            if context_rule_version == CUSTOM_V2_UNANCHORED_RULE_VERSION
            else "custom_v2_range30_one_sided_trade_plan_v1_20260810"
            if context_rule_version == CUSTOM_V2_RANGE30_RULE_VERSION
            else "custom_v2_four_setups_trade_plan_v1_20260810"
        ),
        "signal_context_rule_version": context_rule_version,
        "calculated_at_signal_idx": idx,
        "level_inputs_max_idx": idx,
        "no_future_data_used_for_levels": True,
        "signal_family": family,
        "signal_variant": context.get("variant"),
        "entry": entry_plan,
        "stop_loss": {
            "price": json_number(stop),
            "method": stop_methods.get(family, "custom_v2_structure_extreme"),
            "reference_idx": stop_reference_idx,
            "reference_kind": "custom_v2_recorded_structure_extreme",
            "known_at_signal_close": True,
            "fallback_used": False,
        },
        "structural_exit": structural_exit,
        "take_profit": {
            "enabled_at_entry": False,
            "price": None,
            "method": "not_set_at_entry_managed_by_stops_or_opposite_signal",
            "reference_idx": None,
            "known_at_signal_close": True,
            "fallback_used": False,
        },
        "risk_reward": risk_reward,
    }


def build_trade_plan(
    signal: dict[str, Any],
    payloads: dict[int, dict[str, Any]],
    *,
    rule_set_id: str | None = None,
) -> dict[str, Any]:
    idx = resolve_signal_idx(signal, payloads)
    side = signal["side"]
    if side not in {"L", "S"}:
        raise ValueError(f"unsupported signal side at idx={idx}: {side!r}")
    if isinstance(signal.get("signal_context"), dict) and signal["signal_context"].get("rule_version") in CUSTOM_V2_RULE_VERSIONS:
        return build_custom_v2_trade_plan(signal, payloads, idx)
    if idx not in payloads:
        raise ValueError(f"missing signal payload for idx={idx}")

    current = payloads[idx]
    next_payload = payloads.get(idx + 1)
    bar = current["bar"]
    next_bar = next_payload["bar"] if next_payload is not None else None
    pivots = current["confirmed_pivots"]

    if next_payload is not None:
        if int(next_payload["idx"]) != idx + 1:
            raise ValueError(f"entry window is not the immediate next bar for idx={idx}")
        if int(next_bar["open_time"]) <= int(bar["open_time"]):
            raise ValueError(f"non-increasing bar time at idx={idx}")

    close_confirmed_entry = "close_confirmed_entry" in str(rule_set_id or "").lower()

    if side == "L":
        entry = decimal_price(bar["high"])
        if close_confirmed_entry:
            triggered = next_bar is not None and decimal_price(next_bar["close"]) > entry
            fill = decimal_price(next_bar["close"]) if triggered else None
        else:
            triggered = next_bar is not None and decimal_price(next_bar["high"]) > entry
            fill = max(entry, decimal_price(next_bar["open"])) if triggered else None
        stop_pivot = latest_pivot(pivots, kind="L", predicate=lambda price: price < entry)
        trigger_reference = "signal_bar_high"
        trigger_operator = (
            "next_bar_close > signal_bar_high"
            if close_confirmed_entry
            else "next_bar_high > signal_bar_high"
        )
        stop_method = "latest_confirmed_pivot_low_below_entry"
    else:
        entry = decimal_price(bar["low"])
        if close_confirmed_entry:
            triggered = next_bar is not None and decimal_price(next_bar["close"]) < entry
            fill = decimal_price(next_bar["close"]) if triggered else None
        else:
            triggered = next_bar is not None and decimal_price(next_bar["low"]) < entry
            fill = min(entry, decimal_price(next_bar["open"])) if triggered else None
        stop_pivot = latest_pivot(pivots, kind="H", predicate=lambda price: price > entry)
        trigger_reference = "signal_bar_low"
        trigger_operator = (
            "next_bar_close < signal_bar_low"
            if close_confirmed_entry
            else "next_bar_low < signal_bar_low"
        )
        stop_method = "latest_confirmed_pivot_high_above_entry"

    if stop_pivot is not None:
        stop = decimal_price(stop_pivot["price"])
        stop_reference_idx = int(stop_pivot["idx"])
        stop_reference_kind = stop_pivot["kind"]
        stop_source = stop_method
        stop_is_fallback = False
    elif side == "L":
        stop = decimal_price(bar["low"])
        stop_reference_idx = idx
        stop_reference_kind = "signal_bar_low"
        stop_source = "signal_bar_low_no_confirmed_risk_side_pivot"
        stop_is_fallback = True
    else:
        stop = decimal_price(bar["high"])
        stop_reference_idx = idx
        stop_reference_kind = "signal_bar_high"
        stop_source = "signal_bar_high_no_confirmed_risk_side_pivot"
        stop_is_fallback = True
    risk = abs(entry - stop)
    if risk <= ZERO:
        raise ValueError(f"non-positive planned risk for idx={idx}")

    if stop_reference_idx > idx:
        raise ValueError(f"stop reference is not causal for idx={idx}")

    if triggered:
        assert fill is not None
        fill_adjusted_risk = abs(fill - stop)
    else:
        fill_adjusted_risk = None

    # V4/V5 no longer use the optional course-target adapter.  Keep an
    # explicit disabled descriptor so the backtester and audit can prove that
    # no fixed or post-entry structural target was supplied.
    take_profit = {
        "enabled_at_entry": False,
        "price": None,
        "method": "not_set_at_entry_managed_by_trailing_stop_or_opposite_signal",
        "reference_idx": None,
        "known_at_signal_close": True,
        "fixed_at_entry": False,
        "mode": "disabled_no_fixed_target",
        "fallback_used": False,
    }
    risk_reward = {
        "planned_risk": json_number(risk),
        "planned_reward": None,
        "planned_reward_risk_ratio": None,
        "fill_adjusted_risk": json_number(fill_adjusted_risk)
        if fill_adjusted_risk is not None
        else None,
        "fill_adjusted_reward": None,
        "fill_adjusted_reward_risk_ratio": None,
        "not_applicable_reason": "no_fixed_take_profit_at_entry",
    }
    rule_version = (
        "next_bar_close_confirmed_entry_initial_stop_no_fixed_target_v1_20260820"
        if close_confirmed_entry
        else "next_bar_breakout_initial_stop_no_fixed_target_v3_20260816"
    )

    return {
        "rule_version": rule_version,
        "calculated_at_signal_idx": idx,
        "level_inputs_max_idx": idx,
        "no_future_data_used_for_levels": True,
        "entry": {
            "side": "long" if side == "L" else "short",
            "trigger_reference": trigger_reference,
            "planned_entry_price": json_number(entry),
            "trigger_condition": trigger_operator,
            "confirmation_mode": (
                "next_bar_close_break"
                if close_confirmed_entry
                else "next_bar_signal_break"
            ),
            "valid_bar_idx": idx + 1,
            "valid_bar_open_time": int(next_bar["open_time"]) if next_bar is not None else None,
            "valid_bar_beijing_open_time": next_bar["beijing_open_time"] if next_bar is not None else None,
            "later_bars_allowed": False,
            "status": (
                "TRIGGERED"
                if triggered
                else "EXPIRED_NO_NEXT_BAR"
                if next_bar is None
                else "EXPIRED_UNTRIGGERED"
            ),
            "simulated_fill_price": json_number(fill) if fill is not None else None,
            "next_bar_observation": (
                {
                    "open": next_bar["open"],
                    "high": next_bar["high"],
                    "low": next_bar["low"],
                    "close": next_bar["close"],
                }
                if next_bar is not None
                else None
            ),
        },
        "stop_loss": {
            "price": json_number(stop),
            "method": stop_source,
            "reference_idx": stop_reference_idx,
            "reference_kind": stop_reference_kind,
            "known_at_signal_close": True,
            "fallback_used": stop_is_fallback,
        },
        "take_profit": take_profit,
        "risk_reward": risk_reward,
    }


def validate_replay_sources(
    raw_dir: Path,
    signal_doc: dict[str, Any],
    payloads: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    manifest = json.loads((raw_dir / "manifest.json").read_text(encoding="utf-8"))
    gate_state = json.loads((raw_dir / "gate_state.json").read_text(encoding="utf-8"))
    progress = json.loads(
        (raw_dir / "orchestrator_progress.json").read_text(encoding="utf-8")
    )
    if manifest["data_sha256"] != gate_state["data_sha256"]:
        raise ValueError("manifest and causal-gate data hashes differ")
    if progress.get("status") != "complete":
        raise ValueError("causal replay is not complete")
    if manifest["data_sha256"] != progress["data_sha256"]:
        raise ValueError("manifest and orchestrator data hashes differ")
    start_idx = int(progress["start_idx"])
    end_idx_exclusive = int(progress["end_idx_exclusive"])
    if start_idx != int(manifest["start_idx"]):
        raise ValueError("manifest and orchestrator replay starts differ")
    if end_idx_exclusive != int(gate_state["next_idx"]):
        raise ValueError("orchestrator replay end and causal-gate next index differ")
    replay_window = signal_doc.get("replay_window") or {}
    if (
        int(replay_window.get("start_idx", -1)) != start_idx
        or int(replay_window.get("end_idx", -2)) + 1 != end_idx_exclusive
    ):
        raise ValueError("signal document replay window does not match the completed replay")
    expected_indices = set(range(start_idx, end_idx_exclusive))
    allowed_payload_indices = set(expected_indices)
    # Committing the final decision may legitimately reveal exactly one
    # immediate-next-bar payload.  It is execution evidence, not another
    # decision in the requested replay window.
    if end_idx_exclusive < int(manifest["count"]):
        allowed_payload_indices.add(end_idx_exclusive)
    if not expected_indices.issubset(payloads) or not set(payloads).issubset(
        allowed_payload_indices
    ):
        missing = sorted(expected_indices - set(payloads))
        extra = sorted(set(payloads) - allowed_payload_indices)
        raise ValueError(f"causal-gate payload coverage mismatch: missing={missing}, extra={extra}")

    decisions: dict[int, dict[str, Any]] = {}
    with (raw_dir / "decisions.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            decisions[int(record["idx"])] = record
    if set(decisions) != expected_indices:
        raise ValueError("decision ledger coverage does not match the replay interval")
    for idx in expected_indices:
        payload = payloads[idx]
        if int(decisions[idx]["bar_open_time"]) != int(payload["bar"]["open_time"]):
            raise ValueError(f"bar time mismatch between ledger and gate payload at idx={idx}")

    drawings = signal_doc.get("drawings")
    if not isinstance(drawings, list) or not drawings:
        raise ValueError("signal document has no drawings")
    reported_total = (signal_doc.get("counts") or {}).get("total")
    if reported_total is not None and int(reported_total) != len(drawings):
        raise ValueError("signal document count does not match its drawings")
    resolved_indices: list[int] = []
    for drawing in drawings:
        idx = resolve_signal_idx(drawing, payloads)
        resolved_indices.append(idx)
        decision = decisions.get(idx)
        expected_direction = "long" if drawing["side"] == "L" else "short"
        if decision is None or decision.get("decision") != "SIGNAL":
            raise ValueError(f"kept drawing idx={idx} is not a SIGNAL in the causal ledger")
        if decision.get("direction") != expected_direction:
            raise ValueError(f"direction mismatch at idx={idx}")
    if len(resolved_indices) != len(set(resolved_indices)):
        raise ValueError("multiple input drawings resolve to the same signal bar")
    ledger_signal_indices = {
        idx for idx, decision in decisions.items() if decision.get("decision") == "SIGNAL"
    }
    if len(drawings) == len(ledger_signal_indices) and set(resolved_indices) != ledger_signal_indices:
        raise ValueError("full signal document does not match all raw causal-ledger signals")
    return manifest


def enrich_document(
    raw_dir: Path,
    signal_file: Path,
    payloads: dict[int, dict[str, Any]],
    payload_recovery: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_doc = json.loads(signal_file.read_text(encoding="utf-8"))
    manifest = validate_replay_sources(raw_dir, source_doc, payloads)
    output_doc = copy.deepcopy(source_doc)
    enriched_drawings = output_doc["drawings"]
    rule_set_id = str(source_doc.get("rule_set_id") or "")
    for drawing in enriched_drawings:
        drawing["trade_plan"] = build_trade_plan(
            drawing,
            payloads,
            rule_set_id=rule_set_id or None,
        )

    triggered = sum(
        drawing["trade_plan"]["entry"]["status"] == "TRIGGERED"
        for drawing in enriched_drawings
    )
    expired = sum(
        str(drawing["trade_plan"]["entry"]["status"]).startswith("EXPIRED")
        for drawing in enriched_drawings
    )
    conditional = len(enriched_drawings) - triggered - expired
    fallback_stops = sum(
        drawing["trade_plan"]["stop_loss"]["fallback_used"]
        for drawing in enriched_drawings
    )
    output_doc["trade_level_enrichment"] = {
        "version": 4,
        "signal_set_unchanged": True,
        "existing_signal_fields_unchanged": True,
        "source_signal_file": signal_file.as_posix(),
        "source_signal_file_sha256": file_sha256(signal_file),
        "source_data_sha256": manifest["data_sha256"],
        "ohlc_source": "structured causal-gate payloads preserved in raw replay turn logs",
        "source_gate_payload_count": len(payloads),
        "rules": {
            "entry": (
                "Louie close-confirmed-entry uses only idx+1 close strictly beyond the signal-bar high/low and fills at that close; V2 range true breakout uses its own confirmation-or-healthy-pullback state machine."
                if "close_confirmed_entry" in rule_set_id.lower()
                else "Legacy/V1 and three V2 families use only idx+1 strict breakout. V2 range true breakout uses its confirmation-or-healthy-pullback state machine."
            ),
            "planned_entry_price": "Use the signal-time trigger recorded by the applicable immutable rule set.",
            "gap_fill": (
                "Close-confirmed entry fills at the immediate next-bar close; no later bar is allowed."
                if "close_confirmed_entry" in rule_set_id.lower()
                else "If idx+1 opens beyond the planned entry, simulated fill uses the next-bar open; otherwise it uses the planned entry."
            ),
            "stop_loss": "Legacy/V1 uses the causal pivot fallback contract. Custom V2 uses the family-specific fixed structure extreme recorded in signal_context.",
            "take_profit": "No fixed or post-entry structural take-profit is used. Previous swing highs/lows, 1R/2R, measured moves, and Actual Risk remain context-only.",
            "exit_management": "The backtester may exit through the fixed initial stop, applicable custom V2 structural exit, configured USD trailing stop, opposite signal, or end-of-data marking.",
            "outcome_scope": "This enrichment marks entry only; it does not evaluate later stop or trailing outcomes.",
        },
        "counts": {
            "signals": len(enriched_drawings),
            "entry_triggered": triggered,
            "entry_expired_untriggered": expired,
            "entry_conditional_pending": conditional,
            "structural_stops": len(enriched_drawings) - fallback_stops,
            "signal_bar_fallback_stops": fallback_stops,
            "signals_without_fixed_take_profit": len(enriched_drawings),
            "signals_with_dynamic_course_target": 0,
        },
    }
    if payload_recovery is not None:
        output_doc["trade_level_enrichment"]["payload_recovery"] = payload_recovery
    return output_doc


def verify_existing_fields_unchanged(
    source_doc: dict[str, Any], output_doc: dict[str, Any]
) -> None:
    source_drawings = source_doc["drawings"]
    output_drawings = output_doc["drawings"]
    if len(source_drawings) != len(output_drawings):
        raise ValueError("signal count changed during enrichment")
    for source, output in zip(source_drawings, output_drawings, strict=True):
        stripped = {key: value for key, value in output.items() if key != "trade_plan"}
        if canonical_json(source) != canonical_json(stripped):
            identity = source.get("idx", source.get("bar_open_time"))
            raise ValueError(f"existing signal fields changed at signal={identity}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--signals", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--data-file",
        type=Path,
        help="Frozen replay data used only for deterministic recovery of missing gate payload logs.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payloads = load_gate_payloads(args.raw_dir / "turn_logs")
    payloads, payload_recovery = recover_missing_gate_payloads(
        args.raw_dir, payloads, args.data_file
    )
    source_doc = json.loads(args.signals.read_text(encoding="utf-8"))
    output_doc = enrich_document(
        args.raw_dir, args.signals, payloads, payload_recovery=payload_recovery
    )
    verify_existing_fields_unchanged(source_doc, output_doc)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(output_doc["trade_level_enrichment"]["counts"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
