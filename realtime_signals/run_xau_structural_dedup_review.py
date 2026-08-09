#!/usr/bin/env python3
"""Review existing Luna replay SIGNALs with a causal structural de-dup gate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
REPO = Path(__file__).resolve().parent
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
DATA = Path(
    os.environ.get(
        "XAU_DATA_FILE",
        str(Path.home() / "AppData" / "Local" / "Temp" / "xauusd_causal_extended_20260807.json"),
    )
)
SOURCE_DIR = Path(
    os.environ.get(
        "XAU_DEDUP_SOURCE_DIR",
        str(ROOT / "outputs" / "xauusd_replay_5m_20260808_luna_image_last500"),
    )
)
SOURCE_LEDGER = Path(
    os.environ.get("XAU_DEDUP_SOURCE_LEDGER", str(SOURCE_DIR / "decisions.jsonl"))
)
WORK = Path(
    os.environ.get(
        "XAU_DEDUP_WORK",
        str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-structural-dedup-review-work"),
    )
)
ISOLATED_CODEX_HOME = Path(
    os.environ.get(
        "XAU_DEDUP_HOME",
        str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-structural-dedup-review-home"),
    )
)
OUTPUT_DIR = Path(
    os.environ.get(
        "XAU_DEDUP_OUTPUT_DIR",
        str(ROOT / "outputs" / "xauusd_replay_5m_20260808_luna_structural_dedup"),
    )
)
REVIEWS = WORK / "dedup_reviews.jsonl"
STATE = WORK / "review_state.json"
PROGRESS = WORK / "orchestrator_progress.json"
MODEL = "gpt-5.6-luna"
EFFORT = "max"
TURN_LIMIT = int(os.environ.get("CAUSAL_DEDUP_TURN_LIMIT", "20"))
TURN_TIMEOUT = int(os.environ.get("CAUSAL_DEDUP_TURN_TIMEOUT", "1800"))
START_IDX = 999
END_IDX = 1499
RULE_1 = ROOT / "migration" / "codex-handoff" / "source-rules" / "Louie交易规则完整整理_案例扩展版.md"
RULE_2 = ROOT / "migration" / "codex-handoff" / "source-rules" / "louie-case-expanded.md"

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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_rows() -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in SOURCE_LEDGER.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def candidates() -> list[dict[str, Any]]:
    rows = [row for row in source_rows() if row.get("decision") == "SIGNAL"]
    return sorted(rows, key=lambda row: int(row["idx"]))


def state() -> dict[str, Any]:
    return json.loads(STATE.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict[str, Any]) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def write_progress(value: dict[str, Any]) -> None:
    write_json(PROGRESS, value)


def setup_isolated_env() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    for name in (
        "xau_causal_gate.py",
        "chart_text_snapshot.py",
        "xau_structural_dedup_mcp_server.py",
    ):
        shutil.copy2(REPO / name, WORK / name)
    ISOLATED_CODEX_HOME.mkdir(parents=True, exist_ok=True)
    auth_src = Path.home() / ".codex" / "auth.json"
    if auth_src.exists():
        shutil.copy2(auth_src, ISOLATED_CODEX_HOME / "auth.json")
    python = VENV_PYTHON if VENV_PYTHON.exists() else Path("python")
    python_toml = str(python).replace("\\", "/")
    server_toml = str(WORK / "xau_structural_dedup_mcp_server.py").replace("\\", "/")
    work_toml = str(WORK).replace("\\", "/")
    data_toml = str(DATA).replace("\\", "/")
    source_toml = str(SOURCE_LEDGER).replace("\\", "/")
    config = f'''model = "{MODEL}"
model_reasoning_effort = "{EFFORT}"
approval_policy = "never"
sandbox_mode = "read-only"

[mcp_servers.structural_dedup]
command = "{python_toml}"
args = ["{server_toml}"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.structural_dedup.env]
XAU_DATA_FILE = "{data_toml}"
XAU_EXPECTED_SHA = "{sha256_file(DATA)}"
XAU_DEDUP_WORK = "{work_toml}"
XAU_DEDUP_SOURCE_LEDGER = "{source_toml}"

[projects.'{work_toml}']
trust_level = "trusted"
'''
    (ISOLATED_CODEX_HOME / "config.toml").write_text(config, encoding="utf-8")


def init_review() -> dict[str, Any]:
    items = candidates()
    if not items:
        raise SystemExit("source ledger contains no SIGNAL candidates")
    if any(not START_IDX <= int(item["idx"]) < END_IDX for item in items):
        raise SystemExit("source candidates fall outside the intended last-500 window")
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "snapshots").mkdir(parents=True, exist_ok=True)
    REVIEWS.write_text("", encoding="utf-8")
    value = {
        "version": 1,
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "source_ledger": str(SOURCE_LEDGER),
        "source_ledger_sha256": sha256_file(SOURCE_LEDGER),
        "data_sha256": sha256_file(DATA),
        "source_signal_count": len(items),
        "next_candidate_position": 0,
        "chain_sha256": "0" * 64,
        "structural_dedup": True,
        "fixed_time_cooldown": False,
    }
    write_json(STATE, value)
    return value


def prompt() -> str:
    rules1 = RULE_1.read_text(encoding="utf-8")
    rules2 = RULE_2.read_text(encoding="utf-8")
    return f"""你是 XAUUSD 严格因果回放的结构级去重审核器，使用 GPT-5.6 Luna Max、max 推理强度。

这不是重新生成信号，也不能创建新信号。你要按时间顺序复核已有的 {len(candidates())} 个候选 SIGNAL，逐个决定 KEEP 或 REMOVE。候选来自原始冻结数据最后500根（idx {START_IDX}–{END_IDX - 1}），每个候选的原始理由由 status 给出。

严格因果：status 每次只释放一个当前候选；只能使用当前候选及此前已审核历史。不能使用后续候选、未来K线、v3基准、文件、Shell、网络、TradingView、数据库或子代理。commit 当前候选后才会释放下一个候选。

允许的工具只有 structural_dedup 的 status、commit、chart_snapshot。chart_snapshot 只允许查看当前候选 idx 及之前的数据，返回结构化文字和实际 PNG；调用后必须同时检查文字与图像。不要根据后来走势评价原候选。

结构级去重口径（不是固定冷却）：
1. KEEP 只用于独立的结构论点/新结构腿，且当前收盘已经有接受与跟随。
2. 如果当前候选只是此前已保留信号的同一背景、同一结构腿里的延续、普通回测、二次推进、微型突破或局部反复，REMOVE；即使形态名字不同，只要交易论点没有重置，也算重复。
3. 反向候选只有在此前方向的结构明确失效、市场回到/穿过关键结构并对新方向形成接受与跟随时才 KEEP；否则 REMOVE。
4. 同方向后续候选只有在原结构完成重置并出现独立的新背景/新边界/新腿时才 KEEP。不能用固定的分钟数、K线数、ATR、百分比或分数代替结构判断。
5. 规则优先级是“背景 → 位置 → 接受与跟随 → 结构是否被破坏 → 当前触发”。“二次进攻”不能机械地因为数到第二次就 KEEP。

每个候选必须：先 status；需要时 chart_snapshot；最后恰好一次 commit。commit 参数：candidate_position、idx、action（KEEP/REMOVE）、relation、review_reason。KEEP 的 relation 只能是 distinct_structure 或 structure_invalidated；REMOVE 的 relation 只能是 same_structure_continuation、microstructure_duplicate、not_accepted、late_retrigger 或 unclear。review_reason 用简体中文1–3句，说明为什么是新结构或为什么属于同一结构重复。

不要提前总结，也不要跳过候选。完成全部候选后停止。

===== 固定规则全文 1 =====
{rules1}
===== 固定规则全文 1 结束 =====
===== 固定规则全文 2 =====
{rules2}
===== 固定规则全文 2 结束 =====
"""


def parse_events(text: str) -> list[dict[str, Any]]:
    events = []
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
            if item.get("server") != "structural_dedup" or item.get("tool") not in {"status", "commit", "chart_snapshot"}:
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


def run_turn(turn_no: int) -> tuple[list[dict[str, Any]], int, int, str]:
    last_message = WORK / f"turn_{turn_no:03d}_last.txt"
    command = ["codex", "exec", "-", *COMMON, "-C", str(WORK), "-o", str(last_message)]
    env = os.environ.copy()
    env["CODEX_HOME"] = str(ISOLATED_CODEX_HOME)
    env["XAU_DATA_FILE"] = str(DATA)
    env["XAU_EXPECTED_SHA"] = sha256_file(DATA)
    env["XAU_DEDUP_WORK"] = str(WORK)
    env["XAU_DEDUP_SOURCE_LEDGER"] = str(SOURCE_LEDGER)
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
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        stderr = f"{stderr}\n[review turn timeout after {TURN_TIMEOUT}s]\n"
        returncode = 124
    (WORK / f"turn_{turn_no:03d}.jsonl").write_text(stdout, encoding="utf-8")
    (WORK / f"turn_{turn_no:03d}.stderr.txt").write_text(stderr, encoding="utf-8")
    return parse_events(stdout), int(time.time() - started), returncode, stderr


def load_reviews() -> list[dict[str, Any]]:
    if not REVIEWS.exists():
        return []
    return [json.loads(line) for line in REVIEWS.read_text(encoding="utf-8").splitlines() if line.strip()]


def verify_reviews() -> dict[str, Any]:
    items = candidates()
    reviews = load_reviews()
    previous = "0" * 64
    errors: list[str] = []
    for position, row in enumerate(reviews):
        expected = items[position] if position < len(items) else None
        if expected is None or int(row.get("candidate_position", -1)) != position:
            errors.append(f"position mismatch at {position}")
            continue
        if int(row.get("candidate_idx", -1)) != int(expected["idx"]):
            errors.append(f"idx mismatch at {position}")
        body = {key: value for key, value in row.items() if key not in {"record_sha256", "chain_sha256"}}
        record_sha = hashlib.sha256(
            json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        chain = hashlib.sha256((previous + record_sha).encode("ascii")).hexdigest()
        if row.get("previous_chain_sha256") != previous or row.get("record_sha256") != record_sha or row.get("chain_sha256") != chain:
            errors.append(f"hash mismatch at {position}")
        if row.get("causal_cutoff_idx") != row.get("candidate_idx") or row.get("no_future_data") is not True:
            errors.append(f"causal mismatch at {position}")
        previous = chain
    final_state = state()
    if len(reviews) != len(items):
        errors.append(f"review count {len(reviews)} != candidate count {len(items)}")
    if int(final_state.get("next_candidate_position", -1)) != len(items):
        errors.append("state did not reach end")
    if final_state.get("chain_sha256") != previous:
        errors.append("state chain tail mismatch")
    counts = Counter(row.get("action") for row in reviews)
    return {
        "source_signal_count": len(items),
        "reviewed_count": len(reviews),
        "kept_count": counts.get("KEEP", 0),
        "removed_count": counts.get("REMOVE", 0),
        "relation_counts": dict(Counter(row.get("relation") for row in reviews)),
        "kept_indices": [int(row["candidate_idx"]) for row in reviews if row.get("action") == "KEEP"],
        "removed_indices": [int(row["candidate_idx"]) for row in reviews if row.get("action") == "REMOVE"],
        "errors": errors,
    }


def write_summary(summary: dict[str, Any]) -> None:
    write_json(WORK / "dedup_summary.json", summary)
    lines = [
        "# XAUUSD Luna Max 结构级去重复核",
        "",
        f"- 原始候选 SIGNAL：{summary['source_signal_count']} 个",
        f"- 保留：{summary['kept_count']} 个",
        f"- 删除：{summary['removed_count']} 个",
        "- 规则：结构级去重，不使用固定时间冷却。",
        "",
        "## 保留信号",
        "",
        ", ".join(str(idx) for idx in summary["kept_indices"]),
        "",
        "## 删除信号",
        "",
        ", ".join(str(idx) for idx in summary["removed_indices"]),
        "",
        "## 删除/保留原因",
        "",
    ]
    for row in load_reviews():
        lines.append(
            f"- idx {row['candidate_idx']}：{row['action']}；{row['relation']}；{row['review_reason']}"
        )
    (WORK / "dedup_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def publish_outputs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in (
        "dedup_reviews.jsonl", "review_state.json", "dedup_summary.json", "dedup_summary.md",
        "orchestrator_progress.json", "snapshot_log.jsonl", "mcp_debug.log",
    ):
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
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if not DATA.exists() or not SOURCE_LEDGER.exists():
        raise SystemExit("source data or Luna ledger is missing")
    setup_isolated_env()
    if args.resume:
        if not STATE.exists() or not PROGRESS.exists():
            raise SystemExit("cannot resume: review state or progress is missing")
        progress = json.loads(PROGRESS.read_text(encoding="utf-8"))
        progress["status"] = "running"
        progress["next_candidate_position"] = int(state()["next_candidate_position"])
        write_progress(progress)
        turn_no = len(progress.get("turns", []))
    else:
        if STATE.exists() or REVIEWS.exists():
            raise SystemExit(f"review work already exists; use --resume: {WORK}")
        init_review()
        progress = {
            "status": "running",
            "model": MODEL,
            "reasoning_effort": EFFORT,
            "source_signal_count": len(candidates()),
            "next_candidate_position": 0,
            "turns": [],
            "total_snapshots": 0,
            "fixed_time_cooldown": False,
        }
        write_progress(progress)
        turn_no = 0

    no_progress = 0
    while int(state()["next_candidate_position"]) < len(candidates()):
        before = int(state()["next_candidate_position"])
        events, duration, returncode, stderr = run_turn(turn_no)
        after = int(state()["next_candidate_position"])
        calls, forbidden, snapshots = validate_events(events)
        progress["turns"].append(
            {
                "turn": turn_no,
                "before_candidate_position": before,
                "after_candidate_position": after,
                "commits": sum(1 for call in calls if call.get("tool") == "commit"),
                "status_calls": sum(1 for call in calls if call.get("tool") == "status"),
                "snapshots": snapshots,
                "forbidden_count": len(forbidden),
                "codex_returncode": returncode,
                "duration_seconds": duration,
            }
        )
        progress["next_candidate_position"] = after
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
        if after <= before:
            no_progress += 1
        else:
            no_progress = 0
        if no_progress >= 2:
            progress.update({"status": "failed", "error": "two review turns without progress"})
            write_progress(progress)
            return 4
        turn_no += 1

    summary = verify_reviews()
    write_summary(summary)
    if summary["errors"]:
        progress.update({"status": "failed", "error": "review audit failed", "audit_errors": summary["errors"]})
        write_progress(progress)
        return 5
    progress.update({"status": "complete", "next_candidate_position": len(candidates()), "finished_at_epoch": int(time.time())})
    write_progress(progress)
    summary = verify_reviews()
    write_summary(summary)
    publish_outputs()
    print(json.dumps({"status": "complete", **summary, "output_dir": str(OUTPUT_DIR)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
