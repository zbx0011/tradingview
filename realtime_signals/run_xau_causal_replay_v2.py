#!/usr/bin/env python3
"""v2 causal XAU replay: one bar at a time, structure-sensitive snapshots.

Model: deepseek-v4-flash / max. The model sees only the currently released bar
plus a causal text snapshot (bars <= idx) when structure may have changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
REPO = ROOT / "realtime_signals"
CODEX_HOME_SRC = Path.home() / ".codex"
WORK = Path(os.environ.get(
    "CAUSAL_WORK",
    str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-v2-work-20260807"),
))
HOME = Path(os.environ.get(
    "CAUSAL_HOME",
    str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-v2-home-20260807"),
))
DATA = Path(os.environ.get(
    "CAUSAL_DATA",
    str(Path.home() / "AppData" / "Local" / "Temp" / "xauusd_luna_compare_634bars.json"),
))
LEDGER = WORK / "ledger"
PROGRESS = WORK / "orchestrator_progress.json"
RULE_1 = ROOT / "migration" / "codex-handoff" / "source-rules" / "Louie交易规则完整整理_案例扩展版.md"
RULE_2 = ROOT / "migration" / "codex-handoff" / "source-rules" / "louie-case-expanded.md"

MODEL = "deepseek-v4-flash"
EFFORT = "max"
TURN_LIMIT = int(os.environ.get("CAUSAL_TURN_LIMIT", "30"))
TOTAL_BARS = 634
SNAPSHOTS_PER_TURN = 12
SNAPSHOTS_TOTAL = 800


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
    "-m", MODEL,
    "-c", f'model_reasoning_effort="{EFFORT}"',
    "--dangerously-bypass-approvals-and-sandbox",
]


def write_progress(value: dict[str, Any]) -> None:
    temp = PROGRESS.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(PROGRESS)


def data_sha256() -> str:
    return hashlib.sha256(DATA.read_bytes()).hexdigest()


def state() -> dict[str, Any]:
    return json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))


def total_bars() -> int:
    completed = subprocess.run(
        [os.sys.executable, str(WORK / "xau_causal_gate.py"), "--data", str(DATA), "--out", str(LEDGER), "status"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    payload = json.loads(completed.stdout)
    if payload.get("done"):
        return int(payload.get("committed") or 0)
    return int(payload["idx"]) + int(payload["remaining_including_current"])


def parse_events(text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def validate_events(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    calls: list[dict[str, Any]] = []
    forbidden: list[dict[str, Any]] = []
    snapshots = 0
    for event in events:
        if event.get("type") != "item.completed":
            continue
        item = event.get("item") or {}
        item_type = item.get("type")
        if item_type == "mcp_tool_call":
            calls.append(item)
            if item.get("server") != "causal_gate":
                forbidden.append(item)
                continue
            if item.get("tool") not in {"status", "commit", "chart_snapshot"}:
                forbidden.append(item)
            elif item.get("tool") == "chart_snapshot":
                snapshots += 1
        elif item_type in {
            "agent_message", "reasoning", "error", "message",
            "custom_tool_call_output", "custom_tool_call_input",
            "todo_list", "plan", "update_plan", "request_user_input",
            "collaboration_followup_task", "collaboration_spawn_agent",
        }:
            continue
        elif item_type in {"custom_tool_call", "function_call", "shell_command", "exec_command"}:
            forbidden.append(item)
        else:
            continue
    return calls, forbidden, snapshots


def usage_blocked(events: list[dict[str, Any]]) -> tuple[bool, str]:
    for event in events:
        if event.get("type") == "error":
            message = str(event.get("message") or "")
            if "usage limit" in message.lower() or "limit" in message.lower() and "retry" in message.lower():
                match = re.search(r"try again at (.+?)\.", message)
                return True, match.group(1) if match else "unknown"
    return False, ""


def run_turn(command: list[str], prompt: str, turn_no: int) -> tuple[list[dict[str, Any]], int]:
    env = os.environ.copy()
    env["CODEX_HOME"] = str(HOME)
    env["XAU_DATA_FILE"] = str(DATA)
    env["XAU_EXPECTED_SHA"] = data_sha256()
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
    return events, int(time.time() - started)


def setup_isolated_env() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    for name in ("xau_causal_gate.py", "xau_causal_mcp_server.py", "chart_text_snapshot.py"):
        shutil.copy2(REPO / name, WORK / name)
    HOME.mkdir(parents=True, exist_ok=True)
    auth_src = CODEX_HOME_SRC / "auth.json"
    if auth_src.exists():
        shutil.copy2(auth_src, HOME / "auth.json")
    catalog_src = CODEX_HOME_SRC / "cc-switch-model-catalog.json"
    if catalog_src.exists():
        shutil.copy2(catalog_src, HOME / "cc-switch-model-catalog.json")
    python = VENV_PYTHON if VENV_PYTHON.exists() else Path("python")
    python_toml = str(python).replace("\\", "/")
    server_toml = str(WORK / "xau_causal_mcp_server.py").replace("\\", "/")
    work_toml = str(WORK).replace("\\", "/")
    data_toml = str(DATA).replace("\\", "/")
    config = f"""model = "{MODEL}"
model_provider = "custom"
model_reasoning_effort = "{EFFORT}"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.custom]
name = "deepseek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
requires_openai_auth = true

[mcp_servers.causal_gate]
command = "{python_toml}"
args = ["{server_toml}"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.causal_gate.env]
XAU_DATA_FILE = "{data_toml}"
XAU_EXPECTED_SHA = "{data_sha256()}"

[projects.'{work_toml}']
trust_level = "trusted"
"""
    (HOME / "config.toml").write_text(config, encoding="utf-8")


def initial_prompt() -> str:
    rules1 = RULE_1.read_text(encoding="utf-8")
    rules2 = RULE_2.read_text(encoding="utf-8")
    return f"""你是正式的离线价格行为逐根回放判定器，模拟实时监控：每根 5 分钟 K 线收盘后你才拿到它，提交判断前因果门不会释放下一根，禁止任何未来信息。

可用工具（只有 causal_gate 服务器）：
- status：返回当前唯一 K、已确认枢轴（均 ≤ 当前 idx）、结构提示 structure_hint。
- commit：把当前根判断写入哈希链；写完后才返回下一根。
- chart_snapshot：返回“截止当前 K 的图表文字快照”（含最近 40 根明细、EMA/ATR、近 100 根区间、已确认枢轴），并保存 PNG 存档。只能查看 ≤ 当前 idx 的数据。

看图策略（关键）：
- 只有当 structure_hint.suggest_snapshot=true，或你从新 K 判断结构确实可能变化（突破/假突破、扫荡、EMA 交叉、缺口、异常大实体）时才调用 chart_snapshot。
- 普通延续、窄幅整理、趋势中途不要看图，避免浪费上下文。
- 每轮最多 {SNAPSHOTS_PER_TURN} 次，全程最多 {SNAPSHOTS_TOTAL} 次；超限即违规。

判断规则：
- 每根收盘后提交 NO_SIGNAL / OBSERVE / SIGNAL 三者之一。
- SIGNAL 只用于当前收盘时已具备可执行性的 Louie 正式机会；若仍需下一根确认，只能 OBSERVE。
- 不使用 A/B 等级；不添加固定 ATR、百分比、分数、冷却根数等规则原文没有的硬门槛；EMA/ATR 仅作辅助。
- 依次检查：环境/背景 → 位置 → 接受与跟随 → 被破坏的结构 → 当前触发。
- setup 用简短中文形态词；reason 必须简体中文，按“背景→位置→接受与跟随→触发”写 2–4 句，禁止英文。

commit 参数（必须一次给全，缺一不可）：
- idx：当前 status 返回的 idx；
- decision：NO_SIGNAL / OBSERVE / SIGNAL；
- direction：非 SIGNAL 时固定 none；SIGNAL 时必须 long 或 short；
- setup：简短中文形态词；
- reason：简体中文 2–4 句；
- evidence_indices：必须为只含当前 idx 的整数数组，例如 [7]；
- max_used_idx：必须等于当前 idx。
若 commit 被拒绝：仔细读错误信息，补齐或修正参数后立即重试，不要重复调用 status，也不要停手。

本轮要求：先调用 status，然后严格逐根 commit，最多处理 {TURN_LIMIT} 根或遇到 done=true 即停止。达到 {TURN_LIMIT} 根后结束本轮，不要总结后续行情。

===== 固定规则全文 1 =====
{rules1}
===== 固定规则全文 1 结束 =====

===== 固定规则全文 2 =====
{rules2}
===== 固定规则全文 2 结束 =====
"""


def continue_prompt() -> str:
    return f"""继续同一严格因果回放。只使用 causal_gate.status / commit / chart_snapshot；不得使用任何其他能力。先读 status，再逐根提交最多 {TURN_LIMIT} 根或 done=true 停止。commit 必须一次给全：idx=当前idx、decision、direction（非SIGNAL为none）、setup（中文）、reason（简体中文2-4句）、evidence_indices=[当前idx]、max_used_idx=当前idx；被拒就按错误修正立即重试。structure_hint.suggest_snapshot=true 时先 chart_snapshot 再看图提交。严格沿用本会话已加载的两份 Louie 规则；不看未来、不回填旧判断、不使用 A/B 或自创硬阈值；看图策略与中文输出要求不变。"""


def fresh_continue_prompt() -> str:
    return (
        "【重要背景】前 634 根（2026-07-31 03:00 ～ 2026-08-04 10:45 北京时间）已由同一套严格因果流程判定完成，"
        "哈希链连续（当前链尾会由 status 给出）。现在数据已扩展到最新：你从 status 返回的当前 idx 继续逐根判定，"
        "直到 done=true。不要因为‘之前已完成’而停止，以 status 为准；status 返回什么 idx 就提交什么 idx。\n\n"
        + initial_prompt()
    )


def stateless_prompt() -> str:
    nxt = int(state()["next_idx"])
    return (
        f"【本轮为无状态续跑】账本已连续提交到 idx={nxt - 1}，下一根是 idx={nxt}，总根数为 {total_bars()}。"
        "本轮是全新会话，只处理本轮的提交，结束后下一轮会再开新会话；不要依赖本会话记忆，"
        "所有结构状态一律通过 status 和 chart_snapshot（≤当前idx）获取。\n\n"
        + initial_prompt()
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true", help="Continue an existing causal ledger/session.")
    args = parser.parse_args()
    os.environ.setdefault("XAU_DATA_FILE", str(DATA))
    os.environ.setdefault("XAU_EXPECTED_SHA", data_sha256())
    setup_isolated_env()
    if args.resume:
        if not PROGRESS.exists() or not (LEDGER / "gate_state.json").exists():
            raise SystemExit("cannot resume: progress or causal ledger is missing")
        progress = json.loads(PROGRESS.read_text(encoding="utf-8"))
        new_thread = os.environ.get("CAUSAL_NEW_THREAD") == "1"
        if new_thread:
            thread_id = None
            turn_no = len(progress.get("turns", []))
        else:
            thread_id = progress.get("thread_id")
            if not thread_id:
                raise SystemExit("cannot resume: thread_id is missing")
            turn_no = 1 + max((int(item["turn"]) for item in progress.get("turns", [])), default=-1)
        progress.pop("error", None)
        progress.pop("forbidden", None)
        progress.pop("warnings", None)
        state_path = LEDGER / "gate_state.json"
        gate_state = json.loads(state_path.read_text(encoding="utf-8"))
        gate_state["data_sha256"] = data_sha256()
        state_path.write_text(json.dumps(gate_state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        progress.update(
            {
                "status": "running",
                "next_idx": int(state()["next_idx"]),
                "chain_sha256": state()["chain_sha256"],
                "total": total_bars(),
                "thread_id": thread_id,
                "snapshots_per_turn": SNAPSHOTS_PER_TURN,
                "snapshots_total": SNAPSHOTS_TOTAL,
                "resumed_at_epoch": int(time.time()),
            }
        )
        write_progress(progress)
    else:
        subprocess.run(
            [os.sys.executable, str(WORK / "xau_causal_gate.py"), "--data", str(DATA), "--out", str(LEDGER), "init"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        progress = {
            "status": "running",
            "model": MODEL,
            "reasoning_effort": EFFORT,
            "turns": [],
            "next_idx": 0,
            "total": total_bars(),
            "snapshots_per_turn": SNAPSHOTS_PER_TURN,
            "snapshots_total": SNAPSHOTS_TOTAL,
            "total_snapshots": 0,
        }
        write_progress(progress)
        thread_id = None
        turn_no = 0

    total = int(progress["total"])
    stateless = os.environ.get("CAUSAL_STATELESS") == "1"
    no_progress = 0
    while int(state()["next_idx"]) < total:
        before = int(state()["next_idx"])
        last_message = WORK / f"turn_{turn_no:03d}_last.txt"
        if stateless or thread_id is None:
            command = [
                "codex", "exec", "-", *COMMON,
                "-C", str(WORK),
                "-o", str(last_message),
            ]
            if stateless:
                prompt = stateless_prompt()
            elif os.environ.get("CAUSAL_NEW_THREAD") == "1":
                prompt = fresh_continue_prompt()
            else:
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

        blocked, retry_at = usage_blocked(events)
        if blocked:
            progress.update(
                {
                    "status": "blocked_usage",
                    "retry_at": retry_at,
                    "next_idx": int(state()["next_idx"]),
                    "thread_id": thread_id,
                    "turn": turn_no,
                }
            )
            write_progress(progress)
            return 5

        calls, forbidden, snapshots = validate_events(events)
        after = int(state()["next_idx"])
        total_snapshots = int(progress.get("total_snapshots", 0)) + snapshots
        turn_info = {
            "turn": turn_no,
            "before_idx": before,
            "after_idx": after,
            "commits": sum(1 for c in calls if c.get("tool") == "commit" and c.get("status") == "completed"),
            "status_calls": sum(1 for c in calls if c.get("tool") == "status"),
            "snapshots": snapshots,
            "forbidden_count": len(forbidden),
            "duration_seconds": duration,
        }
        progress["turns"].append(turn_info)
        progress["thread_id"] = thread_id
        progress["next_idx"] = after
        progress["chain_sha256"] = state()["chain_sha256"]
        progress["total_snapshots"] = total_snapshots
        write_progress(progress)

        if forbidden:
            progress.update({"status": "failed", "error": "forbidden tool item", "forbidden": forbidden[:5]})
            write_progress(progress)
            return 3
        if total_snapshots > SNAPSHOTS_TOTAL:
            progress.update({"status": "failed", "error": "snapshot budget exceeded", "turn": turn_no})
            write_progress(progress)
            return 6
        if snapshots > SNAPSHOTS_PER_TURN:
            progress.setdefault("warnings", []).append({"turn": turn_no, "snapshots": snapshots})
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
