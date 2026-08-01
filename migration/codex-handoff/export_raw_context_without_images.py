#!/usr/bin/env python3
"""Stream a Codex rollout JSONL and remove embedded image payload bytes.

The event structure and all non-image text are preserved. Embedded data:image/*
URIs are replaced with deterministic metadata placeholders so the exported file
still records that an image existed at that location.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def replace_images(value: Any, stats: dict[str, int]) -> Any:
    if isinstance(value, dict):
        return {key: replace_images(item, stats) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_images(item, stats) for item in value]
    if isinstance(value, str) and value.startswith("data:image/"):
        header = value.split(",", 1)[0]
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
        stats["images_removed"] += 1
        stats["image_chars_removed"] += len(value)
        return (
            f"[EMBEDDED_IMAGE_REMOVED header={header} "
            f"original_chars={len(value)} sha256={digest}]"
        )
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    args.destination.parent.mkdir(parents=True, exist_ok=True)
    stats = {
        "lines_read": 0,
        "lines_written": 0,
        "parse_errors": 0,
        "images_removed": 0,
        "image_chars_removed": 0,
    }

    with args.source.open("r", encoding="utf-8") as source, args.destination.open(
        "w", encoding="utf-8", newline="\n"
    ) as destination:
        for line in source:
            stats["lines_read"] += 1
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                stats["parse_errors"] += 1
                destination.write(line)
                stats["lines_written"] += 1
                continue
            event = replace_images(event, stats)
            destination.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
            destination.write("\n")
            stats["lines_written"] += 1

    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
