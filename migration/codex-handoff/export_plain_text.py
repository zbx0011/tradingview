#!/usr/bin/env python3
"""Convert the structured chat export JSONL into a readable plain-text transcript.

Image base64 payloads are removed; local attachment paths are preserved.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path


IMG_RE = re.compile(r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+")


def fmt_ts(value: str) -> str:
    if not value:
        return "未知时间"
    try:
        return (
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            .astimezone()
            .strftime("%Y-%m-%d %H:%M:%S %z")
        )
    except ValueError:
        return value


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: export_plain_text.py <chat.jsonl> <output.txt>")
        return 2
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])

    rows: list[dict] = []
    with src.open("r", encoding="utf-8") as handle:
        for line in handle:
            rows.append(json.loads(line))

    users = sum(1 for row in rows if row["role"] == "user")
    assistants = len(rows) - users
    lines = [
        "TradingView 悬浮行情项目 · Codex 完整历史对话（纯文本版）",
        "=" * 72,
        "导出时间：" + datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z"),
        "覆盖范围：2026-07-23 至 2026-08-05"
        "（任务 tradingview MCP，Thread 019f8d7b-c4e7-7313-9115-f7c8b5ea8da2）",
        f"消息总数：{len(rows)}（用户 {users} 条，Codex {assistants} 条，含过程更新与最终回复）",
        "说明：图片 base64 数据已省略；本地图片/附件路径保留；"
        "系统指令、工具调用与内部推理不在聊天正文内。",
        "=" * 72,
        "",
    ]

    phase_labels = {
        "commentary": "（过程更新）",
        "final_answer": "（最终回复）",
    }
    for i, row in enumerate(rows, 1):
        label = "用户" if row["role"] == "user" else "Codex"
        phase = ""
        if row["role"] == "assistant" and row.get("phase"):
            phase = phase_labels.get(row["phase"], f"（{row['phase']}）")
        lines.append(f"【{i:04d}】{label}{phase} · {fmt_ts(row['timestamp'])}")
        lines.append("-" * 72)
        text = IMG_RE.sub("[图片数据已省略]", row["text"])
        lines.append(text.rstrip())
        lines.append("")
        lines.append("")

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))

    print(
        json.dumps(
            {
                "output": str(out.resolve()),
                "messages": len(rows),
                "users": users,
                "assistants": assistants,
                "bytes": os.path.getsize(out),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
