#!/usr/bin/env python3
"""Stream a Codex rollout JSONL into user/assistant-only chat exports."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


AUTO_BLOCKS = (
    "recommended_plugins",
    "environment_context",
    "in-app-browser-context",
)


def strip_auto_blocks(text: str) -> str:
    """Remove ambient blocks injected by the app while preserving the request."""
    cleaned = text
    for tag in AUTO_BLOCKS:
        cleaned = re.sub(
            rf"\s*<{re.escape(tag)}(?:\s[^>]*)?>.*?</{re.escape(tag)}>\s*",
            "\n",
            cleaned,
            flags=re.DOTALL | re.IGNORECASE,
        )
    cleaned = re.sub(
        r"^\s*##\s*My request for Codex:\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned.strip()


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    chunks: list[str] = []
    for part in content:
        if isinstance(part, str):
            chunks.append(part)
            continue
        if not isinstance(part, dict):
            continue
        kind = part.get("type", "")
        if kind in {"input_text", "output_text", "text"}:
            value = part.get("text")
            if isinstance(value, str):
                chunks.append(value)
        elif kind in {"input_image", "image"}:
            ref = part.get("image_url") or part.get("url") or "未保存的图片附件"
            chunks.append(f"[图片附件：{ref}]")
        elif kind in {"input_file", "file"}:
            ref = part.get("file_path") or part.get("filename") or part.get("file_id") or "未保存的文件附件"
            chunks.append(f"[文件附件：{ref}]")
    return "\n".join(chunk for chunk in chunks if chunk).strip()


def iter_messages(source: Path) -> Iterable[dict[str, Any]]:
    seen_ids: set[str] = set()
    seen_fallback: set[tuple[str, str, str]] = set()
    with source.open("r", encoding="utf-8", errors="replace") as handle:
        for line_no, line in enumerate(handle, 1):
            if line_no % 100_000 == 0:
                print(f"processed_lines={line_no}", flush=True)
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "response_item":
                continue
            payload = event.get("payload")
            if not isinstance(payload, dict) or payload.get("type") != "message":
                continue
            role = payload.get("role")
            if role not in {"user", "assistant"}:
                continue
            message_id = str(payload.get("id") or "")
            if message_id and message_id in seen_ids:
                continue
            text = content_text(payload.get("content"))
            if role == "user":
                text = strip_auto_blocks(text)
            if not text:
                continue
            timestamp = str(event.get("timestamp") or "")
            if not message_id:
                fallback = (timestamp, role, text)
                if fallback in seen_fallback:
                    continue
                seen_fallback.add(fallback)
            else:
                seen_ids.add(message_id)
            yield {
                "timestamp": timestamp,
                "role": role,
                "phase": payload.get("phase"),
                "message_id": message_id or None,
                "text": text,
            }


def markdown_time(value: str) -> str:
    if not value:
        return "未知时间"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    except ValueError:
        return value


def export(source: Path, markdown_path: Path, jsonl_path: Path) -> tuple[int, int, int]:
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    total = users = assistants = 0
    with markdown_path.open("w", encoding="utf-8", newline="\n") as markdown, jsonl_path.open(
        "w", encoding="utf-8", newline="\n"
    ) as structured:
        markdown.write(
            "# tradingview MCP 完整聊天记录\n\n"
            "> 导出范围：本任务中全部用户消息和 Codex 助手可见回复。\n"
            "> 已排除：系统/开发者指令、工具调用及输出、内部推理、自动注入的环境和浏览器状态。\n"
            f"> 原始会话：`{source}`\n\n"
        )
        for message in iter_messages(source):
            total += 1
            if message["role"] == "user":
                users += 1
                label = "用户"
            else:
                assistants += 1
                label = "Codex"
            phase = f" · {message['phase']}" if message.get("phase") else ""
            markdown.write(f"## {total}. {label} · {markdown_time(message['timestamp'])}{phase}\n\n")
            markdown.write(message["text"].rstrip() + "\n\n")
            structured.write(json.dumps(message, ensure_ascii=False) + "\n")
    return total, users, assistants


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("markdown", type=Path)
    parser.add_argument("jsonl", type=Path)
    args = parser.parse_args()
    total, users, assistants = export(args.source, args.markdown, args.jsonl)
    print(json.dumps({
        "total": total,
        "user_messages": users,
        "assistant_messages": assistants,
        "markdown": str(args.markdown.resolve()),
        "jsonl": str(args.jsonl.resolve()),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
