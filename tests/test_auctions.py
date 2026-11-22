import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app

MINUTE = 60_000
BASE = 1_900_000_000_000


class AuctionTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict("os.environ", {
            "RFQ_DB": str(Path(directory) / "test.sqlite3"), "RFQ_DEMO": "0",
        }))
        self.now = BASE
        self.enterContext(patch("backend.main.now_ms", side_effect=lambda: self.now))
        self.client = self.enterContext(TestClient(app))

    def rfq(self, rule="any_bid", start=0, close=20, forced=27):
        at = lambda minute: datetime.fromtimestamp((BASE + minute * MINUTE) / 1000, UTC).isoformat()
        return self.client.post("/api/rfqs", json={
            "id": "RFQ-TEST", "name": "Test lane", "start_at": at(start),
            "close_at": at(close), "forced_close_at": at(forced), "service_date": "2031-01-01",
            "trigger_window": 10, "extension_duration": 5, "trigger_rule": rule,
        })

    def bid(self, carrier, amount):
        return self.client.post("/api/rfqs/RFQ-TEST/bids", json={
            "carrier": carrier, "freight": amount, "origin": "0.01", "destination": "0",
            "transit_days": 2, "valid_until": "2031-01-01",
        })

    def test_trigger_boundary_cap_and_forced_close(self):
        self.assertEqual(self.rfq().status_code, 201)
        self.now = BASE + 10 * MINUTE - 1
        self.assertEqual(self.bid("A", "100").json()["close_at"], BASE + 20 * MINUTE)
        self.now += 1
        first = self.bid("A", "99").json()
        self.assertEqual(first["close_at"], BASE + 25 * MINUTE)
        self.assertEqual(first["lowest_bid"], 9901)
        self.now = BASE + 17 * MINUTE
        capped = self.bid("A", "98").json()
        self.assertEqual(capped["close_at"], BASE + 27 * MINUTE)
        self.assertEqual(capped["activity"][0]["previous_close_at"], BASE + 25 * MINUTE)
        self.assertEqual(capped["activity"][0]["reason"], "Bid received in the trigger window")
        self.now = BASE + 27 * MINUTE
        self.assertEqual(self.bid("B", "95").status_code, 409)
        self.assertEqual(self.client.get("/api/rfqs").json()[0]["status"], "Force Closed")

    def test_rank_change_trigger_and_superseded_bids(self):
        self.assertEqual(self.rfq("rank_change").status_code, 201)
        self.bid("A", "100")
        self.bid("B", "120")
        self.bid("C", "130")
        self.now = BASE + 12 * MINUTE
        same_order = self.bid("C", "125").json()
        self.assertEqual(same_order["close_at"], BASE + 20 * MINUTE)
        reorder = self.bid("C", "115").json()
        self.assertEqual(reorder["close_at"], BASE + 25 * MINUTE)
        self.assertEqual([row["rank"] for row in reorder["bids"]], [1, 2, 3, None, None])

    def test_l1_trigger_and_tie(self):
        self.assertEqual(self.rfq("leader_change").status_code, 201)
        self.bid("A", "100")
        self.now = BASE + 14 * MINUTE
        tie = self.bid("B", "100").json()
        self.assertEqual(tie["bids"][0]["carrier"], "A")
        self.assertEqual(tie["close_at"], BASE + 20 * MINUTE)
        winner = self.bid("B", "99").json()
        self.assertEqual(winner["bids"][0]["carrier"], "B")
        self.assertEqual(winner["close_at"], BASE + 25 * MINUTE)

    def test_invalid_schedule_and_bid_validation(self):
        self.assertEqual(self.rfq(forced=20).status_code, 422)
        self.assertEqual(self.rfq(start=2).status_code, 201)
        self.assertEqual(self.rfq().status_code, 409)
        self.assertEqual(self.client.get("/api/rfqs").json()[0]["status"], "Scheduled")
        self.assertEqual(self.bid("A", "100").status_code, 409)
        self.now = BASE + 2 * MINUTE
        self.assertEqual(self.bid("A", "100.001").status_code, 422)
        self.assertEqual(self.bid("A", "100").status_code, 201)
        self.assertEqual(self.bid(" a ", "100").status_code, 422)
        self.now = BASE + 20 * MINUTE
        self.assertEqual(self.bid("A", "90").status_code, 409)
        self.assertEqual(self.client.get("/api/rfqs").json()[0]["status"], "Closed")

    def test_concurrent_identical_revision_accepted_once(self):
        self.assertEqual(self.rfq().status_code, 201)
        self.bid("A", "100")
        with ThreadPoolExecutor(max_workers=2) as workers:
            responses = list(workers.map(lambda _: self.bid("A", "99"), range(2)))
        self.assertEqual(sorted(response.status_code for response in responses), [201, 422])
        self.assertEqual(self.client.get("/api/rfqs").json()[0]["bid_count"], 2)
