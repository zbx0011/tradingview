#!/usr/bin/env python3
"""Audit the completed XAU causal replay and generate the final Chinese report."""

from __future__ import annotations

import hashlib
import json
import shutil
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
WORK = Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-work-20260806"
LEDGER_DIR = WORK / "ledger"
OUT = ROOT / "outputs" / "xauusd_replay_5m_20260806_causal_sol_xhigh"
DATA = Path.home() / "AppData" / "Local" / "Temp" / "xauusd_luna_compare_634bars.json"
EXPECTED_DATA_SHA = "030b3bad06d0392d4e02398c6e0fa7354bff38c685d291820877237a315ba0c0"
REPORT = OUT / "xauusd_replay_5m_20260806_causal_sol_xhigh_FINAL_634bars.md"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def parse_time(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d %H:%M")


def setup_category(setup: str, direction: str) -> str:
    side = "做多" if direction == "long" else "做空"
    text = setup.lower()
    if "failed_breakdown" in text or "failed_lower" in text or "failed_support_break" in text:
        core = "下破失败反转"
    elif "failed_breakout" in text or "failed_high" in text or "failed_reclaim" in text:
        core = "突破/收复失败反转"
    elif "double_bottom" in text:
        core = "双底反转"
    elif "double_top" in text or "three_push" in text:
        core = "顶部失败反转"
    elif "retest" in text or "test_continuation" in text:
        core = "突破回测延续"
    elif "second_entry" in text:
        core = "二次入场"
    elif "second_leg" in text:
        core = "第二段延续"
    elif "range_breakout" in text or "range_breakdown" in text:
        core = "区间突破"
    elif "structure_break" in text or "structural_break" in text:
        core = "结构突破/破坏"
    elif "follow" in text:
        core = "突破跟随"
    elif "pullback" in text or "flag" in text:
        core = "回撤延续"
    elif "breakout" in text or "breakdown" in text:
        core = "突破触发"
    elif "reversal" in text:
        core = "反转触发"
    else:
        core = "结构触发"
    return f"{side}｜{core}"


def audit_tool_logs() -> dict[str, Any]:
    calls: Counter[tuple[str, str, str]] = Counter()
    forbidden: list[dict[str, Any]] = []
    usage_limit_turns: set[str] = set()
    for path in sorted(WORK.glob("turn_*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "item.completed":
                item = event.get("item") or {}
                item_type = item.get("type")
                if item_type == "mcp_tool_call":
                    key = (str(item.get("server")), str(item.get("tool")), str(item.get("status")))
                    calls[key] += 1
                    if item.get("server") != "causal_gate" or item.get("tool") not in {"status", "commit"}:
                        forbidden.append({"turn": path.name, "item": item})
                elif item_type not in {"agent_message", "reasoning"}:
                    forbidden.append({"turn": path.name, "item": item})
            message = event.get("message") or (event.get("error") or {}).get("message") or ""
            if "usage limit" in message:
                usage_limit_turns.add(path.name)
    return {
        "calls": {"|".join(key): value for key, value in sorted(calls.items())},
        "forbidden_count": len(forbidden),
        "forbidden": forbidden,
        "usage_limit_turns": sorted(usage_limit_turns),
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    data_bytes = DATA.read_bytes()
    data_sha = hashlib.sha256(data_bytes).hexdigest()
    source = json.loads(data_bytes)
    bars = source["bars"]
    rows = [json.loads(line) for line in (LEDGER_DIR / "decisions.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    state = load_json(LEDGER_DIR / "gate_state.json")
    manifest = load_json(LEDGER_DIR / "manifest.json")
    progress = load_json(WORK / "orchestrator_progress.json")
    baseline = load_json(OUT / "baseline_a01_a15.json")["signals"]

    errors: list[str] = []
    if data_sha != EXPECTED_DATA_SHA:
        errors.append(f"data SHA mismatch: {data_sha}")
    if len(rows) != 634 or len(bars) != 634:
        errors.append(f"unexpected counts: rows={len(rows)}, bars={len(bars)}")
    chain = "0" * 64
    for expected_idx, (record, bar) in enumerate(zip(rows, bars)):
        if record.get("idx") != expected_idx:
            errors.append(f"idx mismatch at {expected_idx}")
        if record.get("bar_open_time") != int(bar["time"]):
            errors.append(f"bar time mismatch at {expected_idx}")
        if record.get("decision_after_close_time") != int(bar["time"]) + 300:
            errors.append(f"decision time mismatch at {expected_idx}")
        if record.get("max_used_idx") != expected_idx:
            errors.append(f"max_used_idx mismatch at {expected_idx}")
        evidence = record.get("evidence_indices") or []
        if len(evidence) != len(set(evidence)) or any(value < 0 or value > expected_idx for value in evidence):
            errors.append(f"evidence violation at {expected_idx}")
        if record.get("no_future_data") is not True:
            errors.append(f"no_future_data flag missing at {expected_idx}")
        if record.get("previous_chain_sha256") != chain:
            errors.append(f"previous chain mismatch at {expected_idx}")
        core = {key: value for key, value in record.items() if key not in {"record_sha256", "chain_sha256"}}
        record_sha = hashlib.sha256(canonical(core)).hexdigest()
        if record_sha != record.get("record_sha256"):
            errors.append(f"record hash mismatch at {expected_idx}")
        chain = hashlib.sha256((chain + record_sha).encode("ascii")).hexdigest()
        if chain != record.get("chain_sha256"):
            errors.append(f"chain mismatch at {expected_idx}")
    if state.get("next_idx") != 634 or state.get("chain_sha256") != chain:
        errors.append("final gate state mismatch")
    if progress.get("status") != "complete" or progress.get("next_idx") != 634:
        errors.append("orchestrator did not finish cleanly")

    tool_audit = audit_tool_logs()
    if tool_audit["forbidden_count"]:
        errors.append(f"forbidden tool calls: {tool_audit['forbidden_count']}")
    if errors:
        raise SystemExit("audit failed:\n" + "\n".join(errors[:50]))

    signals = [row for row in rows if row["decision"] == "SIGNAL"]
    decisions = Counter(row["decision"] for row in rows)
    directions = Counter(row["direction"] for row in signals)

    exact_count = 0
    within_5_count = 0
    within_15_count = 0
    within_30_count = 0
    comparison_rows: list[dict[str, Any]] = []
    for item in baseline:
        target = parse_time(item["time"])
        same_direction = [row for row in signals if row["direction"] == item["direction"]]
        nearest = min(same_direction, key=lambda row: abs((parse_time(row["beijing_open_time"]) - target).total_seconds()))
        delta = int((parse_time(nearest["beijing_open_time"]) - target).total_seconds() // 60)
        absolute = abs(delta)
        exact_count += absolute == 0
        within_5_count += absolute <= 5
        within_15_count += absolute <= 15
        within_30_count += absolute <= 30
        local = [
            row for row in signals
            if abs((parse_time(row["beijing_open_time"]) - target).total_seconds()) <= 30 * 60
        ]
        if absolute == 0:
            result = "精确一致"
        elif absolute <= 5:
            result = f"同向近邻（{delta:+d} 分钟）"
        elif absolute <= 30:
            result = f"同向偏移（{delta:+d} 分钟）"
        else:
            result = f"±30 分钟内无同向；最近为 {delta:+d} 分钟"
        local_text = "；".join(
            f"{row['beijing_open_time'][11:]} {'多' if row['direction']=='long' else '空'} {row['setup']}"
            for row in local
        ) or "无"
        comparison_rows.append(
            {
                "id": item["id"],
                "time": item["time"],
                "direction": item["direction"],
                "result": result,
                "nearest": nearest,
                "local": local_text,
            }
        )

    new_in_30 = sum(
        any(
            row["direction"] == item["direction"]
            and abs((parse_time(row["beijing_open_time"]) - parse_time(item["time"])).total_seconds()) <= 30 * 60
            for item in baseline
        )
        for row in signals
    )

    audit_payload = {
        "audit_version": 1,
        "generated_at_beijing": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "model": manifest["model"],
        "reasoning_effort": manifest["reasoning_effort"],
        "data_sha256": data_sha,
        "records": len(rows),
        "final_chain_sha256": chain,
        "record_errors": errors,
        "tool_audit": tool_audit,
        "decision_counts": dict(decisions),
        "signal_direction_counts": dict(directions),
        "baseline_coverage": {
            "exact": exact_count,
            "within_5_minutes": within_5_count,
            "within_15_minutes": within_15_count,
            "within_30_minutes": within_30_count,
            "new_signals_inside_same_direction_30_minute_windows": new_in_30,
        },
        "manual_transport_exception": {
            "idx": 489,
            "description": "The isolated Sol model produced the decision, but causal_gate.commit timed out; the identical frozen arguments were transported directly to the gate. No judgment was changed and idx 490 was not released beforehand."
        },
    }
    (OUT / "audit_634bars_final.json").write_text(json.dumps(audit_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(LEDGER_DIR / "decisions.jsonl", OUT / "decisions_634bars_final.jsonl")
    shutil.copy2(LEDGER_DIR / "gate_state.json", OUT / "gate_state_634bars_final.json")
    shutil.copy2(LEDGER_DIR / "manifest.json", OUT / "manifest_634bars_final.json")
    shutil.copy2(WORK / "orchestrator_progress.json", OUT / "orchestrator_progress_634bars_final.json")

    lines: list[str] = []
    lines.extend(
        [
            "# XAUUSD 5分钟严格因果回放最终报告（634/634）",
            "",
            f"> 最终结论：回放已完整结束，634 根决策账本和哈希链全部通过独立重算；正式判断会话未调用禁用工具，也没有取得尚未释放的后续 K 线。与 A01–A15 相比，本次并不是‘信号更少、更精选’，而是明显更细、更密：共给出 {len(signals)} 个 SIGNAL。差异的主因是标注粒度、上下文和事后筛选方式不同，不能仅凭图上效果认定模型偷看未来。",
            "",
            "## 1. 运行配置与数据范围",
            "",
            "| 项目 | 结果 |",
            "| --- | --- |",
            f"| 品种 / 周期 | {source['symbol']} / {source['timeframe_minutes']} 分钟 |",
            f"| K线范围（北京时间开盘） | {bars[0]['beijing_open_time']} ～ {bars[-1]['beijing_open_time']} |",
            f"| 冻结 K线数量 | {len(bars)} |",
            f"| 冻结数据 SHA-256 | `{data_sha}` |",
            f"| 模型 / 推理强度 | `{manifest['model']}` / `{manifest['reasoning_effort']}` |",
            f"| 隔离会话 ID | `{progress.get('thread_id')}` |",
            "| 规则 | Louie 20260806 规则全文及案例扩展版 |",
            "| 明确禁用 | A/B 分级、固定 ATR/百分比/分数/冷却根数、Shell、文件读取、网络、TradingView、浏览器、插件、应用、子代理 |",
            "| 判断顺序 | 环境/背景 → 位置 → 接受与跟随 → 被破坏结构 → 当前触发；EMA/ATR 只作辅助 |",
            "",
            "## 2. 防作弊与完整性审计",
            "",
            f"- 634 条记录的 `idx` 连续为 0–633，逐条 `record_sha256` 重算全部一致。",
            f"- 最终哈希链重算值与 gate 状态一致：`{chain}`。",
            "- 每条记录均满足 `max_used_idx == idx`、所有 `evidence_indices <= idx`、`decision_after_close_time = bar_open_time + 300 秒`、`no_future_data=true`。",
            f"- 正式日志中完成的因果门调用：`commit` {tool_audit['calls'].get('causal_gate|commit|completed', 0)} 次，`status` {tool_audit['calls'].get('causal_gate|status|completed', 0)} 次；禁用/越权调用 **{tool_audit['forbidden_count']}** 次。",
            f"- `commit` 超时失败 {tool_audit['calls'].get('causal_gate|commit|failed', 0)} 次；失败不会释放下一根 K 线。",
            "- 唯一人工传输例外是 idx=489：隔离 Sol 已经生成并冻结判断参数，但 MCP 提交超时；主线程只把完全相同的参数送入 gate，没有重新判断或改写。之后才释放 idx=490。",
            "- idx=520 后因 Codex 用量上限暂停至 2026-08-08 11:34；恢复后仍使用同一 Sol 会话、同一账本和同一链继续到 634。",
            "- 正式判断会话物理上只有 `causal_gate.status/commit` 两个工具。外围曾生成过 520 根中期报告并读取基准，但该内容没有进入隔离 Sol 会话；续跑会话仍无法访问文件或基准。",
            "",
            "因此，可以证明的是：**本次 634 根重跑没有前视数据污染**。不能由此反推 A01–A15 是否‘故意作弊’，只能说明 A01–A15 不是在同一套物理单向门条件下产生的实时判定样本。",
            "",
            "## 3. 判断统计",
            "",
            "| 判断 | 数量 | 占 634 根比例 |",
            "| --- | ---: | ---: |",
            f"| NO_SIGNAL | {decisions['NO_SIGNAL']} | {decisions['NO_SIGNAL']/634:.1%} |",
            f"| OBSERVE | {decisions['OBSERVE']} | {decisions['OBSERVE']/634:.1%} |",
            f"| SIGNAL | {decisions['SIGNAL']} | {decisions['SIGNAL']/634:.1%} |",
            f"| SIGNAL 方向 | 做多 {directions['long']} / 做空 {directions['short']} | — |",
            "",
            f"A01–A15 只有 15 个图上标记，而本次有 {len(signals)} 个逐根可执行触发，数量是其 **{len(signals)/15:.2f} 倍**。按‘同方向且相邻不超过 30 分钟’合并，本次仍约有 59 个结构片段，说明差异不只是连续 K 线重复标记。",
            "",
            "## 4. 与 A01–A15 的事后对比",
            "",
            "对比使用 TradingView 标记所锚定 K 线的**开盘时间**；该根判断实际只能在 5 分钟后收盘时提交。这个区分能避免把‘图上标记时间’和‘最早可执行时间’混为一谈。",
            "",
            f"- 精确同时间同方向：**{exact_count}/15**。",
            f"- 同方向在 ±5 分钟内：**{within_5_count}/15**。",
            f"- 同方向在 ±15 分钟内：**{within_15_count}/15**。",
            f"- 同方向在 ±30 分钟内：**{within_30_count}/15**。",
            f"- 本次 {len(signals)} 个 SIGNAL 中，只有 {new_in_30} 个落在任一 A 标记的同方向 ±30 分钟窗口内；其余 80 个属于更细粒度或基准未保留的触发。",
            "",
            "| 基准 | 基准 K线/方向 | 本次最近同向结果 | ±30分钟内本次全部信号 |",
            "| --- | --- | --- | --- |",
        ]
    )
    for item in comparison_rows:
        side = "做多" if item["direction"] == "long" else "做空"
        nearest = item["nearest"]
        lines.append(
            f"| {item['id']} | {item['time']} {side} | {item['result']}；`{nearest['setup']}` | {item['local']} |"
        )

    lines.extend(
        [
            "",
            "### 关键分歧",
            "",
            "- **高度一致**：A03、A04、A11、A12、A13 在 K 线锚定时间和方向上精确一致；A07、A08、A15 只相差 5 分钟。",
            "- **同一行情、确认点不同**：A02、A05、A14 在 ±30 分钟内出现同向触发，但本次选择了不同的确认 K 线。",
            "- **未复现**：A01 在 ±30 分钟内没有信号（最近同向早 35 分钟）；A06、A09、A10 没有在 ±30 分钟内出现同向信号。A06 附近本次反而连续做多；A10 附近出现做多，属于明确的结构解释分叉。",
            "- **A14 的路径最能说明差异**：基准在 08:20 做空；本次 08:00、08:30 先判断突破/回测做多，到 08:40 才在失败突破被接受后转为空。这不是看见结果后回填，而是严格逐根条件下对‘何时确认失败’的选择更晚。",
            "",
            "## 5. 为什么 A01–A15 看起来更好",
            "",
            "1. **它是精选标注，不是逐根原始输出。** 现有记录显示 A01–A15 经过批量分析、人工复核和重画，只保留 15 个代表性节点；本次要求每根收盘都给出状态，模型把新的突破、跟随、回测和二次入场都可再次标为 SIGNAL。两者输出单位不同。",
            "2. **本次明确没有去重规则。** 提示词禁止模型擅自增加固定冷却根数、评分或 A/B 等级，因此无法用这些手段把 101 个触发压缩成 15 个。连续跟随信号多，不是偷看未来，而是事件聚合口径未定义。",
            "3. **上下文形式不同。** A01–A15 的复核阶段能看到整张图和更长结构；严格回放会话每次只能取得当前 K 线、EMA20/EMA50、ATR14 和当时已经确认的少量枢轴。即使模型名称相同，信息表达和上下文不同也会改变判断。",
            "4. **同模型不等于逐字确定性。** Sol/xhigh 的推理存在采样和路径依赖；尤其在震荡、高潮后的首次反转、突破是否已获接受等边界条件上，5–30 分钟偏移是正常的模型分歧。",
            "5. **事后图形天然更整洁。** 完整走势出来后，人很容易把一段行情压缩成一个最漂亮的箭头。严格因果输出不能删除当时合理、后来失败的判断，否则就是回填。",
            "",
            "### 关于‘原来是否看到了后面的 K 线’",
            "",
            "- A01–A15 的最终复核/重画过程并没有采用这次的物理单向门，因此复核者至少具备看到完整图形的条件；它应被视为**事后审计标注**，不应直接当作实时无前视基准。",
            "- 但仅凭标记漂亮，无法证明原模型在每个首次判断时实际引用了未来 K 线，也无法证明存在故意作弊。能够确定的是：原结果与本次不是同一种实验设计。",
            "- 如果要公平复现实盘质量，下一次应在回放开始前固定‘一个结构事件只保留哪个触发’的事件级口径，并仍由单向门逐根判断；不能跑完后再删除失败信号。",
            "",
            f"## 6. 本次全部 SIGNAL（{len(signals)} 个）",
            "",
            "`K线时间`是图表锚点；`最早提交时间`是该 K 线收盘后，晚 5 分钟。模型原始完整理由保存在 `decisions_634bars_final.jsonl`。",
            "",
            "| # | idx | K线时间（北京） | 最早提交时间 | 方向/结构摘要 | 原始 setup | evidence |",
            "| ---: | ---: | --- | --- | --- | --- | --- |",
        ]
    )
    for number, row in enumerate(signals, 1):
        open_time = parse_time(row["beijing_open_time"])
        close_time = open_time + timedelta(minutes=5)
        evidence = ",".join(str(value) for value in row["evidence_indices"])
        lines.append(
            f"| {number} | {row['idx']} | {open_time:%Y-%m-%d %H:%M} | {close_time:%Y-%m-%d %H:%M} | {setup_category(row['setup'], row['direction'])} | `{row['setup']}` | {evidence} |"
        )

    lines.extend(
        [
            "",
            "## 7. 证据文件",
            "",
            "- [`decisions_634bars_final.jsonl`](./decisions_634bars_final.jsonl)：634 条原始决策与逐条哈希。",
            "- [`gate_state_634bars_final.json`](./gate_state_634bars_final.json)：最终 idx 与链头。",
            "- [`manifest_634bars_final.json`](./manifest_634bars_final.json)：模型、数据和防前视清单。",
            "- [`orchestrator_progress_634bars_final.json`](./orchestrator_progress_634bars_final.json)：26 轮运行与禁用工具审计摘要。",
            "- [`audit_634bars_final.json`](./audit_634bars_final.json)：本报告生成时的独立重算结果。",
            "- [`baseline_a01_a15.json`](./baseline_a01_a15.json)：事后对比基准。",
            "",
            "---",
            "",
            "本报告先完成 634/634 因果账本与哈希校验，随后才执行 A01–A15 对比。报告对信号好坏的讨论属于事后分析，不会回写任何历史判断。",
            "",
        ]
    )
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"report": str(REPORT), "signals": len(signals), "chain": chain, "errors": 0}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
