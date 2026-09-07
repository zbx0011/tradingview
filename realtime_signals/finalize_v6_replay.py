"""Build and validate the derived V6 replay artifacts after a complete run."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SCRIPT_ROOT = Path(__file__).resolve().parent
V6_KEY = "louie_structural_trailing_v6_nextbar_opposite"
V6_ID = "louie_al_brooks_full_corpus_ema20_structural_trailing_v6_nextbar_opposite_20260830"
V6_SHA = "60619931bebe8c8b1c1f1f2554a2632201cb0e44ea60b350849256c362fd02b4"
EXPECTED_MODEL = "gpt-5.6-luna"
EXPECTED_EFFORT = "max"
EXPECTED_SERVICE_TIER = "default"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def run_script(script: Path, arguments: list[str]) -> None:
    command = [sys.executable, str(script), *arguments]
    completed = subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if completed.returncode != 0:
        detail = (completed.stderr.strip() or completed.stdout.strip() or f"returncode={completed.returncode}")
        raise RuntimeError(f"{script.name} failed: {detail[-4000:]}")
    if completed.stdout.strip():
        print(completed.stdout.strip())


def verify_replay(raw_dir: Path, data_file: Path, risk_usd: str) -> dict[str, Any]:
    progress = read_json(raw_dir / "orchestrator_progress.json")
    manifest = read_json(raw_dir / "manifest.json")
    rule_manifest = read_json(raw_dir / "rule_set_manifest.json")
    if progress.get("status") != "complete" or int(progress["next_idx"]) != int(progress["end_idx_exclusive"]):
        raise ValueError("V6 replay is not complete at the declared end index")
    expected = {
        "model": EXPECTED_MODEL,
        "reasoning_effort": EXPECTED_EFFORT,
        "service_tier": EXPECTED_SERVICE_TIER,
        "rule_set_key": V6_KEY,
        "rule_set_id": V6_ID,
        "rule_set_sha256": V6_SHA,
    }
    mismatches = {
        key: {"actual": progress.get(key), "expected": value}
        for key, value in expected.items()
        if str(progress.get(key)) != value
    }
    for key, value in {
        "rule_set_key": V6_KEY,
        "rule_set_id": V6_ID,
        "rule_set_sha256": V6_SHA,
    }.items():
        if str(manifest.get(key)) != value:
            mismatches[f"manifest.{key}"] = {"actual": manifest.get(key), "expected": value}
    if rule_manifest.get("combined_sha256") != V6_SHA:
        mismatches["rule_set_manifest.combined_sha256"] = {
            "actual": rule_manifest.get("combined_sha256"),
            "expected": V6_SHA,
        }
    data_sha = sha256_file(data_file)
    if data_sha != str(progress.get("data_sha256")) or data_sha != str(manifest.get("data_sha256")):
        mismatches["data_sha256"] = {
            "actual": data_sha,
            "progress": progress.get("data_sha256"),
            "manifest": manifest.get("data_sha256"),
        }
    if mismatches:
        raise ValueError("V6 identity/configuration mismatch: " + json.dumps(mismatches, ensure_ascii=False))

    decision_path = raw_dir / "decisions.jsonl"
    decisions = [json.loads(line) for line in decision_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    expected_indices = list(range(int(progress["start_idx"]), int(progress["end_idx_exclusive"])))
    actual_indices = [int(row["idx"]) for row in decisions]
    if actual_indices != expected_indices:
        raise ValueError("decision ledger is not exactly contiguous across the declared V6 interval")

    raw_path = raw_dir / "raw_signals.json"
    plans_path = raw_dir / "signals_with_trade_plans.json"
    backtest_path = raw_dir / "backtest.json"
    raw_doc = read_json(raw_path)
    plans_doc = read_json(plans_path)
    backtest = read_json(backtest_path)
    raw_count = len(raw_doc.get("drawings", []))
    plan_count = len(plans_doc.get("drawings", []))
    if raw_count != plan_count or raw_count != int(raw_doc.get("counts", {}).get("total", -1)):
        raise ValueError("raw signal and trade-plan counts are inconsistent")
    if str(raw_doc.get("rule_set_sha256")) != V6_SHA or str(plans_doc.get("rule_set_sha256")) != V6_SHA:
        raise ValueError("derived signal artifacts do not carry the V6 rule hash")
    if str(backtest.get("source_data_sha256")) != data_sha:
        raise ValueError("backtest source data hash does not match the frozen data")
    scenario = backtest.get("scenarios", {}).get("conservative_stop_first")
    if not isinstance(scenario, dict):
        raise ValueError("backtest is missing conservative_stop_first")
    summary = scenario.get("summary", {})
    fixed = summary.get("fixed_risk_usd", {})
    snapshots_dir = raw_dir / "snapshots"
    png_files = sorted(snapshots_dir.glob("*.png")) if snapshots_dir.is_dir() else []
    snapshot_events = sum(int(turn.get("snapshots", 0)) for turn in progress.get("turns", []))
    if snapshot_events != len(png_files):
        raise ValueError(f"PNG evidence count mismatch: events={snapshot_events}, files={len(png_files)}")

    return {
        "valid": True,
        "raw_dir": str(raw_dir.resolve()),
        "data_sha256": data_sha,
        "status": progress["status"],
        "model": progress["model"],
        "reasoning_effort": progress["reasoning_effort"],
        "service_tier": progress["service_tier"],
        "first_idx": int(progress["start_idx"]),
        "end_idx_exclusive": int(progress["end_idx_exclusive"]),
        "decisions": len(decisions),
        "raw_signals": raw_count,
        "snapshot_events": snapshot_events,
        "png_files": len(png_files),
        "chain_sha256": progress.get("chain_sha256"),
        "rule_set": {
            "rule_set_key": V6_KEY,
            "rule_set_id": V6_ID,
            "rule_set_sha256": V6_SHA,
            "raw_sources_packaged": False,
        },
        "backtest": {
            "scenario": "conservative_stop_first",
            "closed_trades": summary.get("closed_trades"),
            "winning_trades": summary.get("winning_trades"),
            "win_rate_percent": summary.get("win_rate_percent"),
            "net_pnl_usd": fixed.get("net_pnl_usd"),
            "max_drawdown_usd": fixed.get("closed_equity_max_drawdown_usd"),
            "exit_reason_counts": fixed.get("exit_reason_counts"),
            "opposite_signal_mode": backtest.get("opposite_signal_mode"),
        },
        "artifacts": {
            "raw_signals.json": str(raw_path),
            "signals_with_trade_plans.json": str(plans_path),
            "backtest.json": str(backtest_path),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--data-file", type=Path, required=True)
    parser.add_argument("--risk-usd", default="100")
    args = parser.parse_args()
    raw_dir = args.raw_dir.resolve()
    data_file = args.data_file.resolve()
    raw_dir.mkdir(parents=True, exist_ok=True)
    run_script(
        SCRIPT_ROOT / "export_xau_replay_raw_signals.py",
        ["--raw-dir", str(raw_dir), "--output", str(raw_dir / "raw_signals.json")],
    )
    run_script(
        SCRIPT_ROOT / "augment_xau_replay_trade_levels.py",
        [
            "--raw-dir", str(raw_dir),
            "--signals", str(raw_dir / "raw_signals.json"),
            "--output", str(raw_dir / "signals_with_trade_plans.json"),
            "--data-file", str(data_file),
        ],
    )
    run_script(
        SCRIPT_ROOT / "backtest_xau_replay_trade_levels.py",
        [
            "--raw-dir", str(raw_dir),
            "--signals", str(raw_dir / "signals_with_trade_plans.json"),
            "--output", str(raw_dir / "backtest.json"),
            "--data-file", str(data_file),
            "--risk-usd", str(args.risk_usd),
        ],
    )
    validation = verify_replay(raw_dir, data_file, str(args.risk_usd))
    validation_path = raw_dir / "validation.json"
    write_json(validation_path, validation)
    summary = validation["backtest"]
    receipt = {
        "status": "complete",
        "task_id": raw_dir.name,
        "completed_at_epoch": int(__import__("time").time()),
        "symbol": read_json(raw_dir / "manifest.json").get("symbol"),
        "model": EXPECTED_MODEL,
        "reasoning_effort": EXPECTED_EFFORT,
        "service_tier": EXPECTED_SERVICE_TIER,
        "rule_set_key": V6_KEY,
        "rule_set_id": V6_ID,
        "rule_set_sha256": V6_SHA,
        "data_sha256": validation["data_sha256"],
        "start_idx": validation["first_idx"],
        "end_idx_exclusive": validation["end_idx_exclusive"],
        "raw_signals": validation["raw_signals"],
        "closed_trades": summary.get("closed_trades"),
        "net_pnl_usd": summary.get("net_pnl_usd"),
        "validation_valid": True,
        "kline_studio_upload": False,
    }
    write_json(raw_dir / "completion_receipt.json", receipt)
    print(json.dumps({"status": "complete", "validation": str(validation_path), "receipt": str(raw_dir / "completion_receipt.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
