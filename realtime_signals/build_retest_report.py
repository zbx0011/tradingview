"""Build a read-only comparison report from an archived-signal retest package."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


RANGE_SETUPS = {"震荡内部：边缘反向", "震荡突破：位移突破"}
WIDE_SETUPS = {
    "宽通道边缘：反向波段",
    "宽通道突破：更大级别反转",
    "宽通道顺势：在有利边缘跟随主方向",
}
NARROW_SETUP = "窄通道：等待回踩顺势参与"
ALLOWED_SETUPS = RANGE_SETUPS | WIDE_SETUPS | {NARROW_SETUP}
TOP_LEVEL_KEYS = {
    "verdict",
    "direction",
    "setup_type",
    "grade",
    "reasons",
    "location_summary",
    "structure_summary",
    "confirmation_price",
    "invalidation_price",
    "context",
}
CONTEXT_KEYS = {
    "market_state",
    "levels_reason",
    "range_or_channel_anchors",
    "previous_signal_id",
    "previous_signal_status",
    "state_transition",
    "transition_evidence",
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def schema_errors(decision: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if set(decision) != TOP_LEVEL_KEYS:
        errors.append(f"top_keys={sorted(set(decision) ^ TOP_LEVEL_KEYS)}")
    if decision.get("verdict") not in {"NO_SIGNAL", "SIGNAL"}:
        errors.append("verdict")
    if decision.get("direction") not in {"none", "long", "short"}:
        errors.append("direction")
    if decision.get("setup_type") not in ALLOWED_SETUPS | {"none"}:
        errors.append("setup_type")
    if decision.get("grade") not in {"none", "A", "B"}:
        errors.append("grade")
    if not isinstance(decision.get("reasons"), list):
        errors.append("reasons")
    context = decision.get("context")
    if not isinstance(context, dict) or set(context) != CONTEXT_KEYS:
        errors.append("context_keys")
    return errors


def post_gate_valid(
    decision: dict[str, Any], candidate: dict[str, Any]
) -> tuple[bool, bool]:
    setup = decision["setup_type"]
    direction = decision["direction"]
    close = float(candidate["close"])
    if setup in RANGE_SETUPS:
        gate_valid = bool(candidate["range_validation"].get("valid"))
    elif setup in WIDE_SETUPS:
        gate_valid = bool(candidate["wide_channel_validation"].get("valid"))
    elif setup == NARROW_SETUP:
        required = "up" if direction == "long" else "down"
        gate_valid = required in candidate["narrow_channel_validation"].get(
            "valid_directions", []
        )
    else:
        gate_valid = False

    if direction == "long":
        price_valid = (
            float(decision["confirmation_price"]) >= close
            and float(decision["invalidation_price"]) < close
        )
    elif direction == "short":
        price_valid = (
            float(decision["confirmation_price"]) <= close
            and float(decision["invalidation_price"]) > close
        )
    else:
        price_valid = False
    return gate_valid, price_valid


def build_report(audit_dir: Path, output_dir: Path) -> dict[str, Any]:
    package = load_json(audit_dir / "package.json")
    review_items = {int(item["id"]): item for item in package["review"]}
    validation_errors: list[dict[str, Any]] = []
    final_rows: list[dict[str, Any]] = []

    for original in package["all"]:
        signal_id = int(original["id"])
        source = "hard_gate"
        if signal_id in review_items:
            source = "ai_visual_review"
            decision = load_json(audit_dir / f"decision-{signal_id}.json")
            errors = schema_errors(decision)
            if errors:
                validation_errors.append({"id": signal_id, "schema": errors})
            if decision["verdict"] == "SIGNAL":
                candidate = load_json(Path(review_items[signal_id]["candidate_file"]))
                gate_valid, price_valid = post_gate_valid(decision, candidate)
                if not gate_valid or not price_valid:
                    validation_errors.append(
                        {
                            "id": signal_id,
                            "post_gate": gate_valid,
                            "price_ok": price_valid,
                        }
                    )
                    decision = {
                        "verdict": "NO_SIGNAL",
                        "direction": "none",
                        "setup_type": "none",
                        "grade": "none",
                        "reasons": ["二次 AI 输出未通过本地硬门或价格级别校验。"],
                        "confirmation_price": 0,
                        "invalidation_price": 0,
                    }
        else:
            reason = (
                "新版因果候选层在该根收盘不再产生候选。"
                if not original["candidate"]
                else "候选存在，但震荡、宽通道及方向匹配窄通道硬门全部未通过。"
            )
            decision = {
                "verdict": "NO_SIGNAL",
                "direction": "none",
                "setup_type": "none",
                "grade": "none",
                "reasons": [reason],
                "confirmation_price": 0,
                "invalidation_price": 0,
            }

        kept = decision["verdict"] == "SIGNAL"
        exact = (
            kept
            and original["direction"] == decision["direction"]
            and original["normalized_setup_type"] == decision["setup_type"]
            and original["grade"] == decision["grade"]
        )
        change = "完全一致" if exact else "保留但修改" if kept else "新版删除"
        final_rows.append(
            {
                "id": signal_id,
                "vendor": original["vendor"],
                "symbol": original["symbol"],
                "beijing_time": original["beijing_time"],
                "bar_time": original["bar_time"],
                "old": {
                    "direction": original["direction"],
                    "setup_type": original["setup_type"],
                    "normalized_setup_type": original["normalized_setup_type"],
                    "grade": original["grade"],
                    "price": original["signal_price"],
                },
                "new": {
                    "verdict": decision["verdict"],
                    "direction": decision["direction"],
                    "setup_type": decision["setup_type"],
                    "grade": decision["grade"],
                    "confirmation_price": decision.get("confirmation_price", 0),
                    "invalidation_price": decision.get("invalidation_price", 0),
                    "reasons": decision.get("reasons", []),
                },
                "change": change,
                "review_source": source,
                "gate_snapshot": original["gates"],
            }
        )

    summary = {
        "old_signals": len(final_rows),
        "new_signals": sum(row["new"]["verdict"] == "SIGNAL" for row in final_rows),
        "exact_same": sum(row["change"] == "完全一致" for row in final_rows),
        "kept_reclassified": sum(
            row["change"] == "保留但修改" for row in final_rows
        ),
        "removed": sum(row["change"] == "新版删除" for row in final_rows),
        "removed_at_hard_gate": sum(
            row["change"] == "新版删除" and row["review_source"] == "hard_gate"
            for row in final_rows
        ),
        "removed_by_ai_review": sum(
            row["change"] == "新版删除"
            and row["review_source"] == "ai_visual_review"
            for row in final_rows
        ),
        "validation_errors": len(validation_errors),
    }
    report = {
        "test_name": (
            "2026-07-27 archived signals retest with current v5 gates "
            "+ fresh no-future image AI review"
        ),
        "window_beijing": package["window_beijing"],
        "rules_version": package["rules_version"],
        "candidate_filter_memory_version": package[
            "candidate_filter_memory_version"
        ],
        "method": {
            "future_bars_used": False,
            "hard_gate_first": True,
            "ai_reviewed_ids": sorted(review_items),
            "ai_models": (
                "gpt-5.6-sol/high when needs_sol=true; "
                "otherwise gpt-5.6-terra/medium"
            ),
            "original_records_mutated": False,
        },
        "summary": summary,
        "validation_errors": validation_errors,
        "signals": final_rows,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "signal_retest_20260727_new_v5.json"
    json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    markdown_path = output_dir / "signal_retest_20260727_new_v5.md"
    lines = [
        "# 2026-07-27 正式信号新版二次测试",
        "",
        "- 范围：北京时间 2026-07-27 08:30 至 2026-07-28 00:10",
        (
            "- 方法：逐条截断到原信号 K 线收盘；先跑新版硬门，只对仍具"
            "合法结构的记录做无未来图像 + AI 复核。"
        ),
        "- 原始数据库记录：未修改。",
        "",
        "## 结果",
        "",
        (
            f"原 {summary['old_signals']} 条；新版保留 "
            f"{summary['new_signals']} 条；完全一致 "
            f"{summary['exact_same']} 条；保留但改类型 "
            f"{summary['kept_reclassified']} 条；删除 "
            f"{summary['removed']} 条。"
        ),
        "",
        "| ID | 品种 | 北京时间 | 原信号 | 新版结果 | 变化 |",
        "|---:|---|---|---|---|---|",
    ]
    for row in final_rows:
        old = row["old"]
        new = row["new"]
        old_text = (
            f"{old['direction']} / {old['normalized_setup_type']} / {old['grade']}"
        )
        new_text = (
            "无信号"
            if new["verdict"] == "NO_SIGNAL"
            else f"{new['direction']} / {new['setup_type']} / {new['grade']}"
        )
        lines.append(
            f"| {row['id']} | {row['vendor']}:{row['symbol']} | "
            f"{row['beijing_time']} | {old_text} | {new_text} | "
            f"{row['change']} |"
        )
    lines.extend(["", "## 保留信号的新版理由摘要", ""])
    for row in final_rows:
        if row["new"]["verdict"] == "SIGNAL":
            lines.append(
                f"- ID {row['id']} {row['symbol']} {row['beijing_time']}："
                f"{row['new']['reasons'][0]}"
            )
    lines.extend(["", "## AI 复核后删除的边界案例", ""])
    for row in final_rows:
        if (
            row["change"] == "新版删除"
            and row["review_source"] == "ai_visual_review"
        ):
            lines.append(
                f"- ID {row['id']} {row['symbol']} {row['beijing_time']}："
                f"{row['new']['reasons'][0]}"
            )
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {
        "summary": summary,
        "kept_ids": [
            row["id"] for row in final_rows if row["new"]["verdict"] == "SIGNAL"
        ],
        "exact_ids": [
            row["id"] for row in final_rows if row["change"] == "完全一致"
        ],
        "reclassified_ids": [
            row["id"] for row in final_rows if row["change"] == "保留但修改"
        ],
        "hard_removed_ids": [
            row["id"]
            for row in final_rows
            if row["change"] == "新版删除"
            and row["review_source"] == "hard_gate"
        ],
        "ai_removed_ids": [
            row["id"]
            for row in final_rows
            if row["change"] == "新版删除"
            and row["review_source"] == "ai_visual_review"
        ],
        "json": str(json_path.resolve()),
        "markdown": str(markdown_path.resolve()),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(
        json.dumps(
            build_report(args.audit_dir, args.output_dir),
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
