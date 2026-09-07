#!/usr/bin/env python3
"""Causal replay MCP server that returns both text and PNG chart snapshots."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from . import chart_text_snapshot as snap
    from . import xau_causal_gate as gate
except ImportError:  # The runner copies this file into an isolated standalone work directory.
    import chart_text_snapshot as snap
    import xau_causal_gate as gate


HERE = Path(__file__).resolve().parent
GATE = HERE / "xau_causal_gate.py"
LEDGER = HERE / "ledger"
SNAPSHOT_LOG = HERE / "snapshot_log.jsonl"
SNAPSHOT_DIR = HERE / "snapshots"
MCP_DEBUG_LOG = HERE / "mcp_debug.log"
TEXT_ONLY = os.environ.get("XAU_TEXT_ONLY", "0") == "1"


def send(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def gate_call(arguments: list[str]) -> dict[str, Any]:
    env = os.environ.copy()
    # The bundled Windows Python may otherwise emit cp936 while this subprocess
    # is decoded as UTF-8 by the MCP server, yielding a false NoneType response.
    env["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, str(GATE), "--out", str(LEDGER), *arguments],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or "").strip() or (completed.stdout or "").strip()
        if not detail:
            detail = (
                f"causal gate exited with code {completed.returncode} without diagnostics; "
                f"rejected arguments={json.dumps(arguments, ensure_ascii=False, separators=(',', ':'))}"
            )
        raise RuntimeError(detail)
    return json.loads(completed.stdout)


TOOLS = [
    {
        "name": "status",
        "description": "Return the only currently released candle. No future candle is exposed.",
        "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}},
    },
    {
        "name": "commit",
        "description": "Commit the current candle decision to the hash chain; only then return the next candle.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "idx": {"type": "integer"},
                "decision": {"type": "string", "enum": ["NO_SIGNAL", "OBSERVE", "SIGNAL"]},
                "direction": {"type": "string", "enum": ["none", "long", "short"]},
                "setup": {"type": "string"},
                "reason": {"type": "string"},
                "evidence_indices": {"type": "array", "items": {"type": "integer"}},
                "signal_context": {"type": "object"},
                "case_context": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "market_state": {"type": "string", "minLength": 1},
                        "background": {"type": "string", "minLength": 1},
                        "location": {"type": "string", "minLength": 1},
                        "acceptance_follow_through": {"type": "string", "minLength": 1},
                        "trigger": {"type": "string", "minLength": 1},
                        "success_failure_boundary": {"type": "string", "minLength": 1},
                        "case_families": {
                            "type": "array",
                            "minItems": 1,
                            "uniqueItems": True,
                            "items": {
                                "type": "string",
                                "enum": [
                                    "signal_bar_entry", "pullback_count", "gap", "market_cycle",
                                    "breakout_retest_second_leg", "wedge_or_climax",
                                    "risk_or_management_context", "no_specific_case",
                                ],
                            },
                        },
                        "evidence_indices": {
                            "type": "array",
                            "minItems": 1,
                            "uniqueItems": True,
                            "items": {"type": "integer"},
                        },
                        "supplemental_case_lenses": {
                            "type": "array",
                            "minItems": 1,
                            "uniqueItems": True,
                            "items": {
                                "type": "string",
                                "enum": [
                                    "signal_context_matrix", "pullback_count_reset",
                                    "regime_transition", "channel_geometry",
                                    "breakout_acceptance_failure", "reversal_or_trap",
                                    "gap_interpretation", "trading_range_behavior",
                                    "no_additional_case",
                                ],
                            },
                        },
                        "v4_execution_unchanged": {"type": "boolean"},
                        "brooks_case_lenses": {
                            "type": "array",
                            "minItems": 1,
                            "uniqueItems": True,
                            "items": {
                                "type": "string",
                                "enum": [
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
                                ],
                            },
                        },
                        "brooks_source_families": {
                            "type": "array",
                            "minItems": 1,
                            "uniqueItems": True,
                            "items": {
                                "type": "string",
                                "enum": [
                                    "course_01_18_price_action_foundations",
                                    "course_19_29_patterns_reversals",
                                    "course_30_36_execution_management_context",
                                    "course_37_42_how_to_trade",
                                    "course_43_47_channels_ranges",
                                    "chart_encyclopedia_8800_cases",
                                    "books_bar_by_bar_trends_ranges_reversals",
                                    "no_specific_brooks_source",
                                ],
                            },
                        },
                        "v5_0818_execution_unchanged": {"type": "boolean"},
                    },
                    "required": [
                        "market_state", "background", "location", "acceptance_follow_through",
                        "trigger", "success_failure_boundary", "case_families", "evidence_indices",
                    ],
                },
                "max_used_idx": {"type": "integer"},
            },
            "required": [
                "idx", "decision", "direction", "setup", "reason",
                "evidence_indices", "max_used_idx",
            ],
        },
    },
    {
        "name": "chart_snapshot",
        "description": (
            "Return a causal chart view covering only bars 0..idx. The result includes a structured text "
            "snapshot and an actual PNG image for visual inspection. Use it only when structure may have changed."
        ),
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"idx": {"type": "integer"}},
            "required": ["idx"],
        },
    },
]


def log_event(value: dict[str, Any]) -> None:
    with MCP_DEBUG_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def tool_result(payload: dict[str, Any], image_path: Path | None = None) -> dict[str, Any]:
    content: list[dict[str, Any]] = [
        {"type": "text", "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}
    ]
    if image_path is not None:
        content.append(
            {
                "type": "image",
                "data": base64.b64encode(image_path.read_bytes()).decode("ascii"),
                "mimeType": "image/png",
            }
        )
    return {"content": content, "structuredContent": payload, "isError": False}


def snapshot_indicator_audit(bars: list[dict[str, Any]], idx: int, text: str) -> dict[str, Any]:
    indicator_keys = [key for key in ("ema20", "ema50") if key in bars[idx]]
    return {
        "indicator_keys": indicator_keys,
        "ema50_exposed": "EMA50=" in text or "ema50" in bars[idx],
    }


def chart_snapshot(idx: int) -> tuple[dict[str, Any], Path | None]:
    state = json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))
    next_idx = int(state["next_idx"])
    if idx < 0 or idx > next_idx:
        raise ValueError(f"chart_snapshot idx must be in [0, {next_idx}], got {idx}")
    payload, raw = gate.load_data(gate.DEFAULT_DATA)
    timeframe_minutes = int(payload["timeframe_minutes"])
    symbol = str(payload["symbol"])
    bars = gate.enrich(raw, timeframe_minutes)
    text = snap.build_snapshot_text(
        bars,
        idx,
        symbol=symbol,
        timeframe_minutes=timeframe_minutes,
    )
    png = None if TEXT_ONLY else snap.render_png(
        bars,
        idx,
        SNAPSHOT_DIR / f"snapshot_{idx:04d}.png",
        symbol=symbol,
        timeframe_minutes=timeframe_minutes,
    )
    indicator_audit = snapshot_indicator_audit(bars, idx, text)
    entry = {
        "idx": idx,
        "at_epoch": int(datetime.now(timezone.utc).timestamp()),
        "text_chars": len(text),
        "png": str(png) if png is not None else None,
        "image_delivered": not TEXT_ONLY,
        **indicator_audit,
    }
    with SNAPSHOT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {
        "idx": idx,
        "text": text,
        "png": str(png) if png is not None else None,
        "image_delivered": not TEXT_ONLY,
        "saved": True,
        **indicator_audit,
    }, png


def has_delivered_png_for_idx(idx: int) -> bool:
    if TEXT_ONLY or not SNAPSHOT_LOG.is_file():
        return False
    expected_parent = SNAPSHOT_DIR.resolve()
    for line in reversed(SNAPSHOT_LOG.read_text(encoding="utf-8").splitlines()):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if int(entry.get("idx", -1)) != idx or entry.get("image_delivered") is not True:
            continue
        png_value = entry.get("png")
        if not png_value:
            continue
        png = Path(png_value)
        try:
            if png.resolve().parent != expected_parent or not png.is_file():
                continue
            with png.open("rb") as handle:
                if handle.read(8) == b"\x89PNG\r\n\x1a\n":
                    return True
        except OSError:
            continue
    return False


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    log_event({"at": datetime.now(timezone.utc).timestamp(), "method": method, "request_id": request_id})
    if request_id is None:
        return None
    if method == "initialize":
        version = request.get("params", {}).get("protocolVersion", "2025-06-18")
        result: dict[str, Any] = {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "xau-causal-luna-image-gate", "version": "1.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "resources/list":
        result = {"resources": []}
    elif method == "prompts/list":
        result = {"prompts": []}
    elif method == "tools/call":
        params = request.get("params", {})
        name = params.get("name")
        args = params.get("arguments") or {}
        try:
            if name == "status":
                result = tool_result(gate_call(["status"]))
            elif name == "commit":
                if args.get("decision") == "SIGNAL" and not has_delivered_png_for_idx(int(args["idx"])):
                    raise ValueError(
                        f"SIGNAL commit rejected at idx={args['idx']}: call chart_snapshot for this idx "
                        "and inspect the delivered image/png before retrying commit"
                    )
                evidence = ",".join(str(value) for value in args["evidence_indices"])
                signal_context = json.dumps(
                    args.get("signal_context") or {},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ) if "signal_context" in args else ""
                case_context = json.dumps(
                    args.get("case_context") or {},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ) if "case_context" in args else ""
                result = tool_result(
                    gate_call(
                        [
                            "step", "--idx", str(args["idx"]), "--decision", str(args["decision"]),
                            "--direction", str(args["direction"]), "--setup", str(args["setup"]),
                            "--reason", str(args["reason"]), "--evidence", evidence,
                            "--signal-context", signal_context,
                            "--case-context", case_context,
                            "--max-used-idx", str(args["max_used_idx"]),
                        ]
                    )
                )
            elif name == "chart_snapshot":
                payload, png = chart_snapshot(int(args["idx"]))
                result = tool_result(payload, png)
            else:
                raise ValueError(f"unknown tool: {name}")
        except Exception as exc:
            log_event({"at": datetime.now(timezone.utc).timestamp(), "request_id": request_id, "tool_error": str(exc)})
            result = {"content": [{"type": "text", "text": f"causal gate rejected call: {exc}"}], "isError": True}
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    log_event({"done_at": datetime.now(timezone.utc).timestamp(), "request_id": request_id, "ok": not result.get("isError", False)})
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            response = handle(json.loads(line))
            if response is not None:
                send(response)
        except Exception as exc:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(exc)}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
