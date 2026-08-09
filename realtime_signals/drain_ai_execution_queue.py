# louie规则监控（20260806版本）
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from ai_direct_guard import (
    BAR_SECONDS,
    LIVE_SIGNAL_DEADLINE_BARS,
    claim_execution,
    ensure_direct_schema,
    executor_begin,
    executor_end,
    mark_execution,
)
from kline_store import DEFAULT_DB, connect


ROOT = Path(__file__).resolve().parents[1]
EXECUTOR = ROOT / "realtime_signals" / "execute_signal.mjs"


def _encode(value: dict[str, Any]) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def _last_json(stdout: str) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        text = line.strip()
        if text:
            return json.loads(text)
    raise ValueError("signal executor returned no JSON result")


def _run_executor(payload: dict[str, Any], deadline_epoch: int, timeout_seconds: int) -> dict[str, Any]:
    command = [
        "node",
        str(EXECUTOR),
        "--payload-base64",
        _encode(payload),
    ]
    if deadline_epoch:
        command.extend(["--deadline-epoch", str(deadline_epoch)])
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    completed = subprocess.run(
        command,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
        creationflags=creationflags,
        check=False,
    )
    result = _last_json(completed.stdout)
    result["returncode"] = completed.returncode
    if completed.stderr.strip():
        result["stderr"] = completed.stderr.strip()[-4000:]
    return result


def drain(
    db: Path,
    owner: str,
    max_items: int,
    claim_lease_seconds: int,
    executor_lease_seconds: int,
    timeout_seconds: int,
    deadline_epoch: int = 0,
) -> dict[str, Any]:
    conn = connect(db)
    ensure_direct_schema(conn)
    lease = executor_begin(conn, owner, executor_lease_seconds)
    if not lease["acquired"]:
        conn.close()
        return {"success": True, "skipped": "executor_busy", "lease": lease, "items": []}

    items: list[dict[str, Any]] = []
    expired: list[dict[str, Any]] = []
    try:
        for _ in range(max_items):
            if deadline_epoch and int(time.time()) + 15 >= deadline_epoch:
                break
            claimed = claim_execution(conn, owner, claim_lease_seconds)
            expired.extend(claimed.get("expired", []))
            if not claimed["claimed"]:
                break
            key = claimed["key"]
            try:
                signal_deadline = int(key["bar_time"]) + LIVE_SIGNAL_DEADLINE_BARS * BAR_SECONDS
                effective_deadline = signal_deadline
                if deadline_epoch:
                    effective_deadline = min(effective_deadline, deadline_epoch)
                result = _run_executor(
                    claimed["execution_payload"],
                    effective_deadline,
                    timeout_seconds,
                )
                if result.get("duplicate") is True:
                    status = "duplicate"
                elif result.get("success") is True and int(result.get("returncode", 1)) == 0:
                    status = "succeeded"
                else:
                    status = "failed"
                mark_execution(
                    conn,
                    {
                        **key,
                        "owner": owner,
                        "status": status,
                        "detail": result,
                    },
                )
                items.append({"key": key, "status": status, "detail": result})
            except Exception as exc:
                detail = {"error": str(exc), "exception_type": type(exc).__name__}
                mark_execution(
                    conn,
                    {
                        **key,
                        "owner": owner,
                        "status": "failed",
                        "detail": detail,
                    },
                )
                items.append({"key": key, "status": "failed", "detail": detail})
        failures = [item for item in items if item["status"] == "failed"]
        return {
            "success": not failures,
            "processed": len(items),
            "failed": len(failures),
            "expired": len(expired),
            "expired_items": expired,
            "items": items,
        }
    finally:
        executor_end(conn, owner)
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Drain direct-AI signal executions serially")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--owner", default=f"executor-{uuid.uuid4()}")
    parser.add_argument("--max-items", type=int, default=12)
    parser.add_argument("--claim-lease-seconds", type=int, default=300)
    parser.add_argument("--executor-lease-seconds", type=int, default=900)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--deadline-epoch", type=int, default=0)
    args = parser.parse_args()
    result = drain(
        args.db,
        args.owner,
        max(1, min(args.max_items, 36)),
        max(30, args.claim_lease_seconds),
        max(60, args.executor_lease_seconds),
        max(30, args.timeout_seconds),
        args.deadline_epoch,
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
