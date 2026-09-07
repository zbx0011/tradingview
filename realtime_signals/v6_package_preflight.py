"""Validate the portable V6 package and, optionally, one frozen replay file.

This check is deliberately model-free.  It verifies the packaged V6 rule
identity, then verifies the data metadata and SHA-256 when a data file is
provided.  It does not create a ledger, call Codex, or modify any replay
output.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
EXPECTED_KEY = "louie_structural_trailing_v6_nextbar_opposite"
EXPECTED_ID = "louie_al_brooks_full_corpus_ema20_structural_trailing_v6_nextbar_opposite_20260830"
EXPECTED_SHA256 = "60619931bebe8c8b1c1f1f2554a2632201cb0e44ea60b350849256c362fd02b4"
IDENTITY = ROOT / "migration" / "codex-handoff" / "source-rules" / "v6-source-identity.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_runner_manifest() -> dict[str, Any]:
    # The runner's import is side-effect free.  Override the executable so a
    # preflight never needs to locate or invoke a Codex binary.
    os.environ.setdefault("CAUSAL_CODEX_EXECUTABLE", sys.executable)
    os.environ["CAUSAL_RULE_SET"] = EXPECTED_KEY
    path = Path(__file__).with_name("run_xau_causal_luna_image_replay.py")
    spec = importlib.util.spec_from_file_location("v6_package_runner", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import packaged runner: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return dict(module.RULE_SET_MANIFEST)


def verify_package() -> dict[str, Any]:
    if not IDENTITY.is_file():
        raise ValueError(f"missing packaged source identity: {IDENTITY}")
    identity = load_json(IDENTITY)
    if identity.get("canonical_combined_sha256") != EXPECTED_SHA256:
        raise ValueError("packaged source identity has the wrong canonical hash")

    manifest = load_runner_manifest()
    if manifest.get("rule_set_key") != EXPECTED_KEY:
        raise ValueError("runner selected the wrong V6 rule-set key")
    if manifest.get("rule_set_id") != EXPECTED_ID:
        raise ValueError("runner selected the wrong V6 rule-set id")
    if manifest.get("combined_sha256") != EXPECTED_SHA256:
        raise ValueError("runner produced the wrong V6 combined rule hash")

    checked_files: list[dict[str, Any]] = []
    for record in [
        *manifest.get("prompt_files", []),
        *manifest.get("source_files", []),
        manifest.get("runbook", {}),
    ]:
        relative = Path(str(record["path"]))
        path = ROOT / relative
        if not path.is_file():
            raise ValueError(f"missing packaged rule file: {path}")
        actual = sha256_file(path)
        if actual != record.get("sha256"):
            raise ValueError(f"rule file hash mismatch: {path}")
        checked_files.append({"path": relative.as_posix(), "sha256": actual})

    return {
        "rule_set_key": EXPECTED_KEY,
        "rule_set_id": EXPECTED_ID,
        "rule_set_sha256": EXPECTED_SHA256,
        "raw_course_files_packaged": bool(identity.get("raw_sources_packaged")),
        "checked_rule_files": checked_files,
    }


def verify_data(path: Path, start_idx: int, bar_count: int, expected_sha256: str | None) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"data file not found: {path}")
    payload = load_json(path)
    bars = payload.get("bars")
    if not isinstance(bars, list):
        raise ValueError("data file does not contain a bars array")
    timeframe = int(payload.get("timeframe_minutes", payload.get("timeframe")))
    if not str(payload.get("symbol") or "").strip() or timeframe <= 0:
        raise ValueError("data file metadata is incomplete")
    if start_idx < 0 or bar_count <= 0 or start_idx + bar_count > len(bars):
        raise ValueError(
            f"replay interval [{start_idx}, {start_idx + bar_count}) exceeds {len(bars)} bars"
        )
    digest = sha256_file(path)
    if expected_sha256 and digest.lower() != expected_sha256.lower():
        raise ValueError(f"data SHA-256 mismatch: expected {expected_sha256}, got {digest}")
    return {
        "path": str(path.resolve()),
        "symbol": str(payload["symbol"]),
        "timeframe_minutes": timeframe,
        "bar_count": len(bars),
        "start_idx": start_idx,
        "end_idx_exclusive": start_idx + bar_count,
        "data_sha256": digest,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-file", type=Path)
    parser.add_argument("--start-idx", type=int, default=300)
    parser.add_argument("--bar-count", type=int)
    parser.add_argument("--expected-data-sha256")
    args = parser.parse_args()
    result: dict[str, Any] = {"valid": False, "package": verify_package()}
    if args.data_file is not None:
        if args.bar_count is None:
            raise ValueError("--bar-count is required with --data-file")
        result["data"] = verify_data(
            args.data_file,
            args.start_idx,
            args.bar_count,
            args.expected_data_sha256,
        )
    result["valid"] = True
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"valid": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
