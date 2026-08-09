#!/usr/bin/env python3
"""Run the frozen XAU replay through a tool-isolated Sol xhigh MCP session."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
CODEX_HOME = Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-home-20260806"
WORK = Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-work-20260806"
LEDGER = WORK / "ledger"
GATE = WORK / "gate.py"
RULE_1 = ROOT / "migration" / "codex-handoff" / "source-rules" / "Louie交易规则完整整理_案例扩展版.md"
RULE_2 = ROOT / "migration" / "codex-handoff" / "source-rules" / "louie-case-expanded.md"
PROGRESS = WORK / "orchestrator_progress.json"
TURN_LIMIT = 30
TOTAL_BARS = 634


COMMON = [
    "--json",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--disable", "shell_tool",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "browser_use",
    "--disable", "multi_agent",
    "--disable", "tool_suggest",
    "-m", "gpt-5.6-sol",
    "-c", 'model_reasoning_effort="xhigh"',
    "--dangerously-bypass-approvals-and-sandbox",
]


def write_progress(value: dict[str, Any]) -> None:
    temp = PROGRESS.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(PROGRESS)


def state() -> dict[str, Any]:
    return json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))


def parse_events(text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def validate_events(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []
    forbidden: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != "item.completed":
            continue
        item = event.get("item") or {}
        item_type = item.get("type")
        if item_type == "mcp_tool_call":
            calls.append(item)
            if item.get("server") != "causal_gate" or item.get("tool") not in {"status", "commit"}:
                forbidden.append(item)
        elif item_type in {"agent_message", "reasoning"}:
            continue
        else:
            forbidden.append(item)
    return calls, forbidden


def run_turn(command: list[str], prompt: str, turn_no: int) -> tuple[list[dict[str, Any]], int]:
    env = os.environ.copy()
    env["CODEX_HOME"] = str(CODEX_HOME)
    started = time.time()
    completed = subprocess.run(
        command,
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        env=env,
        timeout=900,
        check=False,
    )
    (WORK / f"turn_{turn_no:03d}.jsonl").write_text(completed.stdout, encoding="utf-8")
    (WORK / f"turn_{turn_no:03d}.stderr.txt").write_text(completed.stderr, encoding="utf-8")
    events = parse_events(completed.stdout)
    duration = int(time.time() - started)
    return events, duration


def initial_prompt() -> str:
    rules1 = RULE_1.read_text(encoding="utf-8")
    rules2 = RULE_2.read_text(encoding="utf-8")
    return f"""你是正式的离线价格行为逐根回放判断器。模型保持 GPT-5.6 Sol，推理强度 xhigh。

防作弊协议：
- 你只有 causal_gate.status 和 causal_gate.commit 两个工具，没有 Shell、文件、网络、TradingView、数据库、截图、基准答案或子代理能力。
- 因果门只有在 idx=n 的判断被 commit 写入哈希链后，才会释放 idx=n+1；禁止回填或修改旧判断。
- 每条 evidence 只能 <= 当前 idx；max_used_idx 必须等于当前 idx；理由不能引用未来走势。

判断口径：
- 每根收盘后提交 NO_SIGNAL / OBSERVE / SIGNAL。
- SIGNAL 只用于当前收盘时已具备可执行性的 Louie 正式机会；若仍需下一根确认，只能 OBSERVE。
- 不使用 A/B 等级，不添加固定 ATR、百分比、分数、冷却根数等规则原文没有的硬阈值。
- 依次检查环境/背景、位置、接受与跟随、被破坏的结构、当前触发；EMA/ATR 仅作辅助。
- 震荡中部、趋势过度延伸、高潮后的第一次反转要克制；初始历史不足时克制。

本轮要求：先调用 status，然后严格逐根 commit，最多处理 {TURN_LIMIT} 根或遇到 done=true 即停止。达到 {TURN_LIMIT} 根后必须结束本轮，不要总结后续行情。

===== 固定规则全文 1 =====
{rules1}
===== 固定规则全文 1 结束 =====

===== 固定规则全文 2 =====
{rules2}
===== 固定规则全文 2 结束 =====
"""


def continue_prompt() -> str:
    return f"""继续同一严格因果回放。只使用 causal_gate.status/commit；不得使用任何其他能力。先读取当前 status，再逐根提交最多 {TURN_LIMIT} 根，或 done=true 即停止。严格沿用本会话已加载的两份 Louie 规则；不看未来、不回填旧判断、不使用 A/B 或自创硬阈值。"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Continue an existing causal ledger/session without reinitializing it.",
    )
    args = parser.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    if args.resume:
        if not PROGRESS.exists() or not (LEDGER / "gate_state.json").exists():
            raise SystemExit("cannot resume: progress or causal ledger is missing")
        progress = json.loads(PROGRESS.read_text(encoding="utf-8"))
        thread_id = progress.get("thread_id")
        if not thread_id:
            raise SystemExit("cannot resume: thread_id is missing")
        turn_no = 1 + max((int(item["turn"]) for item in progress.get("turns", [])), default=-1)
        progress.pop("error", None)
        progress.pop("forbidden", None)
        progress.update(
            {
                "status": "running",
                "next_idx": int(state()["next_idx"]),
                "chain_sha256": state()["chain_sha256"],
                "resumed_at_epoch": int(time.time()),
            }
        )
        write_progress(progress)
    else:
        subprocess.run(
            [os.sys.executable, str(GATE), "--out", str(LEDGER), "init"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        progress = {
            "status": "running",
            "model": "gpt-5.6-sol",
            "reasoning_effort": "xhigh",
            "turns": [],
            "next_idx": 0,
            "total": TOTAL_BARS,
        }
        write_progress(progress)
        thread_id = None
        turn_no = 0

    no_progress = 0
    while state()["next_idx"] < TOTAL_BARS:
        before = int(state()["next_idx"])
        last_message = WORK / f"turn_{turn_no:03d}_last.txt"
        if thread_id is None:
            command = [
                "codex", "exec", "-", *COMMON,
                "-C", str(WORK),
                "-o", str(last_message),
            ]
            prompt = initial_prompt()
        else:
            command = [
                "codex", "exec", "resume", thread_id, "-", *COMMON,
                "-o", str(last_message),
            ]
            prompt = continue_prompt()

        events, duration = run_turn(command, prompt, turn_no)
        if thread_id is None:
            started = next((event for event in events if event.get("type") == "thread.started"), None)
            if not started or not started.get("thread_id"):
                progress.update({"status": "failed", "error": "missing thread id", "turn": turn_no})
                write_progress(progress)
                return 2
            thread_id = str(started["thread_id"])

        calls, forbidden = validate_events(events)
        after = int(state()["next_idx"])
        commits = [call for call in calls if call.get("tool") == "commit" and call.get("status") == "completed"]
        statuses = [call for call in calls if call.get("tool") == "status"]
        turn_info = {
            "turn": turn_no,
            "before_idx": before,
            "after_idx": after,
            "commits": len(commits),
            "status_calls": len(statuses),
            "forbidden_count": len(forbidden),
            "duration_seconds": duration,
        }
        progress["turns"].append(turn_info)
        progress["thread_id"] = thread_id
        progress["next_idx"] = after
        progress["chain_sha256"] = state()["chain_sha256"]
        write_progress(progress)

        if forbidden:
            progress.update({"status": "failed", "error": "forbidden tool item", "forbidden": forbidden[:5]})
            write_progress(progress)
            return 3
        if after <= before:
            no_progress += 1
        else:
            no_progress = 0
        if no_progress >= 2:
            progress.update({"status": "failed", "error": "two turns without progress"})
            write_progress(progress)
            return 4
        turn_no += 1

    progress.update(
        {
            "status": "complete",
            "next_idx": int(state()["next_idx"]),
            "chain_sha256": state()["chain_sha256"],
            "finished_at_epoch": int(time.time()),
        }
    )
    write_progress(progress)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
