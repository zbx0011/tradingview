"""Register one verified replay range drawing while preserving other markets."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--range-json", type=Path, required=True)
    parser.add_argument("--vendor", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--range-id")
    parser.add_argument("--entity-id", required=True)
    parser.add_argument("--visual-end-time", type=int, required=True)
    args = parser.parse_args()

    manifest = (
        json.loads(args.manifest.read_text(encoding="utf-8"))
        if args.manifest.exists()
        else {"version": 1, "drawings": []}
    )
    ranges = json.loads(args.range_json.read_text(encoding="utf-8"))
    market = next(
        market
        for market in ranges.get("markets", [])
        if market.get("vendor") == args.vendor
        and market.get("symbol") == args.symbol
    )
    market_ranges = list(market.get("ranges", []))
    if args.range_id:
        final_range = next(
            item
            for item in market_ranges
            if str(item.get("range_id")) == args.range_id
        )
    else:
        final_range = max(
            market_ranges,
            key=lambda item: int(item.get("first_detected_at", 0)),
        )
    row = {
        **final_range,
        "draw_end_time": args.visual_end_time,
        "full_symbol": f"{args.vendor}:{args.symbol}",
        "entity_id": args.entity_id,
        "color": "#f59e0b",
        "visual_final_revision": True,
    }
    retained = [
        item
        for item in manifest.get("drawings", [])
        if not (
            item.get("vendor") == args.vendor
            and item.get("symbol") == args.symbol
            and (
                not args.range_id
                or str(item.get("range_id")) == args.range_id
            )
        )
    ]
    retained.append(row)
    retained.sort(
        key=lambda item: (
            str(item.get("vendor")),
            str(item.get("symbol")),
            int(item.get("start_time", 0)),
        )
    )
    output = {
        **manifest,
        "version": max(int(manifest.get("version", 1)), 3),
        "mode": "strict-causal-user-confirmed-range-drawings",
        "expected_ranges": len(retained),
        "completed_drawings": len(retained),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "drawings": retained,
    }
    args.manifest.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "registered": args.entity_id,
                "market": f"{args.vendor}:{args.symbol}",
                "total": len(retained),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
