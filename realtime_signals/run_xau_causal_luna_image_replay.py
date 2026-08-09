#!/usr/bin/env python3
"""Run the final 500 XAUUSD bars with Luna Max and visual chart snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
REPO = ROOT / "realtime_signals"
DATA = Path(
    os.environ.get(
        "CAUSAL_DATA",
        str(Path.home() / "AppData" / "Local" / "Temp" / "xauusd_causal_extended_20260807.json"),
    )
)
WORK = Path(
    os.environ.get(
        "CAUSAL_LUNA_IMAGE_WORK",
        str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-luna-image-last500-work"),
    )
)
ISOLATED_CODEX_HOME = Path(
    os.environ.get(
        "CAUSAL_LUNA_IMAGE_HOME",
        str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-luna-image-last500-home"),
    )
)
OUTPUT_DIR = Path(
    os.environ.get(
        "CAUSAL_LUNA_IMAGE_OUTPUT",
        str(ROOT / "outputs" / "xauusd_replay_5m_20260808_luna_image_last500"),
    )
)
LEDGER = WORK / "ledger"
PROGRESS = WORK / "orchestrator_progress.json"
RULE_1 = ROOT / "migration" / "codex-handoff" / "source-rules" / "Louie交易规则完整整理_案例扩展版.md"
RULE_2 = ROOT / "migration" / "codex-handoff" / "source-rules" / "louie-case-expanded.md"

MODEL = os.environ.get("CAUSAL_MODEL", "gpt-5.6-luna")
EFFORT = os.environ.get("CAUSAL_EFFORT", "max")
START_IDX = int(os.environ.get("CAUSAL_START_IDX", "999"))
BAR_COUNT = 500
END_IDX = START_IDX + BAR_COUNT
TURN_LIMIT = int(os.environ.get("CAUSAL_TURN_LIMIT", "30"))
TURN_TIMEOUT = int(os.environ.get("CAUSAL_TURN_TIMEOUT", "1800"))
SNAPSHOTS_PER_TURN = 12
SNAPSHOTS_TOTAL = 800
PROMPT_MODE = os.environ.get("CAUSAL_LUNA_PROMPT_MODE", "current")

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


def state() -> dict[str, Any]:
    return json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))


def data_sha256() -> str:
    return hashlib.sha256(DATA.read_bytes()).hexdigest()


def gate_environment() -> dict[str, str]:
    env = os.environ.copy()
    env["XAU_DATA_FILE"] = str(DATA)
    env["XAU_EXPECTED_SHA"] = data_sha256()
    env["CAUSAL_START_IDX"] = str(START_IDX)
    env["CAUSAL_MODEL"] = MODEL
    env["CAUSAL_EFFORT"] = EFFORT
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def run_gate(arguments: list[str]) -> dict[str, Any]:
    python = VENV_PYTHON if VENV_PYTHON.exists() else Path("python")
    completed = subprocess.run(
        [str(python), str(WORK / "xau_causal_gate.py"), "--data", str(DATA), "--out", str(LEDGER), *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=gate_environment(),
    )
    return json.loads(completed.stdout)


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
            if item.get("server") != "causal_gate" or item.get("tool") not in {"status", "commit", "chart_snapshot"}:
                forbidden.append(item)
            elif item.get("tool") == "chart_snapshot":
                snapshots += 1
        elif item_type in {
            "agent_message", "reasoning", "error", "message", "custom_tool_call_output",
            "custom_tool_call_input", "todo_list", "plan", "update_plan", "request_user_input",
            "collaboration_followup_task", "collaboration_spawn_agent",
        }:
            continue
        elif item_type in {"custom_tool_call", "function_call", "shell_command", "exec_command"}:
            forbidden.append(item)
    return calls, forbidden, snapshots


def usage_blocked(events: list[dict[str, Any]]) -> tuple[bool, str]:
    for event in events:
        if event.get("type") != "error":
            continue
        message = str(event.get("message") or "")
        lower = message.lower()
        if "usage limit" in lower or ("limit" in lower and "retry" in lower):
            return True, message
    return False, ""


def setup_isolated_env() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    for name in (
        "xau_causal_gate.py",
        "chart_text_snapshot.py",
        "xau_causal_luna_image_mcp_server.py",
    ):
        shutil.copy2(REPO / name, WORK / name)
    ISOLATED_CODEX_HOME.mkdir(parents=True, exist_ok=True)
    auth_src = Path.home() / ".codex" / "auth.json"
    if auth_src.exists():
        shutil.copy2(auth_src, ISOLATED_CODEX_HOME / "auth.json")
    python = VENV_PYTHON if VENV_PYTHON.exists() else Path("python")
    python_toml = str(python).replace("\\", "/")
    server_toml = str(WORK / "xau_causal_luna_image_mcp_server.py").replace("\\", "/")
    work_toml = str(WORK).replace("\\", "/")
    data_toml = str(DATA).replace("\\", "/")
    config = f'''model = "{MODEL}"
model_reasoning_effort = "{EFFORT}"
approval_policy = "never"
sandbox_mode = "read-only"

[mcp_servers.causal_gate]
command = "{python_toml}"
args = ["{server_toml}"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.causal_gate.env]
XAU_DATA_FILE = "{data_toml}"
XAU_EXPECTED_SHA = "{data_sha256()}"
CAUSAL_START_IDX = "{START_IDX}"
CAUSAL_MODEL = "{MODEL}"
CAUSAL_EFFORT = "{EFFORT}"
XAU_TEXT_ONLY = "{os.environ.get('CAUSAL_TEXT_ONLY', '0')}"

[projects.'{work_toml}']
trust_level = "trusted"
'''
    (ISOLATED_CODEX_HOME / "config.toml").write_text(config, encoding="utf-8")


def prompt() -> str:
    rules1 = RULE_1.read_text(encoding="utf-8")
    rules2 = RULE_2.read_text(encoding="utf-8")
    structural_dedup_rule = "" if PROMPT_MODE == "legacy" else """- 结构级去重：同一背景、同一结构腿内的延续、普通回测、二次推进或微型突破，若没有形成独立新论点，优先判 OBSERVE；反向 SIGNAL 必须先证明旧结构失效且新方向已经接受与跟随。不得用固定时间/K线冷却代替结构判断。
"""
    return f"""你是正式的离线价格行为逐根回放判断器，使用 {MODEL}、{EFFORT} 推理强度。

这次只回放完整冻结数据的最后 {BAR_COUNT} 根：原始 idx={START_IDX} 到 idx={END_IDX - 1}，一根不少。原始 idx 0 到 {START_IDX - 1} 已预加载，仅用于计算 EMA/ATR、已确认枢轴和结构上下文，不提交任何历史判断，也不能引用其后的未来K线。

严格因果：每根5分钟K线收盘后才能判断；只有 commit 当前 idx 写入哈希链后，因果门才释放下一根。只允许使用 causal_gate 的 status、commit、chart_snapshot 三个工具。不得使用 Shell、文件、网络、TradingView、数据库、基准答案或子代理能力。

图像识别要求：chart_snapshot 返回截止当前 idx 的结构化文字和一张实际 PNG 图像。调用后必须同时检查文字与图像，确认市场背景、区间/通道、支撑压力、突破或扫荡是否被接受；PNG 也只能包含当前及此前K线，绝不能据图推断未来。普通延续和窄幅整理不要机械调用；当 structure_hint.suggest_snapshot=true，或出现突破/假突破、扫荡、EMA交叉、缺口、异常大实体时，优先调用 chart_snapshot。

判断口径：
- 每根提交 NO_SIGNAL / OBSERVE / SIGNAL 三者之一。
- SIGNAL 只用于当前收盘已经可执行的 Louie 正式机会；仍需下一根确认只能 OBSERVE。
{structural_dedup_rule}- 不使用A/B等级，不添加固定ATR、百分比、分数、冷却根数等规则原文没有的硬门槛。
- 不使用A/B等级，不添加固定ATR、百分比、分数、冷却根数等规则原文没有的硬门槛。
- 依次检查：环境/背景 → 位置 → 接受与跟随 → 被破坏的结构 → 当前触发；EMA/ATR只作辅助。
- setup 用简短中文形态词；reason 用简体中文2–4句，按“背景→位置→接受与跟随→触发”。

commit 必须一次给全：idx=当前 status 返回的 idx；decision；direction（非SIGNAL固定 none）；setup；reason；evidence_indices=[当前idx]；max_used_idx=当前idx。不得回填旧判断，不能引用 idx 之后的信息。

本轮先读 status，再逐根提交最多 {TURN_LIMIT} 根；达到上限后停止，不要总结后续行情。完成 idx={END_IDX - 1} 后停止。

===== 固定规则全文 1 =====
{rules1}
===== 固定规则全文 1 结束 =====

===== 固定规则全文 2 =====
{rules2}
===== 固定规则全文 2 结束 =====
"""


def run_turn(turn_no: int) -> tuple[list[dict[str, Any]], int, int, str]:
    last_message = WORK / f"turn_{turn_no:03d}_last.txt"
    command = ["codex", "exec", "-", *COMMON, "-C", str(WORK), "-o", str(last_message)]
    env = os.environ.copy()
    env["CODEX_HOME"] = str(ISOLATED_CODEX_HOME)
    env.update(gate_environment())
    started = time.time()
    try:
        completed = subprocess.run(
            command,
            input=prompt(),
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            env=env,
            timeout=TURN_TIMEOUT,
            check=False,
        )
        stdout = completed.stdout
        stderr = completed.stderr
        returncode = completed.returncode
    except subprocess.TimeoutExpired as exc:
        # Preserve any JSON events emitted before the timeout. The gate is
        # independently durable, so the outer loop can continue from its
        # actual next_idx on the next turn.
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        stderr = f"{stderr}\n[turn timeout after {TURN_TIMEOUT}s]\n"
        returncode = 124
    (WORK / f"turn_{turn_no:03d}.jsonl").write_text(stdout, encoding="utf-8")
    (WORK / f"turn_{turn_no:03d}.stderr.txt").write_text(stderr, encoding="utf-8")
    return parse_events(stdout), int(time.time() - started), returncode, stderr


def publish_outputs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("decisions.jsonl", "gate_state.json", "manifest.json"):
        shutil.copy2(LEDGER / name, OUTPUT_DIR / name)
    for name in ("orchestrator_progress.json", "snapshot_log.jsonl", "mcp_debug.log"):
        source = WORK / name
        if source.exists():
            shutil.copy2(source, OUTPUT_DIR / name)
    turn_dir = OUTPUT_DIR / "turn_logs"
    turn_dir.mkdir(parents=True, exist_ok=True)
    for source in WORK.glob("turn_*"):
        if source.is_file():
            shutil.copy2(source, turn_dir / source.name)
    snapshot_dir = OUTPUT_DIR / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    for source in (WORK / "snapshots").glob("*.png"):
        shutil.copy2(source, snapshot_dir / source.name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true", help="Resume an existing isolated 500-bar run.")
    args = parser.parse_args()
    if not DATA.exists():
        raise SystemExit(f"data file not found: {DATA}")
    digest = data_sha256()
    if START_IDX < 0:
        raise SystemExit(f"invalid start idx: {START_IDX}")
    if OUTPUT_DIR.exists() and not args.resume and (OUTPUT_DIR / "decisions.jsonl").exists():
        raise SystemExit(f"output already exists; use a new output/work directory: {OUTPUT_DIR}")
    setup_isolated_env()
    if args.resume:
        if not PROGRESS.exists() or not (LEDGER / "gate_state.json").exists():
            raise SystemExit("cannot resume: progress or causal ledger is missing")
        progress = json.loads(PROGRESS.read_text(encoding="utf-8"))
        turn_no = len(progress.get("turns", []))
        progress.update({"status": "running", "next_idx": int(state()["next_idx"]), "data_sha256": digest})
        write_progress(progress)
    else:
        if (LEDGER / "gate_state.json").exists():
            raise SystemExit(f"work directory already has a ledger; use --resume or a new work directory: {WORK}")
        run_gate(["init"])
        progress = {
            "status": "running",
            "model": MODEL,
            "reasoning_effort": EFFORT,
            "start_idx": START_IDX,
            "end_idx_exclusive": END_IDX,
            "bar_count": BAR_COUNT,
            "data_sha256": digest,
            "turns": [],
            "next_idx": START_IDX,
            "snapshots_per_turn": SNAPSHOTS_PER_TURN,
            "snapshots_total": SNAPSHOTS_TOTAL,
            "total_snapshots": 0,
        }
        write_progress(progress)
        turn_no = 0

    no_progress = 0
    while int(state()["next_idx"]) < END_IDX:
        before = int(state()["next_idx"])
        events, duration, returncode, stderr = run_turn(turn_no)
        after = int(state()["next_idx"])
        calls, forbidden, snapshots = validate_events(events)
        progress["turns"].append(
            {
                "turn": turn_no,
                "before_idx": before,
                "after_idx": after,
                "commits": sum(1 for c in calls if c.get("tool") == "commit" and c.get("status") == "completed"),
                "status_calls": sum(1 for c in calls if c.get("tool") == "status"),
                "snapshots": snapshots,
                "forbidden_count": len(forbidden),
                "codex_returncode": returncode,
                "duration_seconds": duration,
            }
        )
        progress["next_idx"] = after
        progress["chain_sha256"] = state()["chain_sha256"]
        progress["total_snapshots"] = int(progress.get("total_snapshots", 0)) + snapshots
        write_progress(progress)
        if returncode != 0 and after <= before:
            progress.update({"status": "failed", "error": f"codex returncode={returncode}", "stderr_tail": stderr[-2000:]})
            write_progress(progress)
            return 2
        if forbidden:
            progress.update({"status": "failed", "error": "forbidden tool item", "forbidden": forbidden[:5]})
            write_progress(progress)
            return 3
        if int(progress["total_snapshots"]) > SNAPSHOTS_TOTAL:
            progress.update({"status": "failed", "error": "snapshot budget exceeded"})
            write_progress(progress)
            return 4
        if snapshots > SNAPSHOTS_PER_TURN:
            progress.setdefault("warnings", []).append({"turn": turn_no, "snapshots": snapshots})
        if after <= before:
            no_progress += 1
        else:
            no_progress = 0
        if no_progress >= 2:
            progress.update({"status": "failed", "error": "two turns without progress"})
            write_progress(progress)
            return 5
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
    publish_outputs()
    print(json.dumps({"status": "complete", "output_dir": str(OUTPUT_DIR), "start_idx": START_IDX, "end_idx": END_IDX - 1}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
