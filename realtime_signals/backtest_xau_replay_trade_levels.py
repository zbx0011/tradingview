#!/usr/bin/env python3
"""Backtest enriched XAU replay signals with fixed risk and structural trailing.

All active Louie versions use the same no-target exit contract: the initial
stop, structural trailing stop, opposite signal, applicable custom structural
exit, or end-of-data marking.  Measured Move, 1R/2R, previous swings, and
Actual Risk are context-only and never create a post-entry take-profit.  The
``next_bar_opposite_break`` variant also requires an opposite signal's next
bar to strictly break that signal bar's risk-side extreme before closing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from realtime_signals.augment_xau_replay_trade_levels import (
        load_gate_payloads,
        recover_missing_gate_payloads,
    )
except ModuleNotFoundError:  # Support direct ``python path/to/script.py`` execution.
    from augment_xau_replay_trade_levels import (
        load_gate_payloads,
        recover_missing_gate_payloads,
    )


ZERO = Decimal("0")
DEFAULT_RISK_USD = Decimal("100")
# Kept as compatibility constants for older callers and archived tests.  They
# are no longer part of the active V4/V5 execution rule.
DEFAULT_TRAILING_ACTIVATION_USD = Decimal("100")
DEFAULT_TRAILING_DISTANCE_USD = Decimal("100")
ENTRY_SESSION_FILTER10 = "market_open_close_first_last_10_bars_no_new_entries"
SESSION_FILTER_TARGET_SYMBOLS = {"XAUUSD", "XAGUSD", "US500"}
BEIJING = timezone(timedelta(hours=8))
STRUCTURAL_TRAILING_RULE = (
    "strong_breakout_new_extreme_confirmed_structure_higher_opposite_break_v2"
)
POLICIES = {"conservative_stop_first", "target_first_preentry_stop"}
OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE = "next_bar_opposite_break"
OPPOSITE_SIGNAL_MODES = {
    "close_only",
    "close_and_reverse_next_bar",
    OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE,
}
DEFAULT_OPPOSITE_SIGNAL_MODE = "close_only"
ENTRY_CLOSE_CONFIRMATION_MODE = "next_bar_close_break"
ENTRY_CONFIRMATION_MODES = {"next_bar_signal_break", ENTRY_CLOSE_CONFIRMATION_MODE}
DEFAULT_ENTRY_CONFIRMATION_MODE = "next_bar_signal_break"
RANGE_BREAKOUT_ENTRY_MODE = "range_true_breakout_state_machine"
NEXT_BAR_ENTRY_MODES = {None, "next_bar_signal_break"}


def dec(value: Any) -> Decimal:
    return Decimal(str(value))


def number(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def rounded_number(value: Decimal, places: int = 6) -> float:
    return float(value.quantize(Decimal(1).scaleb(-places)))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_parameters(
    risk_usd: Decimal,
    trailing_activation_usd: Decimal,
    trailing_distance_usd: Decimal,
) -> None:
    for name, value in (
        ("risk_usd", risk_usd),
        ("trailing_activation_usd", trailing_activation_usd),
        ("trailing_distance_usd", trailing_distance_usd),
    ):
        if dec(value) <= ZERO:
            raise ValueError(f"{name} must be positive")


def validate_opposite_signal_mode(mode: str) -> None:
    if mode not in OPPOSITE_SIGNAL_MODES:
        choices = ", ".join(sorted(OPPOSITE_SIGNAL_MODES))
        raise ValueError(f"unsupported opposite signal mode: {mode!r}; expected one of {choices}")


def default_opposite_signal_mode(document: dict[str, Any]) -> str:
    """Select the exit mode from an explicit rule identity when available."""
    rule_set_id = str(document.get("rule_set_id") or "").lower()
    if "nextbar_opposite" in rule_set_id:
        return OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE
    return DEFAULT_OPPOSITE_SIGNAL_MODE


def default_entry_confirmation_mode(document: dict[str, Any]) -> str:
    """Select the causal entry confirmation from the explicit rule identity."""
    rule_set_id = str(document.get("rule_set_id") or "").lower()
    if "close_confirmed_entry" in rule_set_id:
        return ENTRY_CLOSE_CONFIRMATION_MODE
    return DEFAULT_ENTRY_CONFIRMATION_MODE


def validate_entry_confirmation_mode(mode: str) -> None:
    if mode not in ENTRY_CONFIRMATION_MODES:
        choices = ", ".join(sorted(ENTRY_CONFIRMATION_MODES))
        raise ValueError(
            f"unsupported entry confirmation mode: {mode!r}; expected one of {choices}"
        )


def signal_side(signal: dict[str, Any]) -> str:
    return "long" if signal["side"] == "L" else "short"


def validate_inputs(
    document: dict[str, Any], payloads: dict[int, dict[str, Any]]
) -> dict[int, dict[str, Any]]:
    drawings = document.get("drawings")
    if not isinstance(drawings, list) or not drawings:
        raise ValueError("backtest requires a non-empty raw, non-deduplicated signal set")
    if document.get("structural_dedup") is not None:
        raise ValueError("deduplicated signal input is not allowed")
    source_count = document.get("trade_level_enrichment", {}).get("counts", {}).get("signals")
    if source_count != len(drawings):
        raise ValueError("trade-level enrichment count does not match raw signals")

    signals: dict[int, dict[str, Any]] = {}
    for drawing in drawings:
        plan = drawing.get("trade_plan") or {}
        idx = int(plan["calculated_at_signal_idx"])
        if idx in signals:
            raise ValueError(f"duplicate raw signal at idx={idx}")
        if plan.get("level_inputs_max_idx") != idx or not plan.get(
            "no_future_data_used_for_levels"
        ):
            raise ValueError(f"non-causal trade levels at idx={idx}")
        entry = plan["entry"]
        confirmation_mode = entry.get("confirmation_mode") or default_entry_confirmation_mode(document)
        validate_entry_confirmation_mode(confirmation_mode)
        entry_mode = entry.get("mode")
        if int(entry["valid_bar_idx"]) != idx + 1:
            raise ValueError(f"invalid entry start at idx={idx}")
        if entry_mode == RANGE_BREAKOUT_ENTRY_MODE:
            if entry.get("later_bars_allowed") is not True or plan.get("signal_family") != "range_true_breakout":
                raise ValueError(f"invalid custom V2 range-breakout entry machine at idx={idx}")
        elif entry_mode in NEXT_BAR_ENTRY_MODES:
            if entry.get("later_bars_allowed"):
                raise ValueError(f"invalid one-bar entry window at idx={idx}")
        else:
            raise ValueError(f"unsupported entry mode at idx={idx}: {entry_mode!r}")
        stop = plan.get("stop_loss")
        if not isinstance(stop, dict) or stop.get("price") is None:
            raise ValueError(f"missing fixed initial stop at idx={idx}")
        take_profit = plan.get("take_profit")
        if isinstance(take_profit, dict):
            # A disabled/null take-profit descriptor is allowed for provenance,
            # but a fixed target must never silently affect the v3 backtest.
            if take_profit.get("enabled_at_entry") not in (None, False):
                raise ValueError(f"fixed take-profit is enabled at idx={idx}")
            if take_profit.get("price") is not None:
                raise ValueError(f"fixed take-profit price is not supported at idx={idx}")
            if take_profit.get("mode") == "dynamic_after_entry":
                raise ValueError(f"post-entry dynamic take-profit is not supported at idx={idx}")
        # The signal bar is required for causal validation.  Its one-bar
        # entry window may be absent when the signal is the final available
        # bar; the backtest then records an explicit no-next-bar expiry for
        # the pending plan instead of inventing a fill.
        if idx not in payloads:
            raise ValueError(f"missing OHLC payload for signal idx={idx}")
        if int(drawing["bar_open_time"]) != int(payloads[idx]["bar"]["open_time"]):
            raise ValueError(f"signal time does not match causal OHLC at idx={idx}")
        signals[idx] = drawing
    return signals


def entry_observation(
    signal: dict[str, Any],
    bar: dict[str, Any],
    confirmation_mode: str | None = None,
) -> tuple[bool, Decimal | None, bool]:
    plan = signal["trade_plan"]["entry"]
    if plan.get("mode") == RANGE_BREAKOUT_ENTRY_MODE:
        raise ValueError("range-breakout state-machine entries require pending-state evaluation")
    entry = dec(plan["planned_entry_price"])
    confirmation_mode = confirmation_mode or plan.get("confirmation_mode") or DEFAULT_ENTRY_CONFIRMATION_MODE
    validate_entry_confirmation_mode(confirmation_mode)
    if confirmation_mode == ENTRY_CLOSE_CONFIRMATION_MODE:
        if signal_side(signal) == "long":
            triggered = dec(bar["close"]) > entry
        else:
            triggered = dec(bar["close"]) < entry
        fill = dec(bar["close"]) if triggered else None
        entered_at_open = False
        expected = plan["status"] == "TRIGGERED"
        if triggered != expected:
            idx = signal["trade_plan"]["calculated_at_signal_idx"]
            raise ValueError(f"stored and recomputed close-confirmed entry status differ at idx={idx}")
        if fill is not None and number(fill) != plan["simulated_fill_price"]:
            idx = signal["trade_plan"]["calculated_at_signal_idx"]
            raise ValueError(f"stored and recomputed close-confirmed fill differ at idx={idx}")
        return triggered, fill, entered_at_open
    if signal_side(signal) == "long":
        triggered = dec(bar["high"]) > entry
        entered_at_open = triggered and dec(bar["open"]) >= entry
        fill = max(entry, dec(bar["open"])) if triggered else None
    else:
        triggered = dec(bar["low"]) < entry
        entered_at_open = triggered and dec(bar["open"]) <= entry
        fill = min(entry, dec(bar["open"])) if triggered else None
    expected = plan["status"] == "TRIGGERED"
    if triggered != expected:
        idx = signal["trade_plan"]["calculated_at_signal_idx"]
        raise ValueError(f"stored and recomputed entry status differ at idx={idx}")
    if fill is not None and number(fill) != plan["simulated_fill_price"]:
        idx = signal["trade_plan"]["calculated_at_signal_idx"]
        raise ValueError(f"stored and recomputed fill differ at idx={idx}")
    return triggered, fill, entered_at_open


def opposite_exit_observation(
    pending_exit: dict[str, Any], bar: dict[str, Any]
) -> tuple[bool, Decimal | None]:
    """Check the one-bar strict breakout that confirms an opposite exit.

    The exit is deliberately symmetric with the one-next-bar entry rule:
    a long is closed only when the next bar strictly breaks the opposite
    signal bar's low, and a short only when it strictly breaks that bar's
    high.  A gap through the trigger is filled at the next bar open; an
    intrabar break is filled at the trigger extreme.
    """

    position_side = pending_exit["position_side"]
    trigger_price = dec(pending_exit["trigger_price"])
    open_price = dec(bar["open"])
    if position_side == "long":
        triggered = dec(bar["low"]) < trigger_price
        fill = min(trigger_price, open_price) if triggered else None
    elif position_side == "short":
        triggered = dec(bar["high"]) > trigger_price
        fill = max(trigger_price, open_price) if triggered else None
    else:
        raise ValueError(f"unsupported pending opposite-exit position side: {position_side!r}")
    return triggered, fill


def range_breakout_invalidated(signal: dict[str, Any], bar: dict[str, Any]) -> bool:
    plan = signal["trade_plan"]
    entry = plan["entry"]
    range_geometry = plan["structural_exit"]["range"]
    signal_bar = entry["initial_signal_bar"]
    if signal_side(signal) == "long":
        return dec(bar["low"]) < dec(signal_bar["low"]) or dec(bar["close"]) < dec(range_geometry["upper_zone_low"])
    return dec(bar["high"]) > dec(signal_bar["high"]) or dec(bar["close"]) > dec(range_geometry["lower_zone_high"])


def advance_range_breakout_pending(
    pending: dict[str, Any], idx: int, bar: dict[str, Any]
) -> tuple[str, Decimal | None, bool, str]:
    """Advance the V2 true-breakout confirmation/pullback entry machine."""

    signal = pending["signal"]
    entry_plan = signal["trade_plan"]["entry"]
    signal_idx = int(signal["trade_plan"]["calculated_at_signal_idx"])
    first_idx = signal_idx + 1
    if idx < first_idx:
        raise ValueError(f"range-breakout pending entry reached idx={idx} before {first_idx}")
    state = pending.setdefault("entry_state", {"stage": "await_first_post_signal_bar"})
    stage = state["stage"]
    side = signal_side(signal)

    # Once a confirmation bar has been frozen, the next bar's strict break is
    # the entry event even when that same OHLC bar also visits the initial
    # stop or closes back through the range edge.  Those post-entry events are
    # resolved by the normal entry-bar ambiguity/stop logic below.  Applying
    # the pre-entry invalidation first would silently erase a valid fill.
    if stage != "await_confirmation_break" and range_breakout_invalidated(signal, bar):
        return "expired", None, False, "RANGE_BREAKOUT_INVALIDATED_BEFORE_ENTRY"

    if stage == "await_first_post_signal_bar":
        if idx != first_idx:
            return "expired", None, False, "RANGE_BREAKOUT_MISSING_FIRST_POST_SIGNAL_BAR"
        same_direction = dec(bar["close"]) > dec(bar["open"]) if side == "long" else dec(bar["close"]) < dec(bar["open"])
        if same_direction:
            state.update(
                {
                    "stage": "await_confirmation_break",
                    "confirmation_idx": idx,
                    # Pending state is copied into the public signal-event
                    # audit record, so keep it JSON-native.  ``dec`` is
                    # reapplied when the value is consumed below.
                    "confirmation_price": number(
                        dec(bar["high"] if side == "long" else bar["low"])
                    ),
                    "entry_idx": idx + 1,
                }
            )
            return "waiting", None, False, "CONFIRMATION_BAR_RECORDED"
        state["stage"] = "healthy_pullback"

    if state["stage"] == "await_confirmation_break":
        expected_idx = int(state["entry_idx"])
        if idx < expected_idx:
            return "waiting", None, False, "WAITING_CONFIRMATION_BREAK_BAR"
        if idx > expected_idx:
            return "expired", None, False, "CONFIRMATION_BREAK_WINDOW_EXPIRED"
        trigger = dec(state["confirmation_price"])
        triggered = dec(bar["high"]) > trigger if side == "long" else dec(bar["low"]) < trigger
        if not triggered:
            return "expired", None, False, "CONFIRMATION_BAR_NOT_BROKEN_ON_NEXT_BAR"
        entered_at_open = dec(bar["open"]) >= trigger if side == "long" else dec(bar["open"]) <= trigger
        fill = max(trigger, dec(bar["open"])) if side == "long" else min(trigger, dec(bar["open"]))
        return "triggered", fill, entered_at_open, "CONFIRMATION_PATH_TRIGGERED"

    if state["stage"] == "healthy_pullback":
        trigger = dec(entry_plan["planned_entry_price"])
        # The user explicitly said a touch is enough on this path.
        triggered = dec(bar["high"]) >= trigger if side == "long" else dec(bar["low"]) <= trigger
        if not triggered:
            return "waiting", None, False, "HEALTHY_PULLBACK_STILL_ARMED"
        entered_at_open = dec(bar["open"]) >= trigger if side == "long" else dec(bar["open"]) <= trigger
        fill = max(trigger, dec(bar["open"])) if side == "long" else min(trigger, dec(bar["open"]))
        return "triggered", fill, entered_at_open, "HEALTHY_PULLBACK_TOUCH_TRIGGERED"
    raise ValueError(f"unsupported range-breakout pending stage: {state['stage']!r}")


def make_position(
    signal: dict[str, Any],
    entry_idx: int,
    entry_bar: dict[str, Any],
    fill: Decimal,
    entered_at_open: bool,
    *,
    risk_usd: Decimal = DEFAULT_RISK_USD,
    trailing_activation_usd: Decimal = DEFAULT_TRAILING_ACTIVATION_USD,
    trailing_distance_usd: Decimal = DEFAULT_TRAILING_DISTANCE_USD,
) -> dict[str, Any]:
    validate_parameters(risk_usd, trailing_activation_usd, trailing_distance_usd)
    plan = signal["trade_plan"]
    initial_stop = dec(plan["stop_loss"]["price"])
    risk = abs(fill - initial_stop)
    if risk <= ZERO:
        raise ValueError(f"non-positive initial risk at entry idx={entry_idx}")
    units = dec(risk_usd) / risk
    return {
        "side": signal_side(signal),
        "setup": signal.get("setup"),
        "signal_context": signal.get("signal_context"),
        "signal_family": plan.get("signal_family"),
        "entry_mode": plan["entry"].get("mode") or "legacy_next_bar_signal_break",
        "entry_confirmation_mode": plan["entry"].get(
            "confirmation_mode", DEFAULT_ENTRY_CONFIRMATION_MODE
        ),
        "entry_signal_idx": int(plan["calculated_at_signal_idx"]),
        "entry_signal_bar_open_time": int(signal["bar_open_time"]),
        "entry_idx": entry_idx,
        "entry_bar_open_time": int(entry_bar["open_time"]),
        "entry_bar_beijing_open_time": entry_bar.get("beijing_open_time"),
        "entry_price": fill,
        "entered_at_bar_open": entered_at_open,
        "initial_stop_loss": initial_stop,
        # Keep these compatibility fields explicit so downstream consumers can
        # distinguish a disabled target from a missing field.
        "stop_loss": initial_stop,
        "fixed_take_profit": None,
        "take_profit": None,
        "no_fixed_take_profit_at_entry": True,
        "course_target_enabled": False,
        "course_target_candidates": [],
        "initial_risk": risk,
        "stop_method": plan["stop_loss"].get("method"),
        "normalized_position_units": units,
        # The historical USD fields remain explicit nulls so downstream
        # consumers cannot mistake the compatibility schema for an active
        # dollar-threshold rule.
        "trailing_rule": STRUCTURAL_TRAILING_RULE,
        "trailing_activation_usd": None,
        "trailing_distance_usd": None,
        "trailing_activation_price": None,
        "trailing_activation_distance_price": None,
        "trailing_distance_price": None,
        "trailing_activated": False,
        "trailing_activation_idx": None,
        "trailing_activation_bar_open_time": None,
        "favorable_price": fill,
        "active_stop": initial_stop,
        "trailing_breakout_idx": None,
        "trailing_breakout_extreme": None,
        "trailing_breakout_count": 0,
        "trailing_structure_idx": None,
        "trailing_structure_confirmation_idx": None,
        "trailing_structure_price": None,
        "trailing_updates": [],
        "custom_structural_exit": plan.get("structural_exit"),
        "custom_structural_exit_state": None,
    }


def level_exit(
    position: dict[str, Any],
    bar: dict[str, Any],
    *,
    is_entry_bar: bool,
    policy: str,
) -> tuple[Decimal, str, bool] | None:
    """Return stop exit price, reason and pre-entry OHLC ambiguity."""

    if policy not in POLICIES:
        raise ValueError(f"unsupported intrabar policy: {policy}")
    side = position["side"]
    open_ = dec(bar["open"])
    high = dec(bar["high"])
    low = dec(bar["low"])
    initial_stop = position.get("initial_stop_loss", position.get("stop_loss"))
    if initial_stop is None:
        raise ValueError("position is missing initial stop")
    active_stop = dec(position.get("active_stop", initial_stop))
    trailing_active = bool(position.get("trailing_activated"))
    reason = "TRAILING_STOP" if trailing_active else "INITIAL_STOP_LOSS"
    stop_hit = low <= active_stop if side == "long" else high >= active_stop
    if not is_entry_bar:
        crossed_at_open = open_ <= active_stop if side == "long" else open_ >= active_stop
        if crossed_at_open:
            return open_, f"{reason}_GAP", False
    if not stop_hit:
        return None
    pre_entry_stop = is_entry_bar and not position.get("entered_at_bar_open", False)
    if pre_entry_stop and policy == "target_first_preentry_stop":
        # The optimistic sensitivity assumes the risk-side extreme happened
        # before the intrabar breakout entry.  There is no target in the
        # active V4/V5 contract; the historical policy name is retained for
        # artifact compatibility.
        return None
    return active_stop, reason, pre_entry_stop


def has_ohlc_order_ambiguity(
    position: dict[str, Any], bar: dict[str, Any], *, is_entry_bar: bool
) -> bool:
    if is_entry_bar and position.get("entered_at_bar_open", False):
        return False
    side = position["side"]
    initial_stop = position.get("initial_stop_loss", position.get("stop_loss"))
    if initial_stop is None:
        raise ValueError("position is missing initial stop")
    stop = dec(position.get("active_stop", initial_stop))
    stop_hit = dec(bar["low"]) <= stop if side == "long" else dec(bar["high"]) >= stop
    if not is_entry_bar:
        return False
    return stop_hit


def custom_structure_exit(
    position: dict[str, Any], bar: dict[str, Any], *, bar_idx: int
) -> tuple[Decimal, str] | None:
    config = position.get("custom_structural_exit")
    state = position.get("custom_structural_exit_state")
    if not isinstance(config, dict) or not isinstance(state, dict):
        return None
    side = position["side"]
    trigger = dec(state["trigger_price"])
    open_ = dec(bar["open"])

    if config.get("mode") == "failed_breakout_next_bar_break":
        if int(state["valid_bar_idx"]) != bar_idx:
            return None
        hit = dec(bar["low"]) < trigger if side == "long" else dec(bar["high"]) > trigger
        if not hit:
            return None
        gap = open_ < trigger if side == "long" else open_ > trigger
        return (open_ if gap else trigger), "FALSE_BREAKOUT_STRUCTURE_EXIT"

    if config.get("mode") == "range_reacceptance_then_touch":
        if bar_idx <= int(state["armed_at_idx"]):
            return None
        hit = dec(bar["high"]) >= trigger if side == "short" else dec(bar["low"]) <= trigger
        if not hit:
            return None
        gap = open_ >= trigger if side == "short" else open_ <= trigger
        return (open_ if gap else trigger), "RANGE_REACCEPTANCE_STRUCTURE_EXIT"
    raise ValueError(f"unsupported custom structural exit mode: {config.get('mode')!r}")


def update_custom_structure_exit_after_close(
    position: dict[str, Any], bar: dict[str, Any], *, bar_idx: int
) -> None:
    config = position.get("custom_structural_exit")
    if not isinstance(config, dict):
        return
    side = position["side"]
    geometry = config["range"]
    mode = config.get("mode")
    if mode == "failed_breakout_next_bar_break":
        # An older one-bar trigger expires whether or not it was touched.
        position["custom_structural_exit_state"] = None
        invalid_close = (
            dec(bar["close"]) < dec(geometry["upper_zone_low"])
            if side == "long"
            else dec(bar["close"]) > dec(geometry["lower_zone_high"])
        )
        if invalid_close:
            position["custom_structural_exit_state"] = {
                "armed_at_idx": bar_idx,
                "valid_bar_idx": bar_idx + 1,
                "trigger_price": dec(bar["low"] if side == "long" else bar["high"]),
            }
        return
    if mode == "range_reacceptance_then_touch":
        if position.get("custom_structural_exit_state") is not None:
            return
        reaccepted_wrong_side = (
            dec(bar["close"]) > dec(geometry["upper_zone_high"])
            if side == "short"
            else dec(bar["close"]) < dec(geometry["lower_zone_low"])
        )
        if reaccepted_wrong_side:
            position["custom_structural_exit_state"] = {
                "armed_at_idx": bar_idx,
                "trigger_price": dec(bar["high"] if side == "short" else bar["low"]),
            }
        return
    raise ValueError(f"unsupported custom structural exit mode: {mode!r}")


def _confirmed_structure_pivot(
    bars_by_idx: dict[int, dict[str, Any]], pivot_idx: int, *, side: str
) -> dict[str, Any] | None:
    """Return a causal three-bar structure low/high, if it is confirmed."""

    previous = bars_by_idx.get(pivot_idx - 1)
    candidate = bars_by_idx.get(pivot_idx)
    following = bars_by_idx.get(pivot_idx + 1)
    if previous is None or candidate is None or following is None:
        return None
    if side == "long":
        confirmed = (
            dec(candidate["low"]) < dec(previous["low"])
            and dec(candidate["low"]) < dec(following["low"])
        )
        price_key = "low"
        kind = "structure_low"
    elif side == "short":
        confirmed = (
            dec(candidate["high"]) > dec(previous["high"])
            and dec(candidate["high"]) > dec(following["high"])
        )
        price_key = "high"
        kind = "structure_high"
    else:
        raise ValueError(f"unsupported position side: {side!r}")
    if not confirmed:
        return None
    return {
        "idx": pivot_idx,
        "kind": kind,
        "price": dec(candidate[price_key]),
        "confirmed_at_idx": pivot_idx + 1,
        "open_time": int(candidate.get("open_time", 0)),
    }


def _post_entry_extreme_before(
    position: dict[str, Any], bars_by_idx: dict[int, dict[str, Any]], bar_idx: int
) -> Decimal:
    """Return the running post-entry high/low used by the breakout test."""

    side = position["side"]
    entry_idx = int(position["entry_idx"])
    previous_indices = [
        idx for idx in bars_by_idx if entry_idx < idx < bar_idx
    ]
    if not previous_indices:
        return dec(position["entry_price"])
    if side == "long":
        return max(dec(bars_by_idx[idx]["high"]) for idx in previous_indices)
    return min(dec(bars_by_idx[idx]["low"]) for idx in previous_indices)


def _is_strong_breakout_to_new_extreme(
    position: dict[str, Any],
    bar: dict[str, Any],
    *,
    bar_idx: int,
    previous_favorable: Decimal,
    bars_by_idx: dict[int, dict[str, Any]] | None,
) -> bool:
    """Use a causal, price-only definition of a strong breakout.

    A strong breakout is a directional close strictly beyond the running
    post-entry extreme and a simultaneous strict new favorable wick extreme.
    No USD, ATR, body-percentage, or future-bar threshold is introduced.
    """

    if bars_by_idx is None or bar_idx <= int(position["entry_idx"]):
        return False
    reference = _post_entry_extreme_before(position, bars_by_idx, bar_idx)
    side = position["side"]
    if side == "long":
        return (
            dec(bar["close"]) > reference
            and dec(bar["close"]) > dec(bar["open"])
            and dec(bar["high"]) > previous_favorable
        )
    return (
        dec(bar["close"]) < reference
        and dec(bar["close"]) < dec(bar["open"])
        and dec(bar["low"]) < previous_favorable
    )


def _latest_structure_after_breakout(
    position: dict[str, Any],
    *,
    bar_idx: int,
    bars_by_idx: dict[int, dict[str, Any]] | None,
) -> dict[str, Any] | None:
    if bars_by_idx is None:
        return None
    breakout_idx = position.get("trailing_breakout_idx")
    if breakout_idx is None:
        return None
    last_structure_idx = position.get("trailing_structure_idx")
    for pivot_idx in range(bar_idx - 1, int(breakout_idx), -1):
        if last_structure_idx is not None and pivot_idx <= int(last_structure_idx):
            break
        pivot = _confirmed_structure_pivot(
            bars_by_idx, pivot_idx, side=position["side"]
        )
        if pivot is not None:
            # A pivot confirmed by the current bar cannot be the structure
            # moved to on that same bar.  The preceding high/low break must
            # occur after the risk-side pivot was already confirmed.
            if int(pivot["confirmed_at_idx"]) >= bar_idx:
                continue
            return pivot
    return None


def _preceding_opposite_structure(
    position: dict[str, Any],
    pivot: dict[str, Any],
    *,
    bars_by_idx: dict[int, dict[str, Any]],
) -> dict[str, Any] | None:
    """Return the latest confirmed opposite-side pivot before ``pivot``.

    A risk-side pivot is not independently eligible for a protective ratchet.
    For a long position, the preceding reference must be a confirmed structure
    high; for a short position it must be a confirmed structure low.  The
    reference also has to be causally confirmed no later than the risk-side
    pivot's right-bar confirmation.
    """

    opposite_side = "short" if position["side"] == "long" else "long"
    entry_idx = int(position["entry_idx"])
    pivot_idx = int(pivot["idx"])
    pivot_confirmation_idx = int(pivot["confirmed_at_idx"])
    for candidate_idx in range(pivot_idx - 1, entry_idx - 1, -1):
        candidate = _confirmed_structure_pivot(
            bars_by_idx, candidate_idx, side=opposite_side
        )
        if candidate is None:
            continue
        if int(candidate["confirmed_at_idx"]) <= pivot_confirmation_idx:
            return candidate
    return None


def _favorable_break_of_preceding_opposite_structure(
    position: dict[str, Any],
    pivot: dict[str, Any],
    *,
    bar_idx: int,
    bars_by_idx: dict[int, dict[str, Any]],
) -> dict[str, Any] | None:
    """Check the strict higher-high/lower-low gate for a pivot ratchet.

    The risk-side pivot must be formed first.  Only a later closed-bar wick
    that is strictly beyond the preceding confirmed opposite-side pivot can
    authorize moving the stop to that risk-side pivot.  The current bar is
    included because the update itself is performed after that bar closes and
    the new line is effective from the following bar.
    """

    preceding = _preceding_opposite_structure(
        position, pivot, bars_by_idx=bars_by_idx
    )
    if preceding is None:
        return None
    start_idx = max(int(pivot["confirmed_at_idx"]), int(pivot["idx"]) + 1)
    for candidate_idx in sorted(bars_by_idx):
        if candidate_idx < start_idx or candidate_idx > bar_idx:
            continue
        candidate_bar = bars_by_idx[candidate_idx]
        if position["side"] == "long":
            broke = dec(candidate_bar["high"]) > dec(preceding["price"])
        else:
            broke = dec(candidate_bar["low"]) < dec(preceding["price"])
        if broke:
            return {
                "preceding_opposite_structure_idx": int(preceding["idx"]),
                "preceding_opposite_structure_price": dec(preceding["price"]),
                "preceding_opposite_structure_confirmation_idx": int(
                    preceding["confirmed_at_idx"]
                ),
                "preceding_opposite_breakout_idx": candidate_idx,
                "preceding_opposite_breakout_extreme": dec(
                    candidate_bar["high"]
                    if position["side"] == "long"
                    else candidate_bar["low"]
                ),
            }
    return None


def update_trailing_stop(
    position: dict[str, Any],
    bar: dict[str, Any],
    *,
    bar_idx: int,
    bars_by_idx: dict[int, dict[str, Any]] | None = None,
) -> None:
    """Update the structural trailing line after a closed bar.

    The sequence is deliberately causal and book-aligned:

    1. A directional close must break the post-entry running extreme and make
       a new favorable wick extreme (strong breakout -> new extreme).
    2. After that breakout, a later three-bar pivot on the risk side must be
       confirmed by its right bar.
    3. The risk-side pivot is only eligible after a later favorable wick
       strictly breaks the preceding confirmed opposite-side pivot: a higher
       high for a long position or a lower low for a short position.
    4. The stop is ratcheted to that structure low/high only when it improves
       protection.  The line is effective from the next bar.

    ``bars_by_idx`` is optional only for compatibility with small callers that
    inspect a position in isolation; without the causal history no structural
    update is allowed.
    """

    side = position["side"]
    # The entry bar is the fill bar, not a completed post-entry management
    # bar.  Do not let its wick become the running extreme or arm a trailing
    # breakout; management starts from the next closed bar.
    if bar_idx <= int(position["entry_idx"]):
        return
    previous_favorable = dec(position["favorable_price"])
    candidate_favorable = dec(bar["high"]) if side == "long" else dec(bar["low"])
    favorable = (
        max(previous_favorable, candidate_favorable)
        if side == "long"
        else min(previous_favorable, candidate_favorable)
    )
    position["favorable_price"] = favorable

    # First consume a structure formed by an already recorded breakout.  A
    # current-bar breakout is armed below and cannot use a pivot that does not
    # yet exist.
    pivot = _latest_structure_after_breakout(
        position, bar_idx=bar_idx, bars_by_idx=bars_by_idx
    )
    if pivot is not None:
        gate = _favorable_break_of_preceding_opposite_structure(
            position,
            pivot,
            bar_idx=bar_idx,
            bars_by_idx=bars_by_idx,
        )
        # Keep an unqualified pivot available for a later higher-high/lower-low
        # break.  Consuming it here would make the state machine permanently
        # miss the intended delayed ratchet.
        if gate is None:
            pivot = None
    if pivot is not None:
        candidate_stop = dec(pivot["price"])
        current_stop = dec(position["active_stop"])
        improves = (
            candidate_stop > current_stop
            if side == "long"
            else candidate_stop < current_stop
        )
        if improves:
            position["active_stop"] = candidate_stop
            position["trailing_activated"] = True
            position["trailing_activation_idx"] = bar_idx
            position["trailing_activation_bar_open_time"] = int(
                bar.get("open_time", 0)
            )
            position["trailing_structure_idx"] = int(pivot["idx"])
            position["trailing_structure_confirmation_idx"] = int(
                pivot["confirmed_at_idx"]
            )
            position["trailing_structure_price"] = candidate_stop
            position["trailing_preceding_opposite_structure_idx"] = gate[
                "preceding_opposite_structure_idx"
            ]
            position["trailing_preceding_opposite_structure_price"] = gate[
                "preceding_opposite_structure_price"
            ]
            position["trailing_preceding_opposite_breakout_idx"] = gate[
                "preceding_opposite_breakout_idx"
            ]
            position["trailing_preceding_opposite_breakout_extreme"] = gate[
                "preceding_opposite_breakout_extreme"
            ]
            position.setdefault("trailing_updates", []).append(
                {
                    "breakout_idx": int(position["trailing_breakout_idx"]),
                    "breakout_extreme": number(
                        dec(position["trailing_breakout_extreme"])
                    ),
                    "structure_idx": int(pivot["idx"]),
                    "structure_confirmation_idx": int(pivot["confirmed_at_idx"]),
                    "structure_price": number(candidate_stop),
                    **{
                        key: number(value) if isinstance(value, Decimal) else value
                        for key, value in gate.items()
                    },
                }
            )
        else:
            # Do not repeatedly consume an old pivot.  A later strong breakout
            # can arm a new tracking leg and produce a new eligible pivot.
            position["trailing_structure_idx"] = int(pivot["idx"])

    if _is_strong_breakout_to_new_extreme(
        position,
        bar,
        bar_idx=bar_idx,
        previous_favorable=previous_favorable,
        bars_by_idx=bars_by_idx,
    ):
        position["trailing_breakout_idx"] = bar_idx
        position["trailing_breakout_extreme"] = candidate_favorable
        position["trailing_breakout_count"] = int(
            position.get("trailing_breakout_count", 0)
        ) + 1
        # A new leg starts a new structure-tracking cycle.  Keep the last
        # applied structure for audit; the newer breakout index makes older
        # pivots ineligible for the next update.


def close_trade(
    position: dict[str, Any],
    *,
    exit_idx: int,
    exit_bar: dict[str, Any],
    exit_price: Decimal,
    exit_reason: str,
    ambiguous_ohlc_order: bool,
    exit_signal_idx: int | None = None,
    exit_signal_bar_open_time: int | None = None,
) -> dict[str, Any]:
    if position["side"] == "long":
        pnl = exit_price - position["entry_price"]
    else:
        pnl = position["entry_price"] - exit_price
    r_multiple = pnl / position["initial_risk"]
    return {
        "trade_number": 0,
        "side": position["side"],
        "setup": position.get("setup"),
        "signal_family": position.get("signal_family"),
        "signal_context": position.get("signal_context"),
        "entry_mode": position.get("entry_mode"),
        "entry_confirmation_mode": position.get(
            "entry_confirmation_mode", DEFAULT_ENTRY_CONFIRMATION_MODE
        ),
        "entry_signal_idx": position["entry_signal_idx"],
        "entry_signal_bar_open_time": position["entry_signal_bar_open_time"],
        "entry_idx": position["entry_idx"],
        "entry_bar_open_time": position["entry_bar_open_time"],
        "entry_bar_beijing_open_time": position["entry_bar_beijing_open_time"],
        "entry_price": number(position["entry_price"]),
        "initial_stop_loss": number(position["initial_stop_loss"]),
        "stop_loss": number(position["initial_stop_loss"]),
        "fixed_take_profit": None,
        "take_profit": None,
        "no_fixed_take_profit_at_entry": True,
        "course_take_profit": None,
        "initial_risk": number(position["initial_risk"]),
        "stop_method": position["stop_method"],
        "final_active_stop": number(position["active_stop"]),
        "trailing_rule": position.get("trailing_rule", STRUCTURAL_TRAILING_RULE),
        "trailing_activation_usd": number(position.get("trailing_activation_usd")),
        "trailing_distance_usd": number(position.get("trailing_distance_usd")),
        "trailing_activation_price": number(position.get("trailing_activation_price")),
        "trailing_activation_distance_price": number(
            position.get("trailing_activation_distance_price")
        ),
        "trailing_distance_price": number(position.get("trailing_distance_price")),
        "trailing_activated": bool(position["trailing_activated"]),
        "trailing_activation_idx": position["trailing_activation_idx"],
        "trailing_activation_bar_open_time": position["trailing_activation_bar_open_time"],
        "favorable_price": number(position["favorable_price"]),
        "trailing_breakout_idx": position.get("trailing_breakout_idx"),
        "trailing_breakout_extreme": number(
            position.get("trailing_breakout_extreme")
        ),
        "trailing_breakout_count": int(position.get("trailing_breakout_count", 0)),
        "trailing_structure_idx": position.get("trailing_structure_idx"),
        "trailing_structure_confirmation_idx": position.get(
            "trailing_structure_confirmation_idx"
        ),
        "trailing_structure_price": number(
            position.get("trailing_structure_price")
        ),
        "trailing_preceding_opposite_structure_idx": position.get(
            "trailing_preceding_opposite_structure_idx"
        ),
        "trailing_preceding_opposite_structure_price": number(
            position.get("trailing_preceding_opposite_structure_price")
        ),
        "trailing_preceding_opposite_breakout_idx": position.get(
            "trailing_preceding_opposite_breakout_idx"
        ),
        "trailing_preceding_opposite_breakout_extreme": number(
            position.get("trailing_preceding_opposite_breakout_extreme")
        ),
        "trailing_updates": position.get("trailing_updates", []),
        "normalized_position_units": number(position["normalized_position_units"]),
        "exit_idx": exit_idx,
        "exit_bar_open_time": int(exit_bar["open_time"]),
        "exit_bar_beijing_close_time": exit_bar.get("beijing_close_time"),
        "exit_signal_idx": exit_signal_idx,
        "exit_signal_bar_open_time": exit_signal_bar_open_time,
        "exit_price": number(exit_price),
        "exit_reason": exit_reason,
        "ambiguous_ohlc_order": bool(
            ambiguous_ohlc_order or position.get("had_ambiguous_ohlc_order")
        ),
        "bars_held_including_entry": exit_idx - position["entry_idx"] + 1,
        "pnl_price_units": number(pnl),
        "r_multiple": round(float(r_multiple), 8),
    }


def summarize(
    trades: list[dict[str, Any]],
    counters: Counter[str],
    *,
    opposite_signal_mode: str | None = None,
) -> dict[str, Any]:
    pnls = [dec(trade["pnl_price_units"]) for trade in trades]
    wins = [value for value in pnls if value > ZERO]
    losses = [value for value in pnls if value < ZERO]
    flats = [value for value in pnls if value == ZERO]
    gross_profit = sum(wins, ZERO)
    gross_loss = sum(losses, ZERO)
    net = sum(pnls, ZERO)
    cumulative = ZERO
    peak = ZERO
    max_drawdown = ZERO
    max_consecutive_losses = 0
    consecutive_losses = 0
    for pnl in pnls:
        cumulative += pnl
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, peak - cumulative)
        if pnl < ZERO:
            consecutive_losses += 1
            max_consecutive_losses = max(max_consecutive_losses, consecutive_losses)
        else:
            consecutive_losses = 0
    exit_reasons = Counter(trade["exit_reason"] for trade in trades)
    side_counts = Counter(trade["side"] for trade in trades)
    return {
        "gross_pnl_price_units_per_1_unit_position": number(net),
        "gross_profit_price_units": number(gross_profit),
        "gross_loss_price_units": number(gross_loss),
        "profit_factor": round(float(gross_profit / abs(gross_loss)), 8)
        if gross_loss < ZERO
        else None,
        "closed_trades": len(trades),
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "breakeven_trades": len(flats),
        "win_rate_percent": round(100 * len(wins) / len(trades), 6) if trades else 0.0,
        "total_r_multiple": round(sum((trade["r_multiple"] for trade in trades), 0.0), 8),
        "average_r_multiple": round(
            sum((trade["r_multiple"] for trade in trades), 0.0) / len(trades), 8
        )
        if trades
        else 0.0,
        "closed_equity_max_drawdown_price_units": number(max_drawdown),
        "max_consecutive_losses": max_consecutive_losses,
        "long_trades": side_counts.get("long", 0),
        "short_trades": side_counts.get("short", 0),
        "exit_reason_counts": dict(sorted(exit_reasons.items())),
        "ambiguous_ohlc_trade_count": sum(
            bool(trade["ambiguous_ohlc_order"]) for trade in trades
        ),
        "ambiguous_ohlc_event_count": counters["ambiguous_ohlc_events"],
        "signal_handling": {
            "opposite_signal_mode": opposite_signal_mode,
            "raw_signals": counters["raw_signals"],
            "flat_signals_scheduled": counters["flat_signals_scheduled"],
            "same_side_signals_ignored": counters["same_side_signals_ignored"],
            "same_side_signals_ignored_while_pending": counters[
                "same_side_signals_ignored_while_pending"
            ],
            "opposite_signals_handled": counters["opposite_signals_handled"],
            "opposite_signals_used_to_close": counters["opposite_signals_used_to_close"],
            "opposite_signals_scheduled_for_confirmation": counters[
                "opposite_signals_scheduled_for_confirmation"
            ],
            "opposite_signals_confirmed_to_close": counters[
                "opposite_signals_confirmed_to_close"
            ],
            "opposite_signals_confirmation_expired": counters[
                "opposite_signals_confirmation_expired"
            ],
            "opposite_signals_confirmation_canceled_by_level_exit": counters[
                "opposite_signals_confirmation_canceled_by_level_exit"
            ],
            "opposite_signals_confirmation_expired_no_next_bar": counters[
                "opposite_signals_confirmation_expired_no_next_bar"
            ],
            "opposite_signals_scheduled_for_reversal": counters[
                "opposite_signals_scheduled_for_reversal"
            ],
            "scheduled_entries_planned": counters["scheduled_entries_planned"],
            "scheduled_entries_triggered": counters["scheduled_entries_triggered"],
            "scheduled_entries_expired": counters["scheduled_entries_expired"],
            "entry_session_boundary_blocked": counters[
                "entry_session_boundary_blocked"
            ],
            "flat_entries_triggered": counters["flat_entries_triggered"],
            "flat_entries_expired": counters["flat_entries_expired"],
            "reverse_entries_planned": counters["reverse_entries_planned"],
            "reverse_entries_triggered": counters["reverse_entries_triggered"],
            "reverse_entries_expired": counters["reverse_entries_expired"],
            # ``reversal_*`` aliases make the accounting self-describing for
            # readers that use the noun from the mode name.
            "reversal_entries_planned": counters["reverse_entries_planned"],
            "reversal_entries_triggered": counters["reverse_entries_triggered"],
            "reversal_entries_expired": counters["reverse_entries_expired"],
        },
    }


def apply_fixed_risk_sizing(
    trades: list[dict[str, Any]],
    risk_usd: Decimal,
    *,
    exit_rule_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Size every trade so entry-to-stop planned risk equals ``risk_usd``."""

    if dec(risk_usd) <= ZERO:
        raise ValueError("fixed risk USD must be positive")
    cash_pnls: list[Decimal] = []
    cumulative = ZERO
    peak = ZERO
    max_drawdown = ZERO
    for trade in trades:
        initial_risk = dec(trade["initial_risk"])
        if initial_risk <= ZERO:
            raise ValueError(f"non-positive initial risk in trade {trade['trade_number']}")
        normalized_units = dec(risk_usd) / initial_risk
        cash_pnl = dec(trade["pnl_price_units"]) * normalized_units
        cumulative += cash_pnl
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, peak - cumulative)
        cash_pnls.append(cash_pnl)
        trade["normalized_position_units"] = rounded_number(normalized_units, 8)
        trade["fixed_risk_sizing"] = {
            "planned_stop_risk_usd": rounded_number(dec(risk_usd)),
            "normalized_position_units": rounded_number(normalized_units, 8),
            "pnl_usd": rounded_number(cash_pnl),
            "cumulative_pnl_usd": rounded_number(cumulative),
        }

    wins = [value for value in cash_pnls if value > ZERO]
    losses = [value for value in cash_pnls if value < ZERO]
    gross_profit = sum(wins, ZERO)
    gross_loss = sum(losses, ZERO)
    net = sum(cash_pnls, ZERO)
    summary: dict[str, Any] = {
        "planned_stop_risk_usd_per_trade": rounded_number(dec(risk_usd)),
        "net_pnl_usd": rounded_number(net),
        "gross_profit_usd": rounded_number(gross_profit),
        "gross_loss_usd": rounded_number(gross_loss),
        "profit_factor": round(float(gross_profit / abs(gross_loss)), 8)
        if gross_loss < ZERO
        else None,
        "average_pnl_usd": rounded_number(net / len(trades)) if trades else 0.0,
        "largest_win_usd": rounded_number(max(cash_pnls)) if cash_pnls else 0.0,
        "largest_loss_usd": rounded_number(min(cash_pnls)) if cash_pnls else 0.0,
        "closed_equity_max_drawdown_usd": rounded_number(max_drawdown),
        "losses_exceeding_planned_risk": sum(value < -dec(risk_usd) for value in cash_pnls),
        # Retain the historical key as an alias for downstream readers; it is
        # no longer tied to a take-profit/RR grouping.
        "losses_exceeding_planned_100_percent_risk": sum(
            value < -dec(risk_usd) for value in cash_pnls
        ),
        "sum_of_per_trade_planned_risk_usd": rounded_number(dec(risk_usd) * len(trades)),
        "exit_reason_counts": dict(sorted(Counter(trade["exit_reason"] for trade in trades).items())),
    }
    if exit_rule_config is not None:
        summary["exit_rule_config"] = exit_rule_config
    return summary


def _normalise_symbol(value: Any) -> str:
    text = str(value or "").upper()
    return text.split(":")[-1].replace("_", "")


def _bar_beijing_datetime(bar: dict[str, Any]) -> datetime | None:
    for key in ("beijing_open_time", "open_time", "time"):
        value = bar.get(key)
        if value is None:
            continue
        if isinstance(value, str):
            text = value.strip().replace("Z", "+00:00")
            try:
                parsed = datetime.fromisoformat(text)
            except ValueError:
                continue
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=BEIJING)
            return parsed.astimezone(BEIJING)
        if isinstance(value, (int, float)):
            seconds = float(value)
            if seconds > 1_000_000_000_000:
                seconds /= 1000.0
            return datetime.fromtimestamp(seconds, tz=timezone.utc).astimezone(BEIJING)
    return None


def compute_entry_session_filter(
    document: dict[str, Any],
    payloads: dict[int, dict[str, Any]],
    session_filter: dict[str, Any] | None,
) -> tuple[set[int], dict[str, Any]]:
    """Return causal entry-bar exclusions and an auditable filter manifest.

    XAUUSD/XAGUSD sessions are grouped by the Beijing 06:00 session day.  US500
    sessions are detected from actual timestamp gaps, so the rule follows the
    frozen data rather than assuming an exchange calendar.  Only entry plans
    are blocked; open positions continue through normal exit management.
    """
    requested = bool(session_filter and session_filter.get("enabled", True))
    symbol = _normalise_symbol(document.get("symbol"))
    first_n = int((session_filter or {}).get("first_n_bars_after_open", 10))
    last_n = int((session_filter or {}).get("last_n_bars_before_close", 10))
    base = {
        "enabled": False,
        "rule": (session_filter or {}).get("rule", ENTRY_SESSION_FILTER10),
        "target_symbols": sorted(SESSION_FILTER_TARGET_SYMBOLS),
        "symbol": symbol,
        "first_n_bars_after_open": first_n,
        "last_n_bars_before_close": last_n,
        "new_entries_only": True,
        "session_group_count": 0,
        "excluded_entry_bar_count": 0,
        "excluded_entry_indices_sha256": hashlib.sha256(b"[]").hexdigest(),
    }
    if not requested:
        base["reason"] = "not_requested"
        return set(), base
    if symbol not in SESSION_FILTER_TARGET_SYMBOLS:
        base["reason"] = "symbol_not_target"
        return set(), base
    if first_n < 0 or last_n < 0:
        raise ValueError("session filter bar counts must be non-negative")

    ordered: list[tuple[int, datetime]] = []
    for idx in sorted(payloads):
        dt = _bar_beijing_datetime(payloads[idx].get("bar") or {})
        if dt is not None:
            ordered.append((int(idx), dt))
    if not ordered:
        raise ValueError("session filter requires timestamped OHLC payloads")

    timeframe_value = document.get("timeframe_minutes")
    if not timeframe_value:
        timeframe_field = document.get("timeframe")
        if isinstance(timeframe_field, dict):
            timeframe_value = timeframe_field.get("minutes")
        elif isinstance(timeframe_field, (int, float, str)):
            timeframe_value = timeframe_field
    timeframe_minutes = int(timeframe_value or 5)
    groups: list[list[tuple[int, datetime]]] = []
    if symbol in {"XAUUSD", "XAGUSD"}:
        grouped: dict[Any, list[tuple[int, datetime]]] = {}
        for item in ordered:
            session_day = (item[1] - timedelta(hours=6)).date()
            grouped.setdefault(session_day, []).append(item)
        groups = [grouped[key] for key in sorted(grouped)]
        detection = "beijing_06_00_session_day"
    else:
        current: list[tuple[int, datetime]] = []
        max_gap_seconds = timeframe_minutes * 60 + 1
        for item in ordered:
            if current and (item[1] - current[-1][1]).total_seconds() > max_gap_seconds:
                groups.append(current)
                current = []
            current.append(item)
        if current:
            groups.append(current)
        detection = "actual_timestamp_gap"

    excluded: set[int] = set()
    for group in groups:
        if not group:
            continue
        excluded.update(idx for idx, _ in group[:first_n])
        if last_n:
            excluded.update(idx for idx, _ in group[-last_n:])
    excluded_list = sorted(excluded)
    encoded = json.dumps(excluded_list, separators=(",", ":")).encode("utf-8")
    base.update(
        {
            "enabled": True,
            "session_detection": detection,
            "session_group_count": len(groups),
            "excluded_entry_bar_count": len(excluded_list),
            "excluded_entry_indices_sha256": hashlib.sha256(encoded).hexdigest(),
        }
    )
    return excluded, base


def run_backtest(
    document: dict[str, Any],
    payloads: dict[int, dict[str, Any]],
    *,
    policy: str,
    opposite_signal_mode: str | None = None,
    entry_confirmation_mode: str | None = None,
    session_filter: dict[str, Any] | None = None,
    risk_usd: Decimal = DEFAULT_RISK_USD,
    trailing_activation_usd: Decimal = DEFAULT_TRAILING_ACTIVATION_USD,
    trailing_distance_usd: Decimal = DEFAULT_TRAILING_DISTANCE_USD,
) -> dict[str, Any]:
    validate_parameters(risk_usd, trailing_activation_usd, trailing_distance_usd)
    if opposite_signal_mode is None:
        opposite_signal_mode = default_opposite_signal_mode(document)
    validate_opposite_signal_mode(opposite_signal_mode)
    if entry_confirmation_mode is None:
        entry_confirmation_mode = default_entry_confirmation_mode(document)
    validate_entry_confirmation_mode(entry_confirmation_mode)
    signals = validate_inputs(document, payloads)
    replay_window = document.get("replay_window") or {}
    if "start_idx" in replay_window and "end_idx" in replay_window:
        start_idx = int(replay_window["start_idx"])
        end_idx = int(replay_window["end_idx"])
        indices = list(range(start_idx, end_idx + 1))
        missing_indices = [idx for idx in indices if idx not in payloads]
        if missing_indices:
            raise ValueError(
                f"missing OHLC payloads inside replay window: {missing_indices}"
            )
        signal_indices_outside_window = sorted(set(signals) - set(indices))
        if signal_indices_outside_window:
            raise ValueError(
                "signals outside replay window: "
                f"{signal_indices_outside_window}"
            )
    else:
        # Preserve the small in-memory unit-test/API documents that predate
        # replay-window provenance.  Formal exported artifacts always carry
        # the explicit window above.
        indices = sorted(payloads)
    bars_by_idx = {idx: payloads[idx]["bar"] for idx in indices}
    excluded_entry_indices, entry_session_filter = compute_entry_session_filter(
        document, payloads, session_filter
    )
    position: dict[str, Any] | None = None
    pending: dict[str, Any] | None = None
    pending_opposite_exit: dict[str, Any] | None = None
    trades: list[dict[str, Any]] = []
    signal_events: list[dict[str, Any]] = []
    counters: Counter[str] = Counter(raw_signals=len(signals))

    for idx in indices:
        bar = payloads[idx]["bar"]
        entered_this_bar = False

        if position is None and pending is not None:
            pending_signal = pending["signal"]
            signal_event = signal_events[pending["event_index"]]
            pending_kind = pending.get("kind", "flat")
            pending_entry_plan = pending_signal["trade_plan"]["entry"]
            expected_idx = int(pending_entry_plan["valid_bar_idx"])
            signal_event["entry_kind"] = pending_kind
            signal_event["entry_window_idx"] = expected_idx
            if idx < expected_idx:
                raise ValueError(f"pending entry expected idx={expected_idx}, reached idx={idx}")
            if expected_idx in excluded_entry_indices:
                counters["scheduled_entries_expired"] += 1
                counters[f"{pending_kind}_entries_expired"] += 1
                counters["entry_session_boundary_blocked"] += 1
                signal_event["entry_outcome"] = "EXPIRED_SESSION_BOUNDARY"
                signal_event["entry_outcome_detail"] = (
                    "SESSION_BOUNDARY_ENTRY_BLOCKED"
                )
                signal_event["entry_price"] = None
                signal_event["entry_session_filter"] = entry_session_filter["rule"]
                pending = None
            elif pending_entry_plan.get("mode") == RANGE_BREAKOUT_ENTRY_MODE:
                outcome, fill, entered_at_open, detail = advance_range_breakout_pending(
                    pending, idx, bar
                )
                signal_event["entry_outcome_detail"] = detail
                signal_event["entry_machine_state"] = dict(pending.get("entry_state") or {})
                if outcome == "waiting":
                    signal_event["entry_outcome"] = "PENDING"
                elif outcome == "triggered":
                    assert fill is not None
                    position = make_position(
                        pending_signal,
                        idx,
                        bar,
                        fill,
                        entered_at_open,
                        risk_usd=risk_usd,
                        trailing_activation_usd=trailing_activation_usd,
                        trailing_distance_usd=trailing_distance_usd,
                    )
                    counters["scheduled_entries_triggered"] += 1
                    counters[f"{pending_kind}_entries_triggered"] += 1
                    entered_this_bar = True
                    signal_event["entry_outcome"] = "TRIGGERED"
                    signal_event["entry_price"] = number(fill)
                    pending = None
                else:
                    counters["scheduled_entries_expired"] += 1
                    counters[f"{pending_kind}_entries_expired"] += 1
                    signal_event["entry_outcome"] = "EXPIRED_UNTRIGGERED"
                    signal_event["entry_price"] = None
                    pending = None
            elif idx == expected_idx:
                triggered, fill, entered_at_open = entry_observation(
                    pending_signal, bar, entry_confirmation_mode
                )
                if triggered:
                    assert fill is not None
                    position = make_position(
                        pending_signal,
                        idx,
                        bar,
                        fill,
                        entered_at_open,
                        risk_usd=risk_usd,
                        trailing_activation_usd=trailing_activation_usd,
                        trailing_distance_usd=trailing_distance_usd,
                    )
                    counters["scheduled_entries_triggered"] += 1
                    counters[f"{pending_kind}_entries_triggered"] += 1
                    entered_this_bar = True
                    signal_event["entry_outcome"] = "TRIGGERED"
                    signal_event["entry_outcome_detail"] = (
                        "REVERSE_ENTRY_TRIGGERED"
                        if pending_kind == "reverse"
                        else "FLAT_ENTRY_TRIGGERED"
                    )
                    signal_event["entry_price"] = number(fill)
                else:
                    counters["scheduled_entries_expired"] += 1
                    counters[f"{pending_kind}_entries_expired"] += 1
                    signal_event["entry_outcome"] = "EXPIRED_UNTRIGGERED"
                    signal_event["entry_outcome_detail"] = (
                        "REVERSE_ENTRY_EXPIRED_UNTRIGGERED"
                        if pending_kind == "reverse"
                        else "FLAT_ENTRY_EXPIRED_UNTRIGGERED"
                    )
                    signal_event["entry_price"] = None
                pending = None
            else:
                # A strict one-bar plan cannot fill on a later bar.  This is
                # normally the final signal with no idx+1 payload, but also
                # handles a sparse payload map without inventing a fill.
                counters["scheduled_entries_expired"] += 1
                counters[f"{pending_kind}_entries_expired"] += 1
                signal_event["entry_outcome"] = "EXPIRED_NO_NEXT_BAR"
                signal_event["entry_outcome_detail"] = (
                    "REVERSE_ENTRY_EXPIRED_NO_NEXT_BAR"
                    if pending_kind == "reverse"
                    else "FLAT_ENTRY_EXPIRED_NO_NEXT_BAR"
                )
                signal_event["entry_price"] = None
                pending = None

        if position is not None:
            if has_ohlc_order_ambiguity(position, bar, is_entry_bar=entered_this_bar):
                counters["ambiguous_ohlc_events"] += 1
                position["had_ambiguous_ohlc_order"] = True
            exit_result = level_exit(position, bar, is_entry_bar=entered_this_bar, policy=policy)
            if exit_result is not None:
                exit_price, reason, ambiguous = exit_result
                trades.append(
                    close_trade(
                        position,
                        exit_idx=idx,
                        exit_bar=bar,
                        exit_price=exit_price,
                        exit_reason=reason,
                        ambiguous_ohlc_order=ambiguous,
                    )
                )
                position = None
            elif position is not None:
                structure_result = custom_structure_exit(position, bar, bar_idx=idx)
                if structure_result is not None:
                    exit_price, reason = structure_result
                    trades.append(
                        close_trade(
                            position,
                            exit_idx=idx,
                            exit_bar=bar,
                            exit_price=exit_price,
                            exit_reason=reason,
                            ambiguous_ohlc_order=False,
                        )
                )
                    position = None

        if position is None and pending_opposite_exit is not None:
            # A stop or structural exit has priority over an opposite-signal
            # confirmation on the same bar.  Keep the pending signal fully
            # auditable instead of silently dropping it.
            pending_event = signal_events[pending_opposite_exit["event_index"]]
            pending_event["exit_confirmation_outcome"] = "CANCELED_BY_LEVEL_EXIT"
            pending_event["exit_confirmation_idx"] = idx
            counters["opposite_signals_confirmation_canceled_by_level_exit"] += 1
            pending_opposite_exit = None
        elif position is not None and pending_opposite_exit is not None:
            expected_idx = int(pending_opposite_exit["valid_bar_idx"])
            if idx != expected_idx:
                raise ValueError(
                    f"pending opposite exit expected idx={expected_idx}, reached idx={idx}"
                )
            pending_event = signal_events[pending_opposite_exit["event_index"]]
            triggered, fill = opposite_exit_observation(pending_opposite_exit, bar)
            pending_event["exit_confirmation_idx"] = idx
            pending_event["exit_confirmation_bar_open_time"] = int(bar["open_time"])
            if triggered:
                assert fill is not None
                trades.append(
                    close_trade(
                        position,
                        exit_idx=idx,
                        exit_bar=bar,
                        exit_price=fill,
                        exit_reason="OPPOSITE_SIGNAL_NEXT_BAR_BREAK",
                        ambiguous_ohlc_order=False,
                        exit_signal_idx=int(pending_opposite_exit["signal_idx"]),
                        exit_signal_bar_open_time=int(
                            pending_opposite_exit["signal_bar_open_time"]
                        ),
                    )
                )
                pending_event["exit_confirmation_outcome"] = "CONFIRMED_NEXT_BAR_BREAK"
                pending_event["closed_trade_number"] = len(trades)
                pending_event["exit_price"] = number(fill)
                counters["opposite_signals_confirmed_to_close"] += 1
                position = None
            else:
                pending_event["exit_confirmation_outcome"] = "EXPIRED_UNTRIGGERED"
                counters["opposite_signals_confirmation_expired"] += 1
            pending_opposite_exit = None

        signal = signals.get(idx)
        if signal is not None:
            side = signal_side(signal)
            signal_event = {
                "signal_idx": idx,
                "signal_bar_open_time": int(signal["bar_open_time"]),
                "signal_side": side,
                "setup": signal.get("setup"),
                "signal_family": signal.get("trade_plan", {}).get("signal_family"),
                "position_side_before_signal_close": position["side"] if position is not None else None,
            }
            if position is None:
                pending_same_side = (
                    pending is not None
                    and signal_side(pending["signal"]) == side
                )
                if pending_same_side:
                    signal_event["action"] = "IGNORE_SAME_SIDE_WHILE_ENTRY_PENDING"
                    signal_event["entry_outcome"] = "NOT_EVALUATED"
                    signal_event["entry_kind"] = None
                    signal_events.append(signal_event)
                    counters["same_side_signals_ignored_while_pending"] += 1
                else:
                    if pending is not None:
                        old_kind = pending.get("kind", "flat")
                        old_event = signal_events[pending["event_index"]]
                        old_event["entry_outcome"] = "EXPIRED_CANCELED_BY_OPPOSITE_SIGNAL"
                        old_event["entry_outcome_detail"] = "PENDING_ENTRY_CANCELED_BY_NEW_OPPOSITE_SIGNAL"
                        old_event["entry_price"] = None
                        counters["scheduled_entries_expired"] += 1
                        counters[f"{old_kind}_entries_expired"] += 1
                        pending = None
                    signal_event["action"] = (
                        "SCHEDULE_RANGE_BREAKOUT_ENTRY_MACHINE"
                        if signal["trade_plan"]["entry"].get("mode") == RANGE_BREAKOUT_ENTRY_MODE
                        else "SCHEDULE_NEXT_BAR_ENTRY"
                    )
                    signal_event["entry_outcome"] = "PENDING"
                    signal_event["entry_kind"] = "flat"
                    signal_event["pending_entry_kind"] = "flat"
                    signal_events.append(signal_event)
                    pending = {
                        "signal": signal,
                        "event_index": len(signal_events) - 1,
                        "kind": "flat",
                    }
                    counters["flat_signals_scheduled"] += 1
            elif position["side"] == side:
                signal_event["action"] = "IGNORE_SAME_SIDE_WHILE_OPEN"
                signal_event["entry_outcome"] = "NOT_EVALUATED"
                signal_event["entry_kind"] = None
                signal_events.append(signal_event)
                counters["same_side_signals_ignored"] += 1
            else:
                counters["opposite_signals_handled"] += 1
                if opposite_signal_mode == OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE:
                    signal_event["action"] = "SCHEDULE_OPPOSITE_EXIT_NEXT_BAR_BREAK"
                    signal_event["entry_outcome"] = "PENDING"
                    signal_event["entry_outcome_detail"] = (
                        "OPPOSITE_EXIT_PENDING_NEXT_BAR_STRICT_BREAK"
                    )
                    signal_event["entry_kind"] = None
                    signal_event["exit_confirmation_idx"] = idx + 1
                    signal_event["exit_trigger_price"] = number(
                        dec(bar["low"] if position["side"] == "long" else bar["high"])
                    )
                    signal_events.append(signal_event)
                    pending_opposite_exit = {
                        "signal_idx": idx,
                        "signal_bar_open_time": int(bar["open_time"]),
                        "position_side": position["side"],
                        "trigger_price": number(
                            dec(bar["low"] if position["side"] == "long" else bar["high"])
                        ),
                        "valid_bar_idx": idx + 1,
                        "event_index": len(signal_events) - 1,
                    }
                    counters["opposite_signals_scheduled_for_confirmation"] += 1
                else:
                    trades.append(
                        close_trade(
                            position,
                            exit_idx=idx,
                            exit_bar=bar,
                            exit_price=dec(bar["close"]),
                            exit_reason="OPPOSITE_SIGNAL_CLOSE",
                            ambiguous_ohlc_order=False,
                        )
                    )
                    signal_event["closed_trade_number"] = len(trades)
                    counters["opposite_signals_used_to_close"] += 1
                    position = None
                    if opposite_signal_mode == "close_and_reverse_next_bar":
                        signal_event["action"] = (
                            "CLOSE_OPPOSITE_POSITION_AND_SCHEDULE_REVERSAL_NEXT_BAR"
                        )
                        signal_event["entry_outcome"] = "PENDING"
                        signal_event["entry_outcome_detail"] = "REVERSE_ENTRY_PENDING_NEXT_BAR"
                        signal_event["entry_kind"] = "reverse"
                        signal_event["pending_entry_kind"] = "reverse"
                        signal_event["entry_window_idx"] = int(
                            signal["trade_plan"]["entry"]["valid_bar_idx"]
                        )
                        signal_events.append(signal_event)
                        pending = {
                            "signal": signal,
                            "event_index": len(signal_events) - 1,
                            "kind": "reverse",
                        }
                        counters["opposite_signals_scheduled_for_reversal"] += 1
                    else:
                        signal_event["action"] = "CLOSE_OPPOSITE_POSITION"
                        signal_event["entry_outcome"] = "CONSUMED_AS_EXIT_NO_REVERSAL"
                        signal_event["entry_kind"] = None
                        signal_events.append(signal_event)

        # The newly computed line is intentionally not checked against this
        # bar.  It is effective from the next bar only.
        if position is not None and idx != indices[-1]:
            update_custom_structure_exit_after_close(position, bar, bar_idx=idx)
            update_trailing_stop(
                position,
                bar,
                bar_idx=idx,
                bars_by_idx=bars_by_idx,
            )

    if pending is not None:
        pending_kind = pending.get("kind", "flat")
        counters["scheduled_entries_expired"] += 1
        counters[f"{pending_kind}_entries_expired"] += 1
        signal_event = signal_events[pending["event_index"]]
        signal_event["entry_kind"] = pending_kind
        signal_event["entry_window_idx"] = int(
            pending["signal"]["trade_plan"]["entry"]["valid_bar_idx"]
        )
        is_range_machine = (
            pending["signal"]["trade_plan"]["entry"].get("mode")
            == RANGE_BREAKOUT_ENTRY_MODE
        )
        signal_event["entry_outcome"] = (
            "EXPIRED_END_OF_DATA" if is_range_machine else "EXPIRED_NO_NEXT_BAR"
        )
        signal_event["entry_outcome_detail"] = (
            "RANGE_BREAKOUT_ENTRY_MACHINE_EXPIRED_END_OF_DATA"
            if is_range_machine
            else (
                "REVERSE_ENTRY_EXPIRED_NO_NEXT_BAR"
                if pending_kind == "reverse"
                else "FLAT_ENTRY_EXPIRED_NO_NEXT_BAR"
            )
        )
        signal_event["entry_price"] = None
        pending = None
    if pending_opposite_exit is not None:
        signal_event = signal_events[pending_opposite_exit["event_index"]]
        signal_event["exit_confirmation_outcome"] = "EXPIRED_NO_NEXT_BAR"
        signal_event["exit_confirmation_idx"] = pending_opposite_exit["valid_bar_idx"]
        counters["opposite_signals_confirmation_expired_no_next_bar"] += 1
        pending_opposite_exit = None
    if position is not None:
        final_idx = indices[-1]
        final_bar = payloads[final_idx]["bar"]
        trades.append(
            close_trade(
                position,
                exit_idx=final_idx,
                exit_bar=final_bar,
                exit_price=dec(final_bar["close"]),
                exit_reason="END_OF_DATA_MARK_TO_MARKET",
                ambiguous_ohlc_order=False,
            )
        )

    handled_signals = (
        counters["flat_signals_scheduled"]
        + counters["same_side_signals_ignored"]
        + counters["same_side_signals_ignored_while_pending"]
        + counters["opposite_signals_handled"]
    )
    if handled_signals != counters["raw_signals"]:
        raise ValueError(f"signal accounting mismatch: handled={handled_signals}, raw={counters['raw_signals']}")
    counters["reverse_entries_planned"] = counters[
        "opposite_signals_scheduled_for_reversal"
    ]
    counters["flat_entries_planned"] = counters["flat_signals_scheduled"]
    counters["scheduled_entries_planned"] = (
        counters["flat_entries_planned"] + counters["reverse_entries_planned"]
    )
    if (
        counters["scheduled_entries_triggered"]
        + counters["scheduled_entries_expired"]
        != counters["scheduled_entries_planned"]
    ):
        raise ValueError("entry accounting does not match scheduled entry plans")
    if (
        counters["flat_entries_triggered"] + counters["flat_entries_expired"]
        != counters["flat_entries_planned"]
    ):
        raise ValueError("flat entry accounting does not match scheduled flat signals")
    if (
        counters["reverse_entries_triggered"] + counters["reverse_entries_expired"]
        != counters["reverse_entries_planned"]
    ):
        raise ValueError("reverse entry accounting does not match scheduled reversals")

    for number_, trade in enumerate(trades, start=1):
        trade["trade_number"] = number_
    cumulative = ZERO
    for trade in trades:
        cumulative += dec(trade["pnl_price_units"])
        trade["cumulative_gross_pnl_price_units"] = number(cumulative)

    exit_rule_config = {
        "fixed_take_profit": None,
        "no_fixed_take_profit_at_entry": True,
        "custom_v2_structural_exits": [
            "failed_breakout_next_bar_break",
            "range_reacceptance_then_touch",
        ],
        "trailing_rule": STRUCTURAL_TRAILING_RULE,
        "trailing_activation_usd": None,
        "trailing_distance_usd": None,
        "trailing_update_timing": "closed_bar_confirmation_effective_next_bar",
        "trailing_breakout": "directional_close_strictly_beyond_running_post_entry_extreme_and_new_favorable_wick_extreme",
        "trailing_structure": "later_three_bar_risk_side_pivot_confirmed_by_right_bar_close",
        "trailing_structure_gate": "risk_side_pivot_may_ratchet_only_after_a_later_favorable_wick_strictly_breaks_the_preceding_confirmed_opposite_side_pivot",
        "trailing_ratchet": "long_only_higher_or_short_only_lower; never_loosen",
        "opposite_signal_mode": opposite_signal_mode,
        "entry_confirmation_mode": entry_confirmation_mode,
        "opposite_signal_confirmation": (
            "immediate_next_bar_strict_break_of_opposite_signal_bar_low_for_long_close_or_high_for_short_close"
            if opposite_signal_mode == OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE
            else None
        ),
        "opposite_signal_exit_fill": (
            "long_close=min(opposite_signal_bar_low,next_bar_open); short_close=max(opposite_signal_bar_high,next_bar_open)"
            if opposite_signal_mode == OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE
            else None
        ),
        "entry_session_filter": entry_session_filter,
    }
    summary = summarize(
        trades,
        counters,
        opposite_signal_mode=opposite_signal_mode,
    )
    summary["exit_rule_config"] = exit_rule_config
    summary["entry_session_filter"] = entry_session_filter
    return {
        "intrabar_policy": policy,
        "opposite_signal_mode": opposite_signal_mode,
        "entry_confirmation_mode": entry_confirmation_mode,
        "entry_session_filter": entry_session_filter,
        "exit_rule_config": exit_rule_config,
        "summary": summary,
        "signal_events": signal_events,
        "trades": trades,
    }


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
    parser.add_argument("--risk-usd", type=Decimal, default=DEFAULT_RISK_USD)
    parser.add_argument(
        "--trailing-activation-usd",
        type=Decimal,
        default=DEFAULT_TRAILING_ACTIVATION_USD,
        help="Deprecated compatibility option; ignored by the structural V4/V5 trailing rule.",
    )
    parser.add_argument(
        "--trailing-distance-usd",
        type=Decimal,
        default=DEFAULT_TRAILING_DISTANCE_USD,
        help="Deprecated compatibility option; ignored by the structural V4/V5 trailing rule.",
    )
    parser.add_argument(
        "--opposite-signal-mode",
        choices=sorted(OPPOSITE_SIGNAL_MODES),
        default=None,
        help=(
            "How an opposite signal is handled while a position is open: "
            "close_only, close_and_reverse_next_bar, or next_bar_opposite_break. "
            "When omitted, rule_set_id selects the mode: legacy rules use close_only; "
            "the revised nextbar_opposite rule uses next_bar_opposite_break."
        ),
    )
    parser.add_argument(
        "--session-filter10",
        action="store_true",
        help=(
            "Block new entries during the first 10 and last 10 bars of each "
            "XAUUSD/XAGUSD/US500 trading session; existing positions remain managed."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    validate_parameters(args.risk_usd, args.trailing_activation_usd, args.trailing_distance_usd)
    payloads = load_gate_payloads(args.raw_dir / "turn_logs")
    payloads, _ = recover_missing_gate_payloads(
        args.raw_dir, payloads, args.data_file
    )
    document = json.loads(args.signals.read_text(encoding="utf-8"))
    resolved_opposite_signal_mode = (
        args.opposite_signal_mode
        if args.opposite_signal_mode is not None
        else default_opposite_signal_mode(document)
    )
    validate_opposite_signal_mode(resolved_opposite_signal_mode)
    resolved_entry_confirmation_mode = default_entry_confirmation_mode(document)
    validate_entry_confirmation_mode(resolved_entry_confirmation_mode)
    session_filter = (
        {
            "enabled": True,
            "rule": ENTRY_SESSION_FILTER10,
            "first_n_bars_after_open": 10,
            "last_n_bars_before_close": 10,
            "new_entries_only": True,
        }
        if args.session_filter10
        else None
    )
    scenarios = {
        policy: run_backtest(
            document,
            payloads,
            policy=policy,
            opposite_signal_mode=resolved_opposite_signal_mode,
            entry_confirmation_mode=resolved_entry_confirmation_mode,
            session_filter=session_filter,
            risk_usd=args.risk_usd,
            trailing_activation_usd=args.trailing_activation_usd,
            trailing_distance_usd=args.trailing_distance_usd,
        )
        for policy in sorted(POLICIES)
    }
    # ``run_backtest`` materializes an auditable disabled session-filter
    # descriptor even when the filter was not requested.  Use that same
    # effective descriptor in the document-level exit configuration so both
    # OHLC scenarios carry an identical, validator-comparable contract.
    effective_entry_session_filter = (
        next(iter(scenarios.values())).get("entry_session_filter")
        if scenarios
        else session_filter
    )
    exit_rule_config = {
        "fixed_take_profit": None,
        "no_fixed_take_profit_at_entry": True,
        "custom_v2_structural_exits": [
            "failed_breakout_next_bar_break",
            "range_reacceptance_then_touch",
        ],
        "trailing_rule": STRUCTURAL_TRAILING_RULE,
        "trailing_activation_usd": None,
        "trailing_distance_usd": None,
        "trailing_update_timing": "closed_bar_confirmation_effective_next_bar",
        "trailing_breakout": "directional_close_strictly_beyond_running_post_entry_extreme_and_new_favorable_wick_extreme",
        "trailing_structure": "later_three_bar_risk_side_pivot_confirmed_by_right_bar_close",
        "trailing_structure_gate": "risk_side_pivot_may_ratchet_only_after_a_later_favorable_wick_strictly_breaks_the_preceding_confirmed_opposite_side_pivot",
        "trailing_ratchet": "long_only_higher_or_short_only_lower; never_loosen",
        "opposite_signal_mode": resolved_opposite_signal_mode,
        "entry_confirmation_mode": resolved_entry_confirmation_mode,
        "opposite_signal_confirmation": (
            "immediate_next_bar_strict_break_of_opposite_signal_bar_low_for_long_close_or_high_for_short_close"
            if resolved_opposite_signal_mode == OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE
            else None
        ),
        "opposite_signal_exit_fill": (
            "long_close=min(opposite_signal_bar_low,next_bar_open); short_close=max(opposite_signal_bar_high,next_bar_open)"
            if resolved_opposite_signal_mode == OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE
            else None
        ),
        "entry_session_filter": effective_entry_session_filter,
    }
    for scenario in scenarios.values():
        scenario["summary"]["fixed_risk_usd"] = apply_fixed_risk_sizing(
            scenario["trades"], args.risk_usd, exit_rule_config=exit_rule_config
        )
    output = {
        "version": 2,
        "symbol": document["symbol"],
        "timeframe_minutes": document["timeframe_minutes"],
        "source_signal_mode": f"raw_non_deduplicated_{len(document['drawings'])}",
        "source_signal_file": args.signals.as_posix(),
        "source_signal_sha256": sha256(args.signals),
        "source_data_sha256": document["trade_level_enrichment"]["source_data_sha256"],
        "position_size": 1,
        "pnl_unit": f"{document['symbol']} price units per one position unit",
        "costs": {
            "spread": 0,
            "commission": 0,
            "slippage_except_ohlc_gap_fill": 0,
            "result_type": "gross",
        },
        "position_sizing": {
            "mode": "fixed_initial_stop_risk_usd",
            "planned_stop_risk_usd_per_trade": rounded_number(args.risk_usd),
            "formula": "normalized_position_units = risk_usd / abs(entry_price - initial_stop_loss); pnl_usd = normalized_position_units * signed_price_change",
            "gap_warning": "A stop gap can lose more than the planned USD risk.",
        },
        "opposite_signal_mode": resolved_opposite_signal_mode,
        "entry_confirmation_mode": resolved_entry_confirmation_mode,
        "entry_session_filter": effective_entry_session_filter,
        "exit_rule_config": exit_rule_config,
        "rules": {
            "entry": (
                "Louie requires the immediate next bar to close strictly beyond the signal-bar high/low and enters at that close; other legacy/custom V2 entry states remain unchanged."
                if resolved_entry_confirmation_mode == ENTRY_CLOSE_CONFIRMATION_MODE
                else "Louie uses the signal-close high/low and only the immediate next bar's strict breakout; other legacy/custom V2 entry states remain unchanged."
            ),
            "custom_v2_structural_exit": "A range true breakout may exit on the immediate-next-bar break after a close back through the edge zone; a range reversal may exit after wrong-side range reacceptance and later touch of that reclaim bar extreme.",
            "course_take_profit": None,
            "trailing": "After a directional strong breakout closes beyond the running post-entry extreme and makes a new favorable wick extreme, wait for a later three-bar risk-side structure pivot to be confirmed by its right bar; ratchet the line only in the protective direction after the confirming close, effective next bar.",
            "same_side_signal_while_open": "Ignore completely; do not update levels.",
            "entry_session_filter": (
                "For XAUUSD/XAGUSD/US500, block new entries in the first 10 and last 10 bars of each detected trading session; existing positions continue to be managed and exited."
                if session_filter is not None
                else None
            ),
            "opposite_signal_while_open": (
                "Schedule an exit; close only when the immediate next bar strictly breaks the opposite signal bar's risk-side extreme; otherwise expire and keep the position open."
                if resolved_opposite_signal_mode == OPPOSITE_SIGNAL_NEXT_BAR_BREAK_MODE
                else (
                    "Close at that signal bar close; consume signal; do not reverse."
                    if resolved_opposite_signal_mode == "close_only"
                    else "Close at that signal bar close, then schedule the same signal's strict breakout entry for signal_idx+1; never reverse on the signal bar."
                )
            ),
            "opposite_signal_mode": resolved_opposite_signal_mode,
            "end_of_data": "Close any open position at the final bar close.",
            "intrabar_ambiguity": "The two policies differ only on an entry-bar risk-side extreme that may have occurred before an intrabar breakout entry.",
        },
        "scenarios": scenarios,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({name: scenario["summary"] for name, scenario in scenarios.items()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
