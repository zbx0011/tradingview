#!/usr/bin/env python3
"""Export original user-attached images from a Codex rollout with message mapping."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import re
from pathlib import Path


DATA_URI_RE = re.compile(r"^data:(image/[^;]+);base64,(.*)$", re.DOTALL)


def extension_for(mime: str) -> str:
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }.get(mime.lower(), ".bin")


def compact_text(content: list[dict]) -> str:
    parts = [item.get("text", "") for item in content if item.get("type") == "input_text"]
    text = "\n".join(part for part in parts if part)
    return "\n".join(line.rstrip() for line in text.splitlines()).strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, str | int]] = []
    user_index = 0

    with args.source.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            event = json.loads(line)
            if event.get("type") != "response_item":
                continue
            payload = event.get("payload") or {}
            if payload.get("type") != "message" or payload.get("role") != "user":
                continue
            user_index += 1
            content = payload.get("content") or []
            text = compact_text(content)
            image_index = 0
            for item in content:
                if item.get("type") != "input_image":
                    continue
                image_url = item.get("image_url") or ""
                match = DATA_URI_RE.match(image_url)
                if not match:
                    continue
                image_index += 1
                mime, encoded = match.groups()
                data = base64.b64decode(encoded)
                digest = hashlib.sha256(data).hexdigest()
                message_id = str(payload.get("id") or "no-id")
                filename = (
                    f"U{user_index:04d}_{message_id}_img{image_index:02d}_"
                    f"{digest[:12]}{extension_for(mime)}"
                )
                (args.output_dir / filename).write_bytes(data)
                rows.append(
                    {
                        "user_message_number": user_index,
                        "message_id": message_id,
                        "timestamp": event.get("timestamp", ""),
                        "rollout_line": line_number,
                        "image_number": image_index,
                        "filename": filename,
                        "mime_type": mime,
                        "bytes": len(data),
                        "sha256": digest,
                        "message_text": text,
                    }
                )

    fields = list(rows[0].keys()) if rows else []
    with (args.output_dir / "screenshots-message-map.csv").open(
        "w", encoding="utf-8-sig", newline=""
    ) as output:
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    with (args.output_dir / "screenshots-message-map.jsonl").open(
        "w", encoding="utf-8", newline="\n"
    ) as output:
        for row in rows:
            output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

    print(json.dumps({"user_messages": user_index, "images_exported": len(rows)}, indent=2))


if __name__ == "__main__":
    main()
