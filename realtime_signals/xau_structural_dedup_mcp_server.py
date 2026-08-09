#!/usr/bin/env python3
"""One-way MCP review gate for structural de-duplication of replay signals."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import chart_text_snapshot as snap
import xau_causal_gate as gate


HERE = Path(__file__).resolve().parent
WORK = Path(os.environ["XAU_DEDUP_WORK"])
SOURCE_LEDGER = Path(os.environ["XAU_DEDUP_SOURCE_LEDGER"])
REVIEWS = WORK / "dedup_reviews.jsonl"
STATE = WORK / "review_state.json"
SNAPSHOT_LOG = WORK / "snapshot_log.jsonl"
SNAPSHOT_DIR = WORK / "snapshots"
MCP_DEBUG_LOG = WORK / "mcp_debug.log"

ALLOWED_RELATIONS = {
    "distinct_structure",
    "structure_invalidated",
    "same_structure_continuation",
    "microstructure_duplicate",
    "not_accepted",
    "late_retrigger",
    "unclear",
}


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def send(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log_event(value: dict[str, Any]) -> None:
    with MCP_DEBUG_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def load_candidates() -> list[dict[str, Any]]:
    rows = []
    for line in SOURCE_LEDGER.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            if row.get("decision") == "SIGNAL":
                rows.append(row)
    rows.sort(key=lambda row: int(row["idx"]))
    return rows


def load_state() -> dict[str, Any]:
    return json.loads(STATE.read_text(encoding="utf-8"))


def write_state(value: dict[str, Any]) -> None:
    temp = STATE.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(STATE)


def load_reviews() -> list[dict[str, Any]]:
    if not REVIEWS.exists():
        return []
    return [json.loads(line) for line in REVIEWS.read_text(encoding="utf-8").splitlines() if line.strip()]


def current_candidate() -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    candidates = load_candidates()
    state = load_state()
    position = int(state["next_candidate_position"])
    if position >= len(candidates):
        return candidates, state, {"done": True, "committed": len(candidates), "chain_sha256": state["chain_sha256"]}

    candidate = candidates[position]
    reviews = load_reviews()
    kept = [
        {
            "candidate_position": int(row["candidate_position"]),
            "idx": int(row["candidate_idx"]),
            "direction": row["candidate_direction"],
            "setup": row["candidate_setup"],
            "relation": row["relation"],
        }
        for row in reviews
        if row.get("action") == "KEEP"
    ]
    recent = [
        {
            "candidate_position": int(row["candidate_position"]),
            "idx": int(row["candidate_idx"]),
            "direction": row["candidate_direction"],
            "action": row["action"],
            "relation": row["relation"],
            "review_reason": row["review_reason"],
        }
        for row in reviews[-12:]
    ]
    _, raw_bars = gate.load_data(gate.DEFAULT_DATA)
    bars = gate.enrich(raw_bars)
    bar = bars[int(candidate["idx"])]
    payload = {
        "done": False,
        "candidate_position": position,
        "candidate_count": len(candidates),
        "candidate": {
            "idx": int(candidate["idx"]),
            "bar_open_time": int(candidate["bar_open_time"]),
            "beijing_open_time": candidate["beijing_open_time"],
            "direction": candidate["direction"],
            "setup": candidate["setup"],
            "reason": candidate["reason"],
            "original_record_sha256": candidate.get("record_sha256"),
        },
        "causal_market_bar": {
            "idx": int(bar["idx"]),
            "open_time": int(bar["time"]),
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
            "volume": int(bar.get("volume") or 0),
            "ema20": round(float(bar["ema20"]), 6),
            "ema50": round(float(bar["ema50"]), 6),
            "atr14": round(float(bar["atr14"]), 6),
        },
        "prior_kept_signals": kept[-12:],
        "recent_review_history": recent,
        "structural_dedup_rule": (
            "This is not a fixed time cooldown. Keep only a distinct structural thesis/leg. "
            "A later same-direction continuation, retest, second push, or micro-break inside an "
            "unbroken structure is REMOVE. A reverse direction is KEEP only after the prior thesis "
            "is clearly invalidated and the opposite side is accepted/followed-through."
        ),
    }
    return candidates, state, payload


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


def chart_snapshot(idx: int) -> tuple[dict[str, Any], Path]:
    _, _, current = current_candidate()
    if current.get("done"):
        raise ValueError("no candidate remains")
    current_idx = int(current["candidate"]["idx"])
    if idx < 0 or idx > current_idx:
        raise ValueError(f"chart_snapshot idx must be <= current candidate idx {current_idx}")
    _, raw = gate.load_data(gate.DEFAULT_DATA)
    bars = gate.enrich(raw)
    text = snap.build_snapshot_text(bars, idx)
    png = snap.render_png(bars, idx, SNAPSHOT_DIR / f"snapshot_{idx:04d}.png")
    entry = {
        "candidate_position": int(current["candidate_position"]),
        "idx": idx,
        "at_epoch": int(datetime.now(timezone.utc).timestamp()),
        "text_chars": len(text),
        "png": str(png),
        "image_delivered": True,
    }
    with SNAPSHOT_LOG.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {"candidate_position": current["candidate_position"], "idx": idx, "text": text, "image_delivered": True}, png


def commit_review(args: dict[str, Any]) -> dict[str, Any]:
    candidates, state, current = current_candidate()
    if current.get("done"):
        raise ValueError("all candidates already reviewed")
    position = int(args["candidate_position"])
    idx = int(args["idx"])
    action = str(args["action"])
    relation = str(args["relation"])
    reason = str(args["review_reason"]).strip()
    if position != int(current["candidate_position"]):
        raise ValueError(f"expected candidate_position={current['candidate_position']}, got {position}")
    if idx != int(current["candidate"]["idx"]):
        raise ValueError(f"expected idx={current['candidate']['idx']}, got {idx}")
    if action not in {"KEEP", "REMOVE"}:
        raise ValueError("action must be KEEP or REMOVE")
    if relation not in ALLOWED_RELATIONS:
        raise ValueError(f"relation must be one of {sorted(ALLOWED_RELATIONS)}")
    if not reason:
        raise ValueError("review_reason must not be blank")
    if action == "KEEP" and relation not in {"distinct_structure", "structure_invalidated"}:
        raise ValueError("KEEP requires distinct_structure or structure_invalidated")
    if action == "REMOVE" and relation in {"distinct_structure", "structure_invalidated"}:
        raise ValueError("REMOVE requires a duplicate/unclear relation")

    candidate = candidates[position]
    record = {
        "candidate_position": position,
        "candidate_idx": idx,
        "candidate_direction": candidate["direction"],
        "candidate_setup": candidate["setup"],
        "action": action,
        "relation": relation,
        "review_reason": reason,
        "causal_cutoff_idx": idx,
        "no_future_data": True,
        "previous_chain_sha256": state["chain_sha256"],
    }
    record_sha = hashlib.sha256(canonical(record)).hexdigest()
    chain = hashlib.sha256((state["chain_sha256"] + record_sha).encode("ascii")).hexdigest()
    record["record_sha256"] = record_sha
    record["chain_sha256"] = chain
    with REVIEWS.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    state["next_candidate_position"] = position + 1
    state["chain_sha256"] = chain
    write_state(state)
    return current_candidate()[2]


TOOLS = [
    {
        "name": "status",
        "description": "Release only the next candidate signal and prior kept-structure context.",
        "inputSchema": {"type": "object", "additionalProperties": False, "properties": {}},
    },
    {
        "name": "commit",
        "description": "Commit KEEP or REMOVE for the currently released candidate; then release the next one.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "candidate_position": {"type": "integer"},
                "idx": {"type": "integer"},
                "action": {"type": "string", "enum": ["KEEP", "REMOVE"]},
                "relation": {"type": "string", "enum": sorted(ALLOWED_RELATIONS)},
                "review_reason": {"type": "string"},
            },
            "required": ["candidate_position", "idx", "action", "relation", "review_reason"],
        },
    },
    {
        "name": "chart_snapshot",
        "description": "Return text and an actual PNG using only bars <= the current candidate idx.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"idx": {"type": "integer"}},
            "required": ["idx"],
        },
    },
]


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    log_event({"at": datetime.now(timezone.utc).timestamp(), "method": method, "request_id": request_id})
    if request_id is None:
        return None
    try:
        if method == "initialize":
            version = request.get("params", {}).get("protocolVersion", "2025-06-18")
            result = {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "xau-structural-dedup-review", "version": "1.0.0"},
            }
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method in {"resources/list", "prompts/list"}:
            result = {"resources": []} if method == "resources/list" else {"prompts": []}
        elif method == "tools/call":
            params = request.get("params", {})
            name = params.get("name")
            args = params.get("arguments") or {}
            if name == "status":
                result = tool_result(current_candidate()[2])
            elif name == "commit":
                result = tool_result(commit_review(args))
            elif name == "chart_snapshot":
                payload, png = chart_snapshot(int(args["idx"]))
                result = tool_result(payload, png)
            else:
                raise ValueError(f"unknown tool: {name}")
        else:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
        log_event({"done_at": datetime.now(timezone.utc).timestamp(), "request_id": request_id, "ok": True})
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except Exception as exc:
        log_event({"at": datetime.now(timezone.utc).timestamp(), "request_id": request_id, "tool_error": str(exc)})
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": f"structural dedup gate rejected call: {exc}"}], "isError": True},
        }


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
