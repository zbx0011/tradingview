"""Strict causal AI review for replay_15m_candidates.py output.

Markets run in parallel, while candidates inside each market are reviewed in
chronological order so prior accepted replay signals can be supplied without
future leakage. Candidates that no valid setup family could possibly pass are
rejected locally by the same hard gates used after the production AI review.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = Path(__file__).resolve().parent
PROMPT_PATH = SCRIPT_DIR / "review_decision_prompt.txt"
SCHEMA_PATH = SCRIPT_DIR / "review_decision_schema.json"
RENDERER_PATH = SCRIPT_DIR / "render_candidate_chart.py"
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
BEIJING = timezone(timedelta(hours=8))
TIMEOUT_SECONDS = 300

RANGE_SETUPS = {
    "震荡内部：边缘反向",
    "震荡突破：位移突破",
}
WIDE_SETUPS = {
    "宽通道边缘：反向波段",
    "宽通道突破：更大级别反转",
    "宽通道顺势：在有利边缘跟随主方向",
}
NARROW_SETUP = "窄通道：等待回踩顺势参与"


def bj_text(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, BEIJING).strftime("%Y-%m-%d %H:%M")


def candidate_key(candidate: dict[str, Any]) -> str:
    plain = (
        f"{candidate['vendor']}:{candidate['symbol']}:{candidate['timeframe']}:"
        f"{candidate['bar_time']}:{candidate['reason']}"
    )
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()[:20]


def family_gate_available(candidate: dict[str, Any]) -> bool:
    families = set(candidate.get("reason_families") or [])
    reversal_directions = set(
        candidate.get("range_reversal_validation", {}).get(
            "valid_directions"
        )
        or []
    )
    edge_hypothesis_directions = {
        str(item.get("direction"))
        for item in (candidate.get("hypotheses") or [])
        if item.get("code") and reason_family_for_review(str(item["code"])) == "edge_reversal"
    }
    range_available = bool(
        candidate["range_validation"].get("valid")
        and (
            "breakout" in families
            or reversal_directions.intersection(edge_hypothesis_directions)
        )
    )
    return bool(
        range_available
        or candidate["wide_channel_validation"].get("valid")
        or candidate.get("narrow_pullback_validation", {}).get(
            "valid_directions"
        )
    )


def reason_family_for_review(code: str) -> str:
    if "pullback" in code:
        return "trend_pullback"
    if "breakout" in code or "displacement" in code or "micro_range" in code:
        return "breakout"
    return "edge_reversal"


def no_signal(reason: str, raw: dict[str, Any] | None = None) -> dict[str, Any]:
    result = {
        "verdict": "NO_SIGNAL",
        "direction": "none",
        "setup_type": "none",
        "grade": "none",
        "reasons": [reason],
        "location_summary": "硬门未通过",
        "structure_summary": "当时数据不足以成立A/B机会",
        "confirmation_price": 0,
        "invalidation_price": 0,
        "context": {
            "market_state": "未通过正式类型硬门",
            "levels_reason": reason,
            "range_or_channel_anchors": [],
            "previous_signal_id": 0,
            "previous_signal_status": "none",
            "state_transition": "none",
            "transition_evidence": "none",
        },
    }
    if raw is not None:
        result["raw_decision"] = raw
    return result


def hard_gate_rejection(
    candidate: dict[str, Any],
    decision: dict[str, Any],
) -> str:
    if decision.get("verdict") != "SIGNAL":
        return ""
    setup = decision.get("setup_type")
    direction = decision.get("direction")
    if setup in RANGE_SETUPS and not candidate["range_validation"].get("valid"):
        return "range hard gate rejected the AI setup"
    if setup == "震荡内部：边缘反向":
        valid_directions = (
            candidate.get("range_reversal_validation", {}).get(
                "valid_directions"
            )
            or []
        )
        if direction not in valid_directions:
            return "range-reversal outer-third gate rejected the AI direction"
    if setup in WIDE_SETUPS and not candidate["wide_channel_validation"].get("valid"):
        return "wide-channel hard gate rejected the AI setup"
    if setup == NARROW_SETUP:
        expected = "up" if direction == "long" else "down"
        valid = candidate["narrow_channel_validation"].get("valid_directions") or []
        if expected not in valid:
            return "narrow-channel hard gate rejected the AI direction"
        pullback_valid = (
            candidate.get("narrow_pullback_validation", {}).get(
                "valid_directions"
            )
            or []
        )
        if direction not in pullback_valid:
            return "narrow-channel pullback-quality gate rejected the AI setup"
    close = float(candidate["close"])
    confirmation = float(decision.get("confirmation_price", 0))
    invalidation = float(decision.get("invalidation_price", 0))
    if direction == "long" and not (
        confirmation >= close and invalidation < close
    ):
        return "long confirmation/invalidation levels violate replay constraints"
    if direction == "short" and not (
        confirmation <= close and invalidation > close
    ):
        return "short confirmation/invalidation levels violate replay constraints"
    return ""


def token_usage(text: str) -> int:
    match = re.search(r"tokens used\s+([\d,]+)", text, re.IGNORECASE)
    return int(match.group(1).replace(",", "")) if match else 0


def render_candidate(
    candidate: dict[str, Any],
    image_path: Path,
    ranges_json: Path | None = None,
) -> dict[str, Any]:
    command = [
        str(VENV_PYTHON),
        str(RENDERER_PATH),
        "--vendor",
        str(candidate["vendor"]),
        "--symbol",
        str(candidate["symbol"]),
        "--timeframe",
        str(candidate["timeframe"]),
        "--bar-time",
        str(candidate["bar_time"]),
        "--output",
        str(image_path),
        "--ignore-stored-ranges",
    ]
    if ranges_json is not None:
        command.extend(["--ranges-json", str(ranges_json)])
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=60,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"renderer exit={completed.returncode}: {completed.stdout[-2000:]}")
    return json.loads(completed.stdout.strip().splitlines()[-1])


def run_model(
    codex: str,
    candidate: dict[str, Any],
    render_result: dict[str, Any],
    image_path: Path,
    result_path: Path,
    log_path: Path,
    range_aware: bool = False,
) -> tuple[dict[str, Any], str, str, int, float]:
    model = "gpt-5.6-sol" if candidate.get("needs_sol") else "gpt-5.6-terra"
    effort = "high" if candidate.get("needs_sol") else "medium"
    payload = copy.deepcopy(candidate)
    payload["visual_context"] = {
        "type": "strict_causal_replay_composite",
        "attached_image": True,
        "outer_bars": render_result["outer"]["bars"],
        "inner_bars": render_result["inner"]["bars"],
        "through_bar_time": render_result["bar_time"],
        "no_future_bars": render_result["no_future_bars"],
        "stored_ranges_ignored": render_result["stored_ranges_ignored"],
        "sha256": render_result["sha256"],
    }
    template = PROMPT_PATH.read_text(encoding="utf-8")
    override = """

STRICT HISTORICAL REPLAY OVERRIDE:
- This replay intentionally excludes every current/manual TradingView drawing,
  rectangle, trend line, signal, visual baseline, and chart_ranges row.
- The attached image contains raw candles plus EMA20/EMA50 only and ends at the
  candidate close. No orange rectangle is authoritative in this replay.
- Use only the automatic causal validations in Candidate JSON and the raw image.
- Never infer a state using knowledge of any later bar.
"""
    if range_aware:
        override = """

STRICT RANGE-AWARE HISTORICAL REPLAY OVERRIDE:
- The attached chart still ends exactly at the candidate close; no future bar
  is present.
- Orange rectangles are strict-causal reconstructed balance areas. A rectangle
  is shown only after its first_detected_at was already known at this cutoff.
- Treat Candidate JSON chart_ranges and the visible orange rectangles as the
  authoritative range context for this pass.
- The rectangle may be nested inside a larger balance area; distinguish outer
  state from the local inner state before choosing a setup.
- Never infer a state using knowledge of any later bar.
"""
    prompt = template.replace(
        "{{CANDIDATE_JSON}}",
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    ) + override
    started = time.monotonic()
    completed = subprocess.run(
        [
            codex,
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "read-only",
            "-C",
            str(ROOT),
            "-m",
            model,
            "-c",
            f"model_reasoning_effort={effort}",
            "-i",
            str(image_path),
            "--output-schema",
            str(SCHEMA_PATH),
            "-o",
            str(result_path),
            "-",
        ],
        cwd=ROOT,
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=TIMEOUT_SECONDS,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    duration = time.monotonic() - started
    log_path.write_text(completed.stdout or "", encoding="utf-8")
    if completed.returncode != 0 or not result_path.exists():
        raise RuntimeError(
            f"AI exit={completed.returncode}: {(completed.stdout or '')[-2000:]}"
        )
    return (
        json.loads(result_path.read_text(encoding="utf-8")),
        model,
        effort,
        token_usage(completed.stdout or ""),
        duration,
    )


def prior_signal_record(
    replay_id: int,
    candidate: dict[str, Any],
    decision: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": replay_id,
        "bar_time": int(candidate["bar_time"]),
        "signal_price": float(candidate["close"]),
        "direction": decision["direction"],
        "setup_type": decision["setup_type"],
        "grade": decision["grade"],
        "reasons": decision["reasons"],
        "confirmation_price": decision["confirmation_price"],
        "invalidation_price": decision["invalidation_price"],
        "created_at": int(candidate["bar_time"]) + 15 * 60,
        "replay_only": True,
    }


def review_market(
    codex: str,
    output_dir: Path,
    market: tuple[str, str],
    candidates: list[dict[str, Any]],
    ranges_json: Path | None = None,
) -> dict[str, Any]:
    vendor, symbol = market
    market_dir = output_dir / f"{vendor}-{symbol.replace('.', '_')}"
    market_dir.mkdir(parents=True, exist_ok=True)
    prior_signals: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    failures = 0
    ai_calls = 0
    local_rejects = 0

    for index, original in enumerate(sorted(candidates, key=lambda item: item["bar_time"])):
        candidate = copy.deepcopy(original)
        candidate["recent_signals"] = prior_signals[-3:]
        key = candidate_key(candidate)
        record_path = market_dir / f"{candidate['bar_time']}-{key}.json"
        if record_path.exists():
            record = json.loads(record_path.read_text(encoding="utf-8"))
            results.append(record)
            if record.get("final_decision", {}).get("verdict") == "SIGNAL":
                prior_signals.append(
                    prior_signal_record(
                        len(prior_signals) + 1,
                        candidate,
                        record["final_decision"],
                    )
                )
            continue

        record: dict[str, Any] = {
            "key": key,
            "vendor": vendor,
            "symbol": symbol,
            "timeframe": candidate["timeframe"],
            "bar_time": candidate["bar_time"],
            "beijing": bj_text(int(candidate["bar_time"])),
            "candidate_score": candidate["candidate_score"],
            "candidate_lifecycle": candidate["candidate_lifecycle"],
            "reason_codes": candidate["reason_codes"],
            "strict_causal": True,
            "future_bar_count": 0,
        }
        if not family_gate_available(candidate):
            local_rejects += 1
            record["review_mode"] = "equivalent_pre_ai_hard_reject"
            record["final_decision"] = no_signal(
                "range、wide-channel及方向匹配的narrow-channel硬门均为false"
            )
        else:
            image_path = market_dir / f"{candidate['bar_time']}-{key}.png"
            raw_path = market_dir / f"{candidate['bar_time']}-{key}.raw.json"
            log_path = market_dir / f"{candidate['bar_time']}-{key}.log"
            try:
                render_result = render_candidate(candidate, image_path, ranges_json)
                if (
                    not render_result.get("no_future_bars")
                    or int(render_result.get("bar_time", 0))
                    != int(candidate["bar_time"])
                    or (
                        ranges_json is None
                        and render_result.get("chart_ranges")
                    )
                    or (
                        ranges_json is not None
                        and not render_result.get("chart_ranges")
                    )
                ):
                    raise RuntimeError("strict causal render assertion failed")
                raw, model, effort, tokens, duration = run_model(
                    codex,
                    candidate,
                    render_result,
                    image_path,
                    raw_path,
                    log_path,
                    ranges_json is not None,
                )
                ai_calls += 1
                rejection = hard_gate_rejection(candidate, raw)
                final = (
                    no_signal(rejection, raw)
                    if rejection
                    else raw
                )
                record.update(
                    {
                        "review_mode": "ai",
                        "model": model,
                        "effort": effort,
                        "tokens_used": tokens,
                        "duration_seconds": round(duration, 3),
                        "render": render_result,
                        "post_ai_hard_rejection": rejection,
                        "raw_decision": raw,
                        "final_decision": final,
                    }
                )
            except Exception as exc:  # keep the replay resumable
                failures += 1
                record["review_mode"] = "failed"
                record["error"] = str(exc)
                record["final_decision"] = no_signal(
                    f"AI复核失败，未计为信号：{exc}"
                )
        if record["final_decision"].get("verdict") == "SIGNAL":
            prior_signals.append(
                prior_signal_record(
                    len(prior_signals) + 1,
                    candidate,
                    record["final_decision"],
                )
            )
        record_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        results.append(record)
        print(
            f"REPLAY {vendor}:{symbol} {record['beijing']} "
            f"{record['review_mode']} {record['final_decision']['verdict']} "
            f"{index + 1}/{len(candidates)}",
            flush=True,
        )

    summary = {
        "vendor": vendor,
        "symbol": symbol,
        "candidates": len(candidates),
        "ai_calls": ai_calls,
        "equivalent_pre_ai_hard_rejects": local_rejects,
        "failures": failures,
        "signals": sum(
            item["final_decision"].get("verdict") == "SIGNAL"
            for item in results
        ),
        "results": results,
    }
    (market_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument(
        "--ranges-json",
        type=Path,
        help="Enable strict-causal range-aware re-review with this range file.",
    )
    args = parser.parse_args()
    codex = os.environ.get("CODEX_CLI") or shutil.which("codex")
    if not codex:
        raise RuntimeError("codex CLI not found")
    if not VENV_PYTHON.exists():
        raise RuntimeError(f"renderer Python missing: {VENV_PYTHON}")
    payload = json.loads(args.queue.read_text(encoding="utf-8"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for candidate in payload["candidates"]:
        grouped.setdefault(
            (candidate["vendor"], candidate["symbol"]),
            [],
        ).append(candidate)
    summaries: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(args.workers, len(grouped))
    ) as executor:
        futures = {
            executor.submit(
                review_market,
                codex,
                args.output_dir,
                market,
                candidates,
                args.ranges_json,
            ): market
            for market, candidates in grouped.items()
        }
        for future in concurrent.futures.as_completed(futures):
            summaries.append(future.result())
    output = {
        "version": 1,
        "mode": "strict_causal_program_plus_ai",
        "window_beijing": payload["window_beijing"],
        "chart_drawings_used": args.ranges_json is not None,
        "production_chart_ranges_used": False,
        "strict_causal_replay_ranges_used": args.ranges_json is not None,
        "production_signals_used": False,
        "markets": summaries,
        "total_candidates": sum(item["candidates"] for item in summaries),
        "total_ai_calls": sum(item["ai_calls"] for item in summaries),
        "total_pre_ai_hard_rejects": sum(
            item["equivalent_pre_ai_hard_rejects"] for item in summaries
        ),
        "total_failures": sum(item["failures"] for item in summaries),
        "total_signals": sum(item["signals"] for item in summaries),
    }
    (args.output_dir / "review_results.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        "REPLAY_COMPLETE "
        + json.dumps(
            {key: value for key, value in output.items() if key != "markets"},
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
