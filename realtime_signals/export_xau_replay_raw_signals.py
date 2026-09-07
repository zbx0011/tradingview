#!/usr/bin/env python3
"""Export every raw SIGNAL in a completed causal replay ledger."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    manifest = read_json(args.raw_dir / "manifest.json")
    progress = read_json(args.raw_dir / "orchestrator_progress.json")
    if progress.get("status") != "complete":
        raise ValueError("causal replay is not complete")
    if manifest["data_sha256"] != progress["data_sha256"]:
        raise ValueError("manifest and orchestrator data hashes differ")

    decisions = [
        json.loads(line)
        for line in (args.raw_dir / "decisions.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    expected = list(range(int(progress["start_idx"]), int(progress["end_idx_exclusive"])))
    if [int(row["idx"]) for row in decisions] != expected:
        raise ValueError("decision ledger is not the exact contiguous replay interval")

    side_by_direction = {"long": "L", "short": "S"}
    drawings: list[dict[str, Any]] = []
    for row in decisions:
        if row.get("decision") != "SIGNAL":
            continue
        direction = row.get("direction")
        if direction not in side_by_direction:
            raise ValueError(f"invalid SIGNAL direction at idx={row['idx']}: {direction!r}")
        drawing = {
                "idx": int(row["idx"]),
                "side": side_by_direction[direction],
                "bar_open_time": int(row["bar_open_time"]),
                "beijing_open_time": row["beijing_open_time"],
                "setup": row.get("setup", ""),
                "reason": row.get("reason", ""),
                "evidence_indices": row.get("evidence_indices", []),
                "record_sha256": row["record_sha256"],
                "chain_sha256": row["chain_sha256"],
            }
        if "signal_context" in row:
            drawing["signal_context"] = row["signal_context"]
        drawings.append(drawing)

    document = {
        "version": 1,
        "symbol": manifest["symbol"],
        "timeframe_minutes": manifest["timeframe_minutes"],
        "timezone": manifest["timezone"],
        "model": progress["model"],
        "reasoning_effort": progress["reasoning_effort"],
        "service_tier": progress["service_tier"],
        "input_mode": "image/png",
        "signal_mode": "raw_non_deduplicated",
        "rule_set_key": manifest.get("rule_set_key"),
        "rule_set_id": manifest.get("rule_set_id"),
        "rule_set_sha256": manifest.get("rule_set_sha256"),
        "source_data_sha256": manifest["data_sha256"],
        "replay_window": {
            "start_idx": int(progress["start_idx"]),
            "end_idx": int(progress["end_idx_exclusive"]) - 1,
            "first_beijing_open_time": decisions[0]["beijing_open_time"],
            "last_beijing_open_time": decisions[-1]["beijing_open_time"],
            "decisions": len(decisions),
        },
        "counts": {"total": len(drawings)},
        "drawings": drawings,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"signals": len(drawings), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
