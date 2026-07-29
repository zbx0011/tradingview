"""Filter a replay candidate queue to one or more exact markets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def market_key(item: dict) -> str:
    return f"{item.get('vendor')}:{item.get('symbol')}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--market", action="append", required=True)
    args = parser.parse_args()

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    targets = set(args.market)
    candidates = [
        item
        for item in payload.get("candidates", [])
        if market_key(item) in targets
    ]
    output = {
        **payload,
        "mode": f"{payload.get('mode', 'replay')}_filtered",
        "markets": [
            market
            for market in payload.get("markets", [])
            if market_key(market) in targets
        ],
        "candidates": candidates,
        "market_counts": {
            target: sum(market_key(item) == target for item in candidates)
            for target in sorted(targets)
        },
    }
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "candidates": len(candidates),
                "market_counts": output["market_counts"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
