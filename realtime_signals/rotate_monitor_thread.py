#!/usr/bin/env python3
# louie规则监控（20260806版本）
"""Repoint the 5-k monitor automation to a fresh monitor page (thread).

Run this after creating a new chat page (for example "DeepSeek 监控 08-06").
All monitor state (K-lines, reviews, signals, ranges) lives in the database and
files, so rotating the page loses nothing and keeps the context window small.

Usage:
  python realtime_signals/rotate_monitor_thread.py --new-thread-id <THREAD_ID>
  python realtime_signals/rotate_monitor_thread.py --list-current
  python realtime_signals/rotate_monitor_thread.py --new-thread-id <ID> --dry-run
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import time
import tomllib
from datetime import datetime
from pathlib import Path


AUTOMATION_TOML = Path.home() / ".codex" / "automations" / "5-k" / "automation.toml"
CODEX_DB = Path.home() / ".codex" / "sqlite" / "codex-dev.db"


def next_boundary_ms() -> int:
    now_s = int(time.time())
    return ((now_s // 300) + 1) * 300 * 1000


def read_toml() -> dict:
    with AUTOMATION_TOML.open("rb") as f:
        return tomllib.load(f)


def write_toml(data: dict) -> None:
    # Keep the original key order and formatting style of the file.
    lines = []
    for key, value in data.items():
        if isinstance(value, str):
            lines.append(f'{key} = "{value}"')
        elif isinstance(value, int):
            lines.append(f"{key} = {value}")
        else:
            lines.append(f"{key} = {json.dumps(value, ensure_ascii=False)}")
    AUTOMATION_TOML.write_text("\n".join(lines) + "\n", encoding="utf-8")


def update_db(new_thread_id: str | None) -> None:
    con = sqlite3.connect(CODEX_DB, timeout=15)
    now_ms = int(time.time() * 1000)
    if new_thread_id is None:
        con.execute(
            "UPDATE automations SET next_run_at=?, updated_at=? WHERE id='5-k'",
            (next_boundary_ms(), now_ms),
        )
    else:
        con.execute(
            "UPDATE automations SET next_run_at=?, updated_at=? WHERE id='5-k'",
            (next_boundary_ms(), now_ms),
        )
    con.commit()
    row = con.execute(
        "SELECT id,status,model,reasoning_effort,next_run_at FROM automations WHERE id='5-k'"
    ).fetchone()
    con.close()
    print(
        json.dumps(
            {
                "db": {
                    "id": row[0],
                    "status": row[1],
                    "model": row[2],
                    "reasoning_effort": row[3],
                    "next_run_at": row[4],
                }
            },
            ensure_ascii=False,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new-thread-id", default=None)
    parser.add_argument("--list-current", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not AUTOMATION_TOML.exists():
        raise SystemExit(f"automation toml not found: {AUTOMATION_TOML}")
    data = read_toml()
    current = data.get("target_thread_id")
    if args.list_current:
        print(json.dumps({"current_thread_id": current}, ensure_ascii=False))
        return 0
    if not args.new_thread_id:
        raise SystemExit("--new-thread-id is required (or use --list-current)")
    new_id = str(args.new_thread_id).strip()
    if not new_id:
        raise SystemExit("empty thread id")
    if new_id == current:
        print(json.dumps({"unchanged": True, "thread_id": current}, ensure_ascii=False))
        return 0
    if not args.dry_run:
        backup = AUTOMATION_TOML.with_name(
            AUTOMATION_TOML.name + f".bak-{datetime.now():%Y%m%d-%H%M%S}"
        )
        shutil.copy2(AUTOMATION_TOML, backup)
        data["target_thread_id"] = new_id
        write_toml(data)
        update_db(new_id)
    print(
        json.dumps(
            {
                "dry_run": args.dry_run,
                "old_thread_id": current,
                "new_thread_id": new_id,
                "status": data.get("status"),
                "model": data.get("model"),
                "reasoning_effort": data.get("reasoning_effort"),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
