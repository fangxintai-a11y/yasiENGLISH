"""R2 optional writing fields: shared wire fixtures and disposable SQLite."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid

try:
    from .app import Database
    from .learning import LearningError, LearningStore, PROTOCOL_VERSION, WRITING_CHECKLIST_IDS, WRITING_ERROR_CAUSES, ERROR_CAUSES, content_hash, encoded, validate_payload, validate_writing_feedback_reference
except ImportError:
    from app import Database
    from learning import LearningError, LearningStore, PROTOCOL_VERSION, WRITING_CHECKLIST_IDS, WRITING_ERROR_CAUSES, ERROR_CAUSES, content_hash, encoded, validate_payload, validate_writing_feedback_reference

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "src/study365/fixtures/r2-records.json").read_text())
def record(record_id):
    return next(item for item in FIXTURE["records"] if item["recordId"] == record_id)
def work_for(payload):
    return next(item["request"]["payload"] for item in FIXTURE["records"] if item["request"]["revisionId"] == payload["workRevisionId"])
def invalid_payload(case):
    value = copy.deepcopy(record(case["recordId"])["request"]["payload"])
    target = value
    for key in case["path"][:-1]:
        target = target[key]
    if case.get("remove"):
        del target[case["path"][-1]]
    else:
        target[case["path"][-1]] = case["value"]
    return value

class R2ContractTest(unittest.TestCase):
    def test_protocol_two_and_fixed_writing_subset(self):
        self.assertEqual(PROTOCOL_VERSION, 2)
        self.assertEqual(FIXTURE["fixtureVersion"], 2)
        self.assertEqual(len(WRITING_CHECKLIST_IDS["task1"]), 15)
        self.assertEqual(len(WRITING_CHECKLIST_IDS["task2"]), 12)
        self.assertNotIn("task1-no-opinion", WRITING_CHECKLIST_IDS["task2"])
        self.assertTrue(WRITING_ERROR_CAUSES <= ERROR_CAUSES)

    def test_all_writes_reopen_and_replay_exactly_without_migrating_old_payloads(self):
        with tempfile.TemporaryDirectory(prefix="band-r2-contract-") as directory:
            database = Database(Path(directory) / "learning.sqlite3")
            with database.connect() as db:
                db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r2-test-user", "r2-contract-user", "unused-test-hash", 1))
            store, original_responses = LearningStore(database), {}
            for item in FIXTURE["records"]:
                status, result = store.put("r2-test-user", item["recordId"], item["request"])
                self.assertEqual(status, 200, result)
                self.assertEqual(result["record"]["payload"], item["request"]["payload"])
                self.assertEqual(result["record"]["contentHash"], item["expectedContentHash"])
                original_responses[item["request"]["mutationId"]] = (status, result)
            with database.connect() as db:
                before_rows = [tuple(row) for row in db.execute("SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq")]
                before_receipts = [tuple(row) for row in db.execute("SELECT * FROM learning_mutation_receipts ORDER BY mutation_id")]
                self.assertEqual(db.execute("SELECT count(*) FROM snapshots").fetchone()[0], 0)
            reopened = LearningStore(Database(database.path))
            for item in FIXTURE["records"]:
                self.assertEqual(reopened.put("r2-test-user", item["recordId"], item["request"]), original_responses[item["request"]["mutationId"]])
            actual = reopened.list("r2-test-user")["items"]
            self.assertEqual(len(actual), len(FIXTURE["records"]))
            for value, item in zip(actual, FIXTURE["records"]):
                self.assertEqual(value["payload"], item["request"]["payload"])
            legacy = next(value for value in actual if value["id"] == "r2-essay-legacy")
            self.assertNotIn("scope", legacy["payload"])
            self.assertNotIn("stage", legacy["payload"])
            with database.connect() as db:
                self.assertEqual(before_rows, [tuple(row) for row in db.execute("SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq")])
                self.assertEqual(before_receipts, [tuple(row) for row in db.execute("SELECT * FROM learning_mutation_receipts ORDER BY mutation_id")])
                self.assertEqual([row[0] for row in db.execute("SELECT version FROM learning_schema_migrations ORDER BY version")], [1, 2])

    def test_essay_hash_is_exact_raw_utf8_and_ignores_new_metadata(self):
        payload = work_for(record("r2-feedback-checked")["request"]["payload"])
        expected = hashlib.sha256(payload["text"].encode("utf-8")).hexdigest()
        self.assertEqual(content_hash("essay", {**payload, "scope": "paragraph", "stage": "draft", "elapsedSeconds": 1, "sourceRef": "Another source"}), expected)
        self.assertNotEqual(content_hash("essay", {**payload, "text": payload["text"].strip()}), expected)

    def test_spelling_utf16_offsets_include_a_whole_emoji(self):
        value = copy.deepcopy(record("r2-feedback-checked")["request"]["payload"])
        value["spellingCheck"]["items"] = [{"start": 2, "end": 4, "text": "📝", "confirmed": True}]
        validate_writing_feedback_reference(value, {"taskType": "task2", "text": "A 📝 note."})

    def test_spelling_utf16_offsets_cannot_split_a_surrogate_pair(self):
        value = copy.deepcopy(record("r2-feedback-checked")["request"]["payload"])
        value["spellingCheck"]["items"] = [{"start": 3, "end": 4, "text": "📝", "confirmed": True}]
        with self.assertRaisesRegex(LearningError, "拼写片段"):
            validate_writing_feedback_reference(value, {"taskType": "task2", "text": "A 📝 note."})

    def test_json_integer_valued_numbers_match_the_frontend_number_model(self):
        value = copy.deepcopy(record("r2-feedback-checked")["request"]["payload"])
        value["spellingCheck"]["count"] = 1.0
        value["spellingCheck"]["items"][0]["start"] = float(value["spellingCheck"]["items"][0]["start"])
        validate_payload("feedback", value, "integer-valued-json")
        validate_writing_feedback_reference(value, work_for(value))

for index, item in enumerate(FIXTURE["records"]):
    def check(self, item=item):
        before = encoded(item["request"])
        request = item["request"]
        validate_payload(request["kind"], request["payload"], item["recordId"])
        if request["kind"] == "feedback":
            validate_writing_feedback_reference(request["payload"], work_for(request["payload"]))
        self.assertEqual(content_hash(request["kind"], request["payload"]), item["expectedContentHash"])
        self.assertEqual(encoded(item["request"]), before)
    setattr(R2ContractTest, f"test_shared_wire_{index+1:02d}_{item['recordId'].replace('-', '_')}", check)
for index, case in enumerate(FIXTURE["invalidCases"]):
    def check(self, case=case):
        value, kind = invalid_payload(case), record(case["recordId"])["request"]["kind"]
        if case.get("reference"):
            validate_payload(kind, value, "invalid-reference")
            with self.assertRaisesRegex(LearningError, case["error"]):
                validate_writing_feedback_reference(value, work_for(value))
        else:
            with self.assertRaisesRegex(LearningError, case["error"]):
                validate_payload(kind, value, "invalid-field")
    setattr(R2ContractTest, f"test_invalid_{index+1:02d}_{case['label'].replace(' ', '_').replace('-', '_')}", check)

class R2ReferenceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="band-r2-ref-")
        self.addCleanup(self.directory.cleanup)
        self.database = Database(Path(self.directory.name) / "learning.sqlite3")
        with self.database.connect() as db:
            db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r2-test-user", "r2-contract-user", "unused-test-hash", 1))
        self.store = LearningStore(self.database)
        for item in FIXTURE["records"]:
            self.store.put("r2-test-user", item["recordId"], item["request"])

    def reject_reference(self, payload, message):
        validate_payload("feedback", payload, "r2-invalid-ref")
        body = {"schemaVersion": 2, "kind": "feedback", "revisionId": str(uuid.uuid4()), "mutationId": str(uuid.uuid4()), "baseRevision": None, "payload": payload}
        with self.assertRaisesRegex(LearningError, message):
            self.store.put("r2-test-user", "r2-invalid-ref", body)
        with self.database.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM learning_revisions").fetchone()[0], len(FIXTURE["records"]))

    def test_actual_sqlite_original_rejects_changed_spelling_text(self):
        value = copy.deepcopy(record("r2-feedback-checked")["request"]["payload"])
        value["spellingCheck"]["items"][0]["text"] = "xxxxxxxxxx"
        self.reject_reference(value, "拼写片段")

    def test_actual_sqlite_original_rejects_span_beyond_the_text(self):
        value = copy.deepcopy(record("r2-feedback-checked")["request"]["payload"])
        value["spellingCheck"]["items"][0]["end"] = 10000
        self.reject_reference(value, "拼写片段")

    def test_task2_self_report_does_not_override_the_actual_task1_original(self):
        value = copy.deepcopy(record("r2-feedback-task1")["request"]["payload"])
        value.update(taskType="task2", bands={"taskResponse": None, "coherence": None, "lexical": None, "grammar": None}, errorCauses=[], checklist={"task-response-answer": True})
        self.reject_reference(value, "任务类型与原稿")

if __name__ == "__main__":
    unittest.main()
