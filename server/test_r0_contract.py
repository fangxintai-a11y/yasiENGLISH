"""The same synthetic R0 fixtures must work in TypeScript and the real SQLite store."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

try:
    from .app import Database
    from .learning import LearningError, LearningStore, content_hash, validate_payload
except ImportError:
    from app import Database
    from learning import LearningError, LearningStore, content_hash, validate_payload

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "src/study365/fixtures/r0-records.json").read_text())


class R0ContractTest(unittest.TestCase):
    def test_shared_payloads_and_hashes_match_the_python_contract(self):
        self.assertEqual(FIXTURE["purpose"], "synthetic-wire-examples-not-user-learning-records")
        for item in FIXTURE["records"]:
            request = item["request"]
            with self.subTest(kind=request["kind"]):
                validate_payload(request["kind"], request["payload"], item["recordId"])
                self.assertEqual(content_hash(request["kind"], request["payload"]), item["expectedContentHash"])

    def test_all_seven_records_round_trip_through_disposable_sqlite(self):
        with tempfile.TemporaryDirectory(prefix="band-r0-contract-") as directory:
            database = Database(Path(directory) / "fixtures.sqlite3")
            with database.connect() as db:
                db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r0-test-user", "r0-contract-user", "unused-test-hash", 1))
            store = LearningStore(database)
            for item in FIXTURE["records"]:
                status, result = store.put("r0-test-user", item["recordId"], item["request"])
                self.assertEqual(status, 200, result)
                self.assertEqual(result["record"]["contentHash"], item["expectedContentHash"])
                self.assertEqual(result["record"]["payload"], item["request"]["payload"])
                self.assertEqual(store.put("r0-test-user", item["recordId"], item["request"]), (status, result))
            reopened = LearningStore(Database(database.path))
            with reopened.database.connect() as db:
                rows = db.execute("SELECT kind FROM learning_records WHERE user_id=?", ("r0-test-user",)).fetchall()
                self.assertEqual(len(rows), 7)
                self.assertEqual(db.execute("SELECT count(*) FROM learning_revisions").fetchone()[0], 7)
                self.assertEqual(db.execute("SELECT count(*) FROM snapshots").fetchone()[0], 0)

    def test_future_fields_remain_rejected_without_silent_data_loss(self):
        future = {"plan": ("sectionTargets", {}), "attempt": ("questionResults", []), "essay": ("taskType", "task2"),
                  "speaking": ("sessionId", "future-session"), "feedback": ("reviewer", {}), "assessment": ("evidenceRefs", [])}
        for item in FIXTURE["records"]:
            request = item["request"]
            if request["kind"] not in future:
                continue
            field, value = future[request["kind"]]
            payload = copy.deepcopy(request["payload"])
            payload[field] = value
            with self.subTest(kind=request["kind"]), self.assertRaises(LearningError):
                validate_payload(request["kind"], payload, item["recordId"])


if __name__ == "__main__":
    unittest.main()
