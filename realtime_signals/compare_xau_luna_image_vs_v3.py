#!/usr/bin/env python3
"""Compare a causal Luna image replay against the matching XAUUSD v3 window."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


BEIJING = timezone(timedelta(hours=8))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def signal_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("decision") == "SIGNAL"]


def time_label(row: dict[str, Any]) -> str:
    timestamp = int(row["decision_after_close_time"])
    return datetime.fromtimestamp(timestamp, BEIJING).strftime("%Y-%m-%d %H:%M")


def setup_label(row: dict[str, Any]) -> str:
    return str(row.get("setup") or "")


def compare(luna_rows: list[dict[str, Any]], v3_rows: list[dict[str, Any]], start_idx: int, end_idx: int) -> dict[str, Any]:
    luna = signal_rows(luna_rows)
    v3_window = [row for row in signal_rows(v3_rows) if start_idx <= int(row["idx"]) < end_idx]
    luna_by_idx = {int(row["idx"]): row for row in luna}
    v3_by_idx = {int(row["idx"]): row for row in v3_window}
    exact = []
    opposite = []
    unmatched = []
    for v3 in v3_window:
        idx = int(v3["idx"])
        candidate = luna_by_idx.get(idx)
        if candidate is None:
            unmatched.append(v3)
        elif candidate.get("direction") == v3.get("direction"):
            exact.append({"v3": v3, "luna": candidate})
        else:
            opposite.append({"v3": v3, "luna": candidate})

    within_30m = []
    for v3 in v3_window:
        candidates = [
            row for row in luna
            if row.get("direction") == v3.get("direction")
            and abs(int(row["idx"]) - int(v3["idx"])) <= 6
        ]
        if candidates:
            best = min(candidates, key=lambda row: abs(int(row["idx"]) - int(v3["idx"])))
            within_30m.append(
                {
                    "v3": v3,
                    "luna": best,
                    "delta_bars": int(best["idx"]) - int(v3["idx"]),
                    "delta_minutes": (int(best["idx"]) - int(v3["idx"])) * 5,
                }
            )

    return {
        "start_idx": start_idx,
        "end_idx_exclusive": end_idx,
        "luna_rows": len(luna_rows),
        "v3_window_rows": end_idx - start_idx,
        "luna_signals": len(luna),
        "v3_window_signals": len(v3_window),
        "luna_direction_counts": dict(Counter(row.get("direction") for row in luna)),
        "v3_direction_counts": dict(Counter(row.get("direction") for row in v3_window)),
        "exact_same_idx_direction": exact,
        "same_idx_opposite_direction": opposite,
        "v3_without_same_idx_signal": unmatched,
        "v3_with_same_direction_within_30m": within_30m,
    }


def row_text(row: dict[str, Any]) -> str:
    return f"idx {row['idx']}｜{time_label(row)}｜{row.get('direction')}｜{setup_label(row)}"


def render_markdown(result: dict[str, Any]) -> str:
    exact = result["exact_same_idx_direction"]
    opposite = result["same_idx_opposite_direction"]
    unmatched = result["v3_without_same_idx_signal"]
    within = result["v3_with_same_direction_within_30m"]
    lines = [
        "# XAUUSD Luna Max 图像回放 vs v3 对比",
        "",
        f"- 新回放范围：原始 idx {result['start_idx']}–{result['end_idx_exclusive'] - 1}（{result['luna_rows']} 根）",
        f"- v3 对应窗口信号：{result['v3_window_signals']} 个",
        f"- Luna Max + 图像识别信号：{result['luna_signals']} 个",
        f"- Luna 方向：{result['luna_direction_counts']}",
        f"- v3 方向：{result['v3_direction_counts']}",
        "",
        "## 同一根K线、同一方向",
        "",
        f"共 {len(exact)} 个。",
    ]
    for item in exact:
        lines.append(f"- v3：{row_text(item['v3'])}；Luna：{row_text(item['luna'])}")
    lines += ["", "## 同一根K线、相反方向", "", f"共 {len(opposite)} 个。"]
    for item in opposite:
        lines.append(f"- v3：{row_text(item['v3'])}；Luna：{row_text(item['luna'])}")
    lines += ["", "## v3未在同一根K线得到同向信号", "", f"共 {len(unmatched)} 个。"]
    for row in unmatched:
        lines.append(f"- {row_text(row)}")
    lines += ["", "## 同方向、±30分钟内的最近匹配", "", f"共 {len(within)} 个。"]
    for item in within:
        lines.append(
            f"- v3：{row_text(item['v3'])}；Luna：{row_text(item['luna'])}；"
            f"偏移 {item['delta_minutes']} 分钟"
        )
    lines += [
        "",
        "## 口径",
        "",
        "同一根K线同向是严格匹配；±30分钟同方向只作邻近机会参考，不视为完全一致。结果是回放审计比较，不构成交易建议。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--luna", type=Path, required=True)
    parser.add_argument("--v3", type=Path, required=True)
    parser.add_argument("--start-idx", type=int, required=True)
    parser.add_argument("--end-idx", type=int, required=True, help="Exclusive end index.")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    luna_rows = read_jsonl(args.luna)
    v3_rows = read_jsonl(args.v3)
    result = compare(luna_rows, v3_rows, args.start_idx, args.end_idx)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "luna_image_signals.json").write_text(
        json.dumps(signal_rows(luna_rows), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_dir / "luna_vs_v3_comparison.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_dir / "luna_vs_v3_comparison.md").write_text(render_markdown(result), encoding="utf-8")
    print(json.dumps({
        "luna_signals": result["luna_signals"],
        "v3_window_signals": result["v3_window_signals"],
        "exact_same_idx_direction": len(result["exact_same_idx_direction"]),
        "same_idx_opposite_direction": len(result["same_idx_opposite_direction"]),
        "same_direction_within_30m": len(result["v3_with_same_direction_within_30m"]),
        "output_dir": str(args.output_dir),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
