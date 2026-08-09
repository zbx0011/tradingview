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


def chart_snapshot(idx: int) -> tuple[dict[str, Any], Path | None]:
    state = json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))
    next_idx = int(state["next_idx"])
    if idx < 0 or idx > next_idx:
        raise ValueError(f"chart_snapshot idx must be in [0, {next_idx}], got {idx}")
    _, raw = gate.load_data(gate.DEFAULT_DATA)
    bars = gate.enrich(raw)
    text = snap.build_snapshot_text(bars, idx)
    png = None if TEXT_ONLY else snap.render_png(bars, idx, SNAPSHOT_DIR / f"snapshot_{idx:04d}.png")
    entry = {
        "idx": idx,
        "at_epoch": int(datetime.now(timezone.utc).timestamp()),
        "text_chars": len(text),
        "png": str(png) if png is not None else None,
        "image_delivered": not TEXT_ONLY,
    }
    with SNAPSHOT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {
        "idx": idx,
        "text": text,
        "png": str(png) if png is not None else None,
        "image_delivered": not TEXT_ONLY,
        "saved": True,
    }, png


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
                evidence = ",".join(str(value) for value in args["evidence_indices"])
                result = tool_result(
                    gate_call(
                        [
                            "step", "--idx", str(args["idx"]), "--decision", str(args["decision"]),
                            "--direction", str(args["direction"]), "--setup", str(args["setup"]),
                            "--reason", str(args["reason"]), "--evidence", evidence,
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
