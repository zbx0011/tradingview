from __future__ import annotations

import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_direct_guard import (
    ALLOWED_SETUPS,
    BAR_SECONDS,
    build_snapshot,
    claim_execution,
    cycle_begin,
    cycle_end,
    cycle_wait,
    ensure_direct_schema,
    expire_pending_executions,
    executor_begin,
    executor_end,
    mark_execution,
    next_bars,
    record_review,
    wait_live_slot,
)
from kline_store import connect, ingest


class DirectAiGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "market.db"
        self.conn = connect(self.db)
        ensure_direct_schema(self.conn)
        self.vendor = "OANDA"
        self.symbol = "XAUUSD"
        self.start = 1_780_000_000
        bars = []
        for index in range(12):
            open_time = self.start + index * BAR_SECONDS
            close = 4000.0 + index
            bars.append(
                {
                    "time": open_time,
                    "open": close - 0.5,
                    "high": close + 1.0,
                    "low": close - 1.0,
                    "close": close,
                    "volume": 100 + index,
                    "is_final": True,
                }
            )
        ingest(self.conn, self.vendor, self.symbol, "5", bars, True)
        self.now = self.start + 12 * BAR_SECONDS + 10

    def tearDown(self) -> None:
        self.conn.close()
        self.temp.cleanup()

    def strict_audit(self, target: int) -> dict:
        return {
            "passed": True,
            "data_cutoff": target,
            "max_included_bar_time": target,
            "signal_bar_time": target,
            "earliest_decision_time": target + BAR_SECONDS,
            "future_reference_count": 0,
            "referenced_bar_times": [target - BAR_SECONDS, target],
            "audit_summary": "All cited bars are at or before the frozen cutoff.",
        }

    def signal_decision(self, target: int, close: float, direction: str = "long") -> dict:
        if direction == "long":
            confirmation, invalidation = close + 1.0, close - 1.0
        else:
            confirmation, invalidation = close - 1.0, close + 1.0
        return {
            "verdict": "SIGNAL",
            "direction": direction,
            "setup_type": next(iter(ALLOWED_SETUPS)),
            "grade": "none",
            "outer_state": "causal outer state",
            "inner_state": "causal inner state",
            "reasons": ["Evidence exists by the target close."],
            "location_summary": "known location",
            "structure_summary": "known structure",
            "confirmation_price": confirmation,
            "invalidation_price": invalidation,
            "context": {
                "levels_reason": "execution levels only",
                "second_time_audit": self.strict_audit(target),
            },
        }

    def record_payload(self, target: int, snapshot: dict, decision: dict) -> dict:
        return {
            "vendor": self.vendor,
            "symbol": self.symbol,
            "timeframe": "5",
            "bar_time": target,
            "snapshot_sha256": snapshot["snapshot_sha256"],
            "model": "test",
            "reasoning_effort": "max",
            "decision": decision,
        }

    def test_bootstrap_reviews_latest_closed_bar_only(self) -> None:
        result = next_bars(self.conn, self.vendor, self.symbol, "5", 3, self.now)
        self.assertTrue(result["bootstrap_latest_only"])
        self.assertEqual(result["pending_count"], 1)
        self.assertEqual(result["pending_bars"][0][0], self.start + 11 * BAR_SECONDS)

    def test_snapshot_never_contains_future_bar(self) -> None:
        target = self.start + 7 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        self.assertTrue(snapshot["no_future_bars"])
        self.assertEqual(snapshot["data_cutoff"], target)
        self.assertEqual(snapshot["max_included_bar_time"], target)
        self.assertTrue(all(row[0] <= target for row in snapshot["recent_bars"]))

    def test_record_then_next_returns_only_still_live_unreviewed_bar(self) -> None:
        target = self.start + 8 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = {
            "verdict": "NO_SIGNAL",
            "direction": "none",
            "setup_type": "none",
            "grade": "none",
            "outer_state": "range",
            "inner_state": "middle",
            "reasons": ["No opportunity at this close."],
            "confirmation_price": None,
            "invalidation_price": None,
            "context": {},
        }
        recorded = record_review(self.conn, self.record_payload(target, snapshot, decision))
        self.assertTrue(recorded["inserted"])
        result = next_bars(self.conn, self.vendor, self.symbol, "5", 2, self.now)
        self.assertTrue(result["live_only"])
        self.assertEqual(result["pending_count"], 1)
        self.assertEqual(result["pending_bars"][0][0], self.start + 11 * BAR_SECONDS)
        self.assertEqual(result["expired_unreviewed_count"], 2)

    def test_signal_level_direction_is_only_execution_safety_gate(self) -> None:
        target = self.start + 10 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        close = snapshot["target_bar"][4]
        decision = self.signal_decision(target, close, "short")
        decision["invalidation_price"] = close - 2.0
        with self.assertRaisesRegex(ValueError, "invalid short"):
            record_review(self.conn, self.record_payload(target, snapshot, decision))

    def test_execution_status_is_durable(self) -> None:
        target = self.start + 9 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        review_now = target + BAR_SECONDS + 10
        recorded = record_review(
            self.conn,
            self.record_payload(target, snapshot, decision),
            now=review_now,
        )
        self.assertTrue(recorded["should_execute"])
        updated = mark_execution(
            self.conn,
            {
                "vendor": self.vendor,
                "symbol": self.symbol,
                "timeframe": "5",
                "bar_time": target,
                "status": "succeeded",
                "detail": {"signal_id": 123},
            },
        )
        self.assertEqual(updated["status"], "succeeded")

    def test_execution_queue_claims_and_finishes_one_signal_at_a_time(self) -> None:
        first_target = self.start + 8 * BAR_SECONDS
        second_target = self.start + 9 * BAR_SECONDS
        for target in (first_target, second_target):
            snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
            decision = self.signal_decision(target, snapshot["target_bar"][4])
            self.assertTrue(
                record_review(
                    self.conn,
                    self.record_payload(target, snapshot, decision),
                    now=first_target + BAR_SECONDS + 10,
                )["inserted"]
            )

        execution_now = first_target + BAR_SECONDS + 10
        first = claim_execution(self.conn, "executor-a", 300, now=execution_now)
        self.assertTrue(first["claimed"])
        self.assertEqual(first["key"]["bar_time"], first_target)
        self.assertEqual(first["execution_payload"]["candidate"]["bar_time"], first_target)
        self.assertEqual(first["execution_payload"]["decision"]["verdict"], "SIGNAL")

        mark_execution(
            self.conn,
            {
                **first["key"],
                "owner": "executor-a",
                "status": "succeeded",
                "detail": {"signal_id": 1},
            },
        )
        second = claim_execution(self.conn, "executor-a", 300, now=execution_now + 1)
        self.assertTrue(second["claimed"])
        self.assertEqual(second["key"]["bar_time"], second_target)

    def test_execution_claim_requires_matching_owner_to_finish(self) -> None:
        target = self.start + 9 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        execution_now = target + BAR_SECONDS + 10
        record_review(
            self.conn,
            self.record_payload(target, snapshot, decision),
            now=execution_now,
        )
        claimed = claim_execution(self.conn, "executor-a", 300, now=execution_now)
        with self.assertRaisesRegex(ValueError, "not found"):
            mark_execution(
                self.conn,
                {
                    **claimed["key"],
                    "owner": "executor-b",
                    "status": "failed",
                    "detail": {},
                },
            )

    def test_stale_execution_claim_is_recovered(self) -> None:
        target = self.start + 9 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        execution_now = target + BAR_SECONDS + 10
        record_review(
            self.conn,
            self.record_payload(target, snapshot, decision),
            now=execution_now,
        )
        self.assertTrue(
            claim_execution(self.conn, "executor-a", 60, now=execution_now)["claimed"]
        )
        reclaimed = claim_execution(self.conn, "executor-b", 60, now=execution_now + 61)
        self.assertTrue(reclaimed["claimed"])
        self.assertEqual(reclaimed["owner"], "executor-b")

    def test_late_signal_is_preserved_but_never_queued_for_live_execution(self) -> None:
        target = self.start + 8 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        recorded = record_review(
            self.conn,
            self.record_payload(target, snapshot, decision),
            now=target + 2 * BAR_SECONDS,
        )
        self.assertTrue(recorded["inserted"])
        self.assertFalse(recorded["should_execute"])
        self.assertEqual(recorded["execution_status"], "expired")
        row = self.conn.execute(
            """
            SELECT verdict,execution_status,execution_detail_json
            FROM ai_direct_reviews
            WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time=?
            """,
            (self.vendor, self.symbol, target),
        ).fetchone()
        self.assertEqual(row["verdict"], "SIGNAL")
        self.assertEqual(row["execution_status"], "expired")
        self.assertIn("live_signal_deadline_exceeded", row["execution_detail_json"])

    def test_pending_signal_expires_before_executor_can_claim_it(self) -> None:
        target = self.start + 9 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        recorded = record_review(
            self.conn,
            self.record_payload(target, snapshot, decision),
            now=target + BAR_SECONDS + 10,
        )
        self.assertTrue(recorded["should_execute"])
        expired = expire_pending_executions(
            self.conn,
            now=target + 2 * BAR_SECONDS - 60,
        )
        self.assertEqual(expired["expired_count"], 1)
        claimed = claim_execution(
            self.conn,
            "executor-a",
            300,
            now=target + 2 * BAR_SECONDS - 60,
        )
        self.assertFalse(claimed["claimed"])

    def test_executor_lease_is_singleton(self) -> None:
        self.assertTrue(executor_begin(self.conn, "executor-a", 100, now=1000)["acquired"])
        self.assertFalse(executor_begin(self.conn, "executor-b", 100, now=1050)["acquired"])
        self.assertEqual(executor_end(self.conn, "executor-b"), {"released": False})
        self.assertEqual(executor_end(self.conn, "executor-a"), {"released": True})

    def test_three_market_workers_can_record_in_parallel(self) -> None:
        markets = [
            ("BYBIT", "BTCUSDT.P", 65000.0),
            ("OANDA", "XAGUSD", 58.0),
            ("OANDA", "XAUUSD", 4000.0),
        ]
        for vendor, symbol, base in markets[:2]:
            bars = []
            for index in range(12):
                open_time = self.start + index * BAR_SECONDS
                close = base + index * 0.1
                bars.append(
                    {
                        "time": open_time,
                        "open": close - 0.05,
                        "high": close + 0.1,
                        "low": close - 0.1,
                        "close": close,
                        "volume": 100 + index,
                        "is_final": True,
                    }
                )
            ingest(self.conn, vendor, symbol, "5", bars, True)

        target = self.start + 10 * BAR_SECONDS

        def worker(vendor: str, symbol: str) -> bool:
            conn = connect(self.db)
            try:
                ensure_direct_schema(conn)
                snapshot = build_snapshot(conn, vendor, symbol, "5", target, now=self.now)
                decision = {
                    "verdict": "NO_SIGNAL",
                    "direction": "none",
                    "setup_type": "none",
                    "grade": "none",
                    "outer_state": f"{symbol} outer",
                    "inner_state": f"{symbol} inner",
                    "reasons": ["No signal at the frozen close."],
                    "confirmation_price": None,
                    "invalidation_price": None,
                    "context": {},
                }
                result = record_review(
                    conn,
                    {
                        "vendor": vendor,
                        "symbol": symbol,
                        "timeframe": "5",
                        "bar_time": target,
                        "snapshot_sha256": snapshot["snapshot_sha256"],
                        "model": "parallel-test",
                        "reasoning_effort": "max",
                        "decision": decision,
                    },
                )
                return bool(result["inserted"])
            finally:
                conn.close()

        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda market: worker(market[0], market[1]), markets))
        self.assertEqual(results, [True, True, True])

    def test_signal_rejects_legacy_ab_grade(self) -> None:
        target = self.start + 10 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        decision["grade"] = "A"
        with self.assertRaisesRegex(ValueError, "do not use A/B"):
            record_review(self.conn, self.record_payload(target, snapshot, decision))

    def test_signal_rejects_missing_second_audit(self) -> None:
        target = self.start + 10 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        decision["context"].pop("second_time_audit")
        with self.assertRaisesRegex(ValueError, "requires second_time_audit"):
            record_review(self.conn, self.record_payload(target, snapshot, decision))

    def test_signal_rejects_future_reference_audit(self) -> None:
        target = self.start + 10 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = self.signal_decision(target, snapshot["target_bar"][4])
        decision["context"]["second_time_audit"]["future_reference_count"] = 1
        with self.assertRaisesRegex(ValueError, "future references"):
            record_review(self.conn, self.record_payload(target, snapshot, decision))

    def test_duplicate_review_is_idempotent(self) -> None:
        target = self.start + 6 * BAR_SECONDS
        snapshot = build_snapshot(self.conn, self.vendor, self.symbol, "5", target, now=self.now)
        decision = {
            "verdict": "NO_SIGNAL",
            "direction": "none",
            "setup_type": "none",
            "grade": "none",
            "outer_state": "outer",
            "inner_state": "inner",
            "reasons": ["initial review"],
        }
        payload = self.record_payload(target, snapshot, decision)
        self.assertTrue(record_review(self.conn, payload)["inserted"])
        self.assertEqual(
            record_review(self.conn, payload),
            {"inserted": False, "duplicate": True, "should_execute": False},
        )

    def test_missing_review_rejects_snapshot_hash_mismatch(self) -> None:
        target = self.start + 6 * BAR_SECONDS
        with self.assertRaisesRegex(ValueError, "snapshot hash mismatch"):
            record_review(
                self.conn,
                {
                    "vendor": self.vendor,
                    "symbol": self.symbol,
                    "timeframe": "5",
                    "bar_time": target,
                    "snapshot_sha256": "stale-hash",
                    "decision": {},
                },
            )

    def test_cycle_lease_lifecycle(self) -> None:
        first = cycle_begin(self.conn, "owner-a", 100, now=1000)
        self.assertTrue(first["acquired"])
        self.assertFalse(cycle_begin(self.conn, "owner-b", 100, now=1050)["acquired"])
        self.assertEqual(cycle_end(self.conn, "owner-b"), {"released": False})
        self.assertEqual(cycle_end(self.conn, "owner-a"), {"released": True})
        self.assertTrue(cycle_begin(self.conn, "owner-b", 100, now=1050)["acquired"])

    def test_cycle_end_records_completion_log(self) -> None:
        self.assertTrue(cycle_begin(self.conn, "owner-a", 60, now=1000)["acquired"])
        self.assertEqual(cycle_end(self.conn, "owner-a"), {"released": True})
        row = self.conn.execute(
            "SELECT COUNT(*) AS count FROM ai_direct_cycle_log"
        ).fetchone()
        self.assertEqual(row["count"], 1)

    def test_wait_live_slot_collects_now_when_enough_reserve(self) -> None:
        aligned = 1_780_000_200  # aligned to the 300-second candle boundary
        now = aligned + 8 * BAR_SECONDS + 30
        result = wait_live_slot(reserve_seconds=150, safety_seconds=6, now=now)
        self.assertEqual(result["action"], "collect_now")
        self.assertEqual(result["latest_open"], aligned + 7 * BAR_SECONDS)
        self.assertEqual(result["deadline"], aligned + 9 * BAR_SECONDS)

    def test_wait_live_slot_waits_for_next_close_when_deadline_is_near(self) -> None:
        aligned = 1_780_000_200  # aligned to the 300-second candle boundary
        now = aligned + 9 * BAR_SECONDS - 30
        result = wait_live_slot(reserve_seconds=150, safety_seconds=6, now=now)
        self.assertEqual(result["action"], "wait_for_next_close")
        self.assertEqual(result["sleep_until"], aligned + 9 * BAR_SECONDS + 6)

    def test_cycle_wait_acquires_after_previous_lease_releases(self) -> None:
        self.assertTrue(cycle_begin(self.conn, "owner-a", 1, now=1000)["acquired"])
        acquired = cycle_wait(
            self.conn,
            "owner-b",
            lease_seconds=60,
            timeout_seconds=5,
            poll_seconds=1,
            now=1000,
        )
        self.assertTrue(acquired["acquired"])
        self.assertEqual(acquired["owner"], "owner-b")
        self.assertEqual(cycle_end(self.conn, "owner-b"), {"released": True})

    def test_rejects_unapproved_market(self) -> None:
        with self.assertRaisesRegex(ValueError, "not enabled"):
            next_bars(self.conn, "ICMARKETS", "US500", "5", 1, self.now)


if __name__ == "__main__":
    unittest.main()
