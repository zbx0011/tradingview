from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from kline_store import connect, sync_chart_ranges


class RangeSyncSafetyTest(unittest.TestCase):
    def test_missing_manual_and_locked_ranges_are_never_deleted(self) -> None:
        with TemporaryDirectory() as directory:
            conn = connect(Path(directory) / "market.db")
            rows = (
                ("manual", "manual", 1),
                ("locked-auto", "auto", 1),
                ("unlocked-auto", "auto", 0),
            )
            for entity_id, source, locked in rows:
                conn.execute(
                    """
                    INSERT INTO chart_ranges (
                        vendor,symbol,timeframe,entity_id,start_time,end_time,
                        upper,lower,source,locked,status,color,created_at,updated_at
                    ) VALUES ('BYBIT','BTCUSDT.P','5',?,100,200,20,10,?,?,
                              'active','#f59e0b',1,1)
                    """,
                    (entity_id, source, locked),
                )
            conn.commit()

            result = sync_chart_ranges(
                conn,
                {
                    "vendor": "BYBIT",
                    "symbol": "BTCUSDT.P",
                    "timeframe": "5",
                    "ranges": [],
                },
            )
            statuses = {
                row["entity_id"]: row["status"]
                for row in conn.execute(
                    "SELECT entity_id,status FROM chart_ranges ORDER BY entity_id"
                )
            }
            conn.close()

        self.assertEqual(statuses["manual"], "active")
        self.assertEqual(statuses["locked-auto"], "active")
        self.assertEqual(statuses["unlocked-auto"], "deleted")
        self.assertEqual(result["retained_manual_missing"], 2)
        self.assertEqual(result["marked_deleted"], 1)


if __name__ == "__main__":
    unittest.main()
