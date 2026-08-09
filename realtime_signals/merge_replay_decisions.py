#!/usr/bin/env python3
# louie规则回放（20260806版本）
"""Merge per-batch verdict overrides into a complete per-bar decisions JSONL."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BEIJING = timezone(timedelta(hours=8))


def idx_to_time(batch_file: Path) -> dict[int, int]:
    mapping: dict[int, int] = {}
    in_batch = False
    for line in batch_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("BATCH:"):
            in_batch = True
            continue
        if in_batch and line and line[0].isdigit():
            parts = line.split()
            if len(parts) >= 7 and parts[0].isdigit():
                mapping[int(parts[0])] = int(
                    datetime.strptime(
                        f"2026 {parts[1]} {parts[2]}", "%Y %m-%d %H:%M"
                    ).replace(tzinfo=BEIJING).timestamp()
                )
    return mapping


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--base",
        type=Path,
        default=ROOT / "outputs" / "xagusd_replay_5m",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "outputs" / "xagusd_replay_5m_decisions.jsonl",
    )
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--effort", default="xhigh")
    args = parser.parse_args()
    base = args.base if args.base.is_absolute() else ROOT / args.base
    output = args.output if args.output.is_absolute() else ROOT / args.output
    manifest_payload = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    manifest = (
        manifest_payload["batches"]
        if isinstance(manifest_payload, dict)
        else manifest_payload
    )
    metadata_path = base / "review_metadata.json"
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("model") != args.model or metadata.get("reasoning_effort") != args.effort:
            raise SystemExit(
                "review metadata does not match --model/--effort: "
                f"{metadata.get('model')}/{metadata.get('reasoning_effort')}"
            )
    all_decisions: list[dict] = []
    for batch in manifest:
        no = batch["batch"]
        skeleton = json.loads(
            (base / f"batch_{no:03d}_decisions.json").read_text(encoding="utf-8")
        )
        skeleton_by_time = {int(d["t"]): d for d in skeleton}
        overrides_path = base / f"overrides_batch_{no:03d}.json"
        overrides = (
            json.loads(overrides_path.read_text(encoding="utf-8"))
            if overrides_path.exists()
            else []
        )
        mapping = idx_to_time(base / batch["file"])
        for item in overrides:
            t = int(item.get("t") or mapping.get(int(item["idx"]), 0))
            if t not in skeleton_by_time:
                raise SystemExit(f"override time {t} not in batch {no}")
            merged = skeleton_by_time[t]
            merged["v"] = item["v"]
            for key in ("d", "p", "s", "r", "a", "g"):
                if key in item:
                    merged[key] = item[key]
        for d in skeleton:
            if d["v"] not in {"N", "O", "S"}:
                raise SystemExit(f"invalid verdict in batch {no}: {d}")
            d["model"] = args.model
            d["reasoning_effort"] = args.effort
            all_decisions.append(d)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as f:
        for d in all_decisions:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
    signals = [d for d in all_decisions if d["v"] == "S"]
    print(
        json.dumps(
            {
                "total": len(all_decisions),
                "signals": len(signals),
                "observe": sum(1 for d in all_decisions if d["v"] == "O"),
                "no_signal": sum(1 for d in all_decisions if d["v"] == "N"),
                "model": args.model,
                "reasoning_effort": args.effort,
                "out": str(output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
