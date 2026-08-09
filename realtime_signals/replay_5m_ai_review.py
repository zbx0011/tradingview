#!/usr/bin/env python3
# louie规则回放（20260806版本）
"""Run the 5m XAGUSD replay with a real Codex model and causal signal audits."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = Path(__file__).resolve().parent
BATCH_SCHEMA = SCRIPT_DIR / "replay_5m_batch_schema.json"
AUDIT_SCHEMA = SCRIPT_DIR / "replay_5m_signal_audit_schema.json"
RULE_PATHS = [
    ROOT / "migration" / "codex-handoff" / "source-rules" / "Louie交易规则完整整理_案例扩展版.md",
    ROOT / "migration" / "codex-handoff" / "source-rules" / "louie-case-expanded.md",
]
ALLOWED_SETUPS = {
    "震荡内部：边缘反向",
    "震荡突破：位移突破",
    "宽通道边缘：反向波段",
    "宽通道突破：更大级别反转",
    "宽通道顺势：在有利边缘跟随主方向",
    "窄通道：等待回踩顺势参与",
}
TIMEOUT_SECONDS = 900


def token_usage(text: str) -> int:
    match = re.search(r"tokens used\s+([\d,]+)", text, re.IGNORECASE)
    return int(match.group(1).replace(",", "")) if match else 0


def run_codex(
    codex: str,
    model: str,
    effort: str,
    prompt: str,
    schema: Path,
    result_path: Path,
    log_path: Path,
) -> tuple[dict[str, Any], int, float]:
    started = time.monotonic()
    completed = subprocess.run(
        [
            codex,
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "-C",
            str(ROOT),
            "-m",
            model,
            "-c",
            f"model_reasoning_effort={effort}",
            "--output-schema",
            str(schema),
            "-o",
            str(result_path),
            "-",
        ],
        cwd=ROOT,
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=TIMEOUT_SECONDS,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    duration = time.monotonic() - started
    output = completed.stdout or ""
    log_path.write_text(output, encoding="utf-8")
    if completed.returncode != 0 or not result_path.exists():
        raise RuntimeError(f"Codex exit={completed.returncode}: {output[-3000:]}")
    return (
        json.loads(result_path.read_text(encoding="utf-8")),
        token_usage(output),
        duration,
    )


def load_manifest(base: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return {"version": 1}, payload
    return payload, payload["batches"]


def parse_batch_rows(text: str) -> dict[int, dict[str, Any]]:
    rows: dict[int, dict[str, Any]] = {}
    in_batch = False
    for line in text.splitlines():
        if line == "BATCH:":
            in_batch = True
            continue
        if not in_batch or not re.match(r"^\d+\s", line):
            continue
        parts = line.split()
        if len(parts) < 10:
            continue
        idx = int(parts[0])
        rows[idx] = {
            "idx": idx,
            "time": f"{parts[1]} {parts[2]}",
            "open": float(parts[3]),
            "high": float(parts[4]),
            "low": float(parts[5]),
            "close": float(parts[6]),
            "line": line,
        }
    return rows


def parse_visible_indices(text: str) -> set[int]:
    return {
        int(line.split()[0])
        for line in text.splitlines()
        if re.match(r"^\d+\s", line)
    }


def causal_snapshot(batch_text: str, target_idx: int) -> str:
    lines = batch_text.splitlines()
    marker = lines.index("BATCH:")
    prefix = [
        line
        for line in lines[:marker]
        if not line.startswith("# XAGUSD 5m replay batch")
        and not line.startswith("# window:")
    ]
    batch_rows = []
    for line in lines[marker + 1 :]:
        if line.startswith("idx time"):
            continue
        if re.match(r"^\d+\s", line) and int(line.split()[0]) <= target_idx:
            batch_rows.append(line)
    return "\n".join(
        [
            f"# XAGUSD 5m strict causal snapshot through idx {target_idx}",
            *prefix,
            "BATCH_THROUGH_TARGET:",
            "idx time O H L C EMA20 EMA50 ATR V",
            *batch_rows,
        ]
    )


def validate_common(
    item: dict[str, Any],
    rows: dict[int, dict[str, Any]],
    visible_indices: set[int],
) -> None:
    idx = int(item["idx"])
    if idx not in rows:
        raise RuntimeError(f"override idx {idx} is outside this batch")
    audit = item["a"]
    evidence = [int(value) for value in audit["evidence_indices"]]
    if not audit["no_future_data"] or int(audit["max_used_idx"]) > idx:
        raise RuntimeError(f"future-data assertion failed for idx {idx}")
    if any(value > idx or value not in visible_indices for value in evidence):
        raise RuntimeError(f"future/out-of-snapshot evidence for idx {idx}: {evidence}")
    if item["v"] == "O":
        item.update({"d": "none", "p": 0, "s": "none", "g": "none"})
        return
    if item["d"] not in {"long", "short"}:
        raise RuntimeError(f"signal idx {idx} has invalid direction")
    if not item["s"] or item["s"] == "none" or item["g"] not in {"A", "B"}:
        raise RuntimeError(f"signal idx {idx} has invalid setup/grade")
    item["p"] = rows[idx]["close"]


def batch_prompt(
    model: str,
    effort: str,
    rules: str,
    batch_text: str,
) -> str:
    return f"""你是 louie规则回放（20260806版本）的 5 分钟逐根审阅器。
实际模型必须记录为 {model}，推理强度必须记录为 {effort}。

边界：
- 只审阅下面 BATCH 中的 OANDA:XAGUSD 5m 已闭合K线。
- 必须按 idx 递增逐根判断；判断 idx=N 时，只允许使用 CONTEXT 和 idx<=N 的行。
- 后面的行即使出现在同一批文本里，也绝不能反向影响前面的判断。
- 默认 verdict 是 N(NO_SIGNAL)，输出只列非默认的 O(OBSERVE) 或 S(SIGNAL)。
- SIGNAL 仅限规则原文支持的 A/B 机会；价格 p 必须是该 idx 的 C。
- 每项 a.max_used_idx/evidence_indices 必须证明没有使用未来 idx。
- 所有理由和审计摘要必须简体中文，不创建警报、不操作 TradingView、不写数据库。

规则原文：
{rules}

待审批次：
{batch_text}

只按 schema 返回 JSON；model={model}，reasoning_effort={effort}。
"""


def audit_prompt(
    rules: str,
    decision: dict[str, Any],
    snapshot: str,
) -> str:
    return f"""你是独立的二次时间戳审计员。不要相信第一次判断。
只根据下面严格截断到目标K的快照和 Louie 规则，重新判断该 SIGNAL 是否已经在目标K收盘时成立。
若仍需未来确认、位置/背景/结构不足、或引用任何更大 idx，pass=false。
evidence_indices 只填快照 BATCH_THROUGH_TARGET 中真实存在且不大于目标 idx 的编号。
所有文字用简体中文；只按 schema 返回 JSON。

规则原文：
{rules}

第一次 SIGNAL：
{json.dumps(decision, ensure_ascii=False)}

严格因果快照：
{snapshot}
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--model", default="gpt-5.6-sol")
    parser.add_argument("--effort", default="xhigh")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--audit-workers", type=int, default=3)
    args = parser.parse_args()
    base = args.base if args.base.is_absolute() else ROOT / args.base
    codex = os.environ.get("CODEX_CLI") or shutil.which("codex")
    if not codex:
        raise RuntimeError("codex CLI not found")
    manifest_meta, batches = load_manifest(base)
    rules = "\n\n".join(path.read_text(encoding="utf-8") for path in RULE_PATHS)
    total_overrides = total_signals = total_observe = total_tokens = 0
    batch_summaries: list[dict[str, Any]] = []

    for batch in batches:
        no = int(batch["batch"])
        batch_path = base / batch["file"]
        batch_text = batch_path.read_text(encoding="utf-8")
        rows = parse_batch_rows(batch_text)
        visible_indices = parse_visible_indices(batch_text)
        raw_path = base / f"ai_batch_{no:03d}.raw.json"
        log_path = base / f"ai_batch_{no:03d}.log"
        overrides_path = base / f"overrides_batch_{no:03d}.json"
        use_existing_overrides = overrides_path.exists() and not args.force
        if use_existing_overrides:
            overrides = json.loads(overrides_path.read_text(encoding="utf-8"))
            tokens = 0
            duration = 0.0
        elif raw_path.exists() and not args.force:
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
            tokens = token_usage(log_path.read_text(encoding="utf-8")) if log_path.exists() else 0
            duration = 0.0
            if raw.get("model") != args.model or raw.get("reasoning_effort") != args.effort:
                raise RuntimeError(f"batch {no} cached raw result has incorrect model metadata")
            overrides = raw["overrides"]
        else:
            raw, tokens, duration = run_codex(
                codex,
                args.model,
                args.effort,
                batch_prompt(args.model, args.effort, rules, batch_text),
                BATCH_SCHEMA,
                raw_path,
                log_path,
            )
            if raw.get("model") != args.model or raw.get("reasoning_effort") != args.effort:
                raise RuntimeError(f"batch {no} returned incorrect model metadata")
            overrides = raw["overrides"]

        if not use_existing_overrides:
            seen: set[int] = set()
            for item in overrides:
                validate_common(item, rows, visible_indices)
                idx = int(item["idx"])
                if idx in seen:
                    raise RuntimeError(f"duplicate override idx {idx}")
                seen.add(idx)

            def audit_signal(item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], int]:
                idx = int(item["idx"])
                audit_raw_path = base / f"audit_{idx}.raw.json"
                audit_log_path = base / f"audit_{idx}.log"
                if audit_raw_path.exists() and not args.force:
                    audit = json.loads(audit_raw_path.read_text(encoding="utf-8"))
                    audit_tokens = (
                        token_usage(audit_log_path.read_text(encoding="utf-8"))
                        if audit_log_path.exists()
                        else 0
                    )
                else:
                    audit, audit_tokens, _ = run_codex(
                        codex,
                        args.model,
                        args.effort,
                        audit_prompt(rules, item, causal_snapshot(batch_text, idx)),
                        AUDIT_SCHEMA,
                        audit_raw_path,
                        audit_log_path,
                    )
                return item, audit, audit_tokens

            signal_items = [item for item in overrides if item["v"] == "S"]
            max_workers = max(1, min(args.audit_workers, len(signal_items) or 1))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                audit_results = list(executor.map(audit_signal, signal_items))
            for item, audit, audit_tokens in audit_results:
                idx = int(item["idx"])
                total_tokens += audit_tokens
                evidence = [int(value) for value in audit["evidence_indices"]]
                passed = bool(
                    audit["pass"]
                    and int(audit["idx"]) == idx
                    and int(audit["max_used_idx"]) <= idx
                    and all(value <= idx and value in visible_indices for value in evidence)
                )
                if not passed:
                    item.update(
                        {
                            "v": "O",
                            "d": "none",
                            "p": 0,
                            "s": "none",
                            "g": "none",
                            "r": f"二次因果审计未通过：{audit['summary']}",
                        }
                    )
                item["a"] = {
                    "max_used_idx": int(audit["max_used_idx"]),
                    "evidence_indices": evidence,
                    "no_future_data": passed,
                    "audit_summary": audit["summary"],
                }
            overrides_path.write_text(
                json.dumps(overrides, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        total_tokens += tokens
        signals = sum(item["v"] == "S" for item in overrides)
        observe = sum(item["v"] == "O" for item in overrides)
        total_overrides += len(overrides)
        total_signals += signals
        total_observe += observe
        batch_summaries.append(
            {
                "batch": no,
                "bars": len(rows),
                "overrides": len(overrides),
                "signals": signals,
                "observe": observe,
                "duration_seconds": round(duration, 3),
            }
        )
        print(
            f"REPLAY_BATCH {no + 1}/{len(batches)} bars={len(rows)} "
            f"signals={signals} observe={observe}",
            flush=True,
        )

    metadata = {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "reasoning_effort": args.effort,
        "qualified_symbol": manifest_meta.get("qualified_symbol", "OANDA:XAGUSD"),
        "timeframe": manifest_meta.get("timeframe", "5"),
        "first_open_time": manifest_meta.get("first_open_time"),
        "last_open_time": manifest_meta.get("last_open_time"),
        "last_close_time": manifest_meta.get("last_close_time"),
        "total_overrides": total_overrides,
        "signals": total_signals,
        "observe": total_observe,
        "tokens_used": total_tokens,
        "batches": batch_summaries,
    }
    (base / "review_metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("REPLAY_AI_COMPLETE " + json.dumps(metadata, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
