#!/usr/bin/env python3
"""Minimal stdio MCP server exposing only the XAU causal replay gate."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import chart_text_snapshot as snap
import xau_causal_gate as gate


HERE = Path(__file__).resolve().parent
GATE = HERE / "xau_causal_gate.py"
LEDGER = HERE / "ledger"
SNAPSHOT_LOG = HERE / "snapshot_log.jsonl"
SNAPSHOT_DIR = HERE / "snapshots"
MCP_DEBUG_LOG = HERE / "mcp_debug.log"


def send(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def gate_call(arguments: list[str]) -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(GATE), "--out", str(LEDGER), *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
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
                "max_used_idx": {"type": "integer"},
            },
            "required": [
                "idx", "decision", "direction", "setup", "reason",
                "evidence_indices", "max_used_idx"
            ],
        },
    },
    {
        "name": "chart_snapshot",
        "description": "Return a causal text chart view (plus archived PNG) covering only bars 0..idx. "
        "Use it only when the new candle suggests structure may have changed; normal continuation candles do not need it.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"idx": {"type": "integer"}},
            "required": ["idx"],
        },
    },
]


def tool_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}],
        "structuredContent": payload,
        "isError": False,
    }


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    started = datetime.now(timezone.utc).timestamp()
    with MCP_DEBUG_LOG.open("a", encoding="utf-8") as debug_handle:
        debug_handle.write(
            json.dumps(
                {
                    "at": started,
                    "method": request.get("method"),
                    "name": (request.get("params") or {}).get("name") if request.get("method") == "tools/call" else None,
                    "request_id": request.get("id"),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        return None
    if method == "initialize":
        version = request.get("params", {}).get("protocolVersion", "2025-06-18")
        result = {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "xau-causal-gate", "version": "1.0.0"},
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
                payload = gate_call(["status"])
            elif name == "commit":
                evidence = ",".join(str(value) for value in args["evidence_indices"])
                payload = gate_call(
                    [
                        "step",
                        "--idx", str(args["idx"]),
                        "--decision", str(args["decision"]),
                        "--direction", str(args["direction"]),
                        "--setup", str(args["setup"]),
                        "--reason", str(args["reason"]),
                        "--evidence", evidence,
                        "--max-used-idx", str(args["max_used_idx"]),
                    ]
                )
            elif name == "chart_snapshot":
                payload = chart_snapshot(int(args["idx"]))
            else:
                raise ValueError(f"unknown tool: {name}")
            result = tool_result(payload)
        except Exception as exc:  # Return an MCP tool error without exposing unrelated files.
            with MCP_DEBUG_LOG.open("a", encoding="utf-8") as debug_handle:
                debug_handle.write(
                    json.dumps(
                        {
                            "at": datetime.now(timezone.utc).timestamp(),
                            "request_id": request_id,
                            "tool_error": str(exc),
                        },
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            result = {
                "content": [{"type": "text", "text": f"causal gate rejected call: {exc}"}],
                "isError": True,
            }
    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }
    with MCP_DEBUG_LOG.open("a", encoding="utf-8") as debug_handle:
        debug_handle.write(
            json.dumps(
                {
                    "done_at": datetime.now(timezone.utc).timestamp(),
                    "elapsed": round(datetime.now(timezone.utc).timestamp() - started, 3),
                    "request_id": request_id,
                    "ok": not (result or {}).get("isError"),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def chart_snapshot(idx: int) -> dict[str, Any]:
    state = json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))
    next_idx = int(state["next_idx"])
    if idx < 0 or idx > next_idx:
        raise ValueError(f"chart_snapshot idx must be in [0, {next_idx}], got {idx}")
    _, raw = gate.load_data(gate.DEFAULT_DATA)
    bars = gate.enrich(raw)
    text = snap.build_snapshot_text(bars, idx)
    png = snap.render_png(bars, idx, SNAPSHOT_DIR / f"snapshot_{idx:04d}.png")
    entry = {
        "idx": idx,
        "at_epoch": int(datetime.now(timezone.utc).timestamp()),
        "text_chars": len(text),
        "png": str(png),
    }
    with SNAPSHOT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {"idx": idx, "text": text, "png": str(png), "saved": True}


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            response = handle(request)
            if response is not None:
                send(response)
        except Exception as exc:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(exc)}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
