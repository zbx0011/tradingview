"""Remove one market's already-deleted drawings from a replay manifest."""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    args = parser.parse_args()

    payload = json.loads(args.manifest.read_text(encoding="utf-8"))
    drawings = list(payload.get("drawings") or [])
    kept = [
        row
        for row in drawings
        if not (
            str(row.get("vendor")) == args.vendor
            and str(row.get("symbol")) == args.symbol
        )
    ]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = args.manifest.with_suffix(f".before-{stamp}.json")
    shutil.copy2(args.manifest, backup)
    payload["drawings"] = kept
    payload["completed_drawings"] = len(kept)
    payload["updated_at"] = datetime.now().astimezone().isoformat()
    args.manifest.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "success": True,
                "removed": len(drawings) - len(kept),
                "remaining": len(kept),
                "backup": str(backup),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
