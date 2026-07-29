"""Replace selected markets in a multi-market replay range file."""
from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime
from pathlib import Path


def market_key(market: dict) -> str:
    return f"{market['vendor']}:{market['symbol']}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--replacement", type=Path, required=True)
    parser.add_argument("--market", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    original = json.loads(args.original.read_text(encoding="utf-8"))
    replacement = json.loads(args.replacement.read_text(encoding="utf-8"))
    targets = set(args.market)
    replacement_by_key = {
        market_key(market): market for market in replacement.get("markets", [])
    }
    missing = sorted(targets - set(replacement_by_key))
    if missing:
        raise SystemExit(f"replacement markets missing: {', '.join(missing)}")

    markets = [
        replacement_by_key.get(market_key(market), market)
        if market_key(market) in targets
        else market
        for market in original.get("markets", [])
    ]
    original_keys = {market_key(market) for market in original.get("markets", [])}
    markets.extend(
        replacement_by_key[key] for key in sorted(targets - original_keys)
    )

    market_windows = dict(original.get("market_windows") or {})
    original_window = original.get("window_beijing")
    if original_window:
        for market in original.get("markets", []):
            market_windows.setdefault(market_key(market), original_window)
    replacement_window = replacement.get("window_beijing")
    if replacement_window:
        for key in targets:
            market_windows[key] = replacement_window

    output = {
        **{key: value for key, value in original.items() if key != "markets"},
        "version": max(int(original.get("version", 1)), 3),
        "mode": "strict_causal_range_reconstruction_mixed_market_windows",
        "markets": markets,
        "market_windows": market_windows,
        "total_ranges": sum(len(market.get("ranges") or []) for market in markets),
    }
    if args.output.resolve() == args.original.resolve():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = args.original.with_suffix(f".before-other-v3-{stamp}.json")
        shutil.copy2(args.original, backup)
        output["backup"] = str(backup)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "markets": [
                    {
                        "market": market_key(market),
                        "ranges": len(market.get("ranges") or []),
                    }
                    for market in markets
                ],
                "total_ranges": output["total_ranges"],
                "backup": output.get("backup"),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
