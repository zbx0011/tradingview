#!/usr/bin/env python3
"""Watchdog for the causal replay runner.

Runs run_xau_causal_replay_v2.py --resume repeatedly until the ledger is
complete. On repeated same-thread stalls it retries with a fresh thread.
The environment variables CAUSAL_WORK / CAUSAL_HOME / CAUSAL_DATA must be set
the same way as the runner.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


WORK = Path(os.environ.get(
    "CAUSAL_WORK",
    str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-v2-work-20260807"),
))
PROGRESS = WORK / "orchestrator_progress.json"
LOG = WORK / "watchdog.log"
MAX_RETRIES = int(os.environ.get("CAUSAL_WATCHDOG_RETRIES", "40"))
RETRY_SLEEP = int(os.environ.get("CAUSAL_WATCHDOG_SLEEP", "45"))
BLOCKED_SLEEP = int(os.environ.get("CAUSAL_WATCHDOG_BLOCKED_SLEEP", "600"))
NEW_THREAD_AFTER = int(os.environ.get("CAUSAL_WATCHDOG_NEW_THREAD_AFTER", "2"))
RUNNER = Path(__file__).resolve().parent / "run_xau_causal_replay_v2.py"


def log(message: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {message}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def progress_status() -> dict | None:
    try:
        return json.loads(PROGRESS.read_text(encoding="utf-8"))
    except Exception:
        return None


def main() -> int:
    env = os.environ.copy()
    same_thread_stalls = 0
    for attempt in range(1, MAX_RETRIES + 1):
        state = progress_status()
        if state and state.get("status") == "complete":
            log("ledger already complete")
            return 0
        if state and state.get("status") == "blocked_usage":
            log(f"usage blocked (retry_at={state.get('retry_at')}), waiting {BLOCKED_SLEEP}s")
            time.sleep(BLOCKED_SLEEP)
            continue

        new_thread = os.environ.get("CAUSAL_NEW_THREAD") == "1" or same_thread_stalls >= NEW_THREAD_AFTER
        env["CAUSAL_NEW_THREAD"] = "1" if new_thread else "0"
        log(f"attempt {attempt}/{MAX_RETRIES}: runner --resume (new_thread={new_thread})")
        result = subprocess.run(
            [sys.executable, str(RUNNER), "--resume"],
            env=env,
            cwd=str(RUNNER.parent),
        )
        state = progress_status()
        if state and state.get("status") == "complete":
            log("COMPLETE: all bars committed")
            return 0
        error = str((state or {}).get("error") or f"runner exit {result.returncode}")
        log(f"attempt {attempt} stopped: {error}")
        if "two turns without progress" in error:
            same_thread_stalls += 1
        else:
            same_thread_stalls = 0
        if attempt < MAX_RETRIES:
            log(f"sleeping {RETRY_SLEEP}s before next attempt")
            time.sleep(RETRY_SLEEP)
    log(f"gave up after {MAX_RETRIES} attempts; ledger at next_idx={progress_status() and progress_status().get('next_idx')}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
