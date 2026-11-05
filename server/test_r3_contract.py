"""R3 shared optional speaking wire fields, with real temporary SQLite refs."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid

try:
    from .app import Database
    from .learning import ERROR_CAUSES, SPEAKING_ERROR_CAUSES, SPEAKING_CHECKLIST_IDS, LearningError, LearningStore, PROTOCOL_VERSION, content_hash, encoded, validate_payload, validate_speaking_feedback_reference
except ImportError:
    from app import Database
    from learning import ERROR_CAUSES, SPEAKING_ERROR_CAUSES, SPEAKING_CHECKLIST_IDS, LearningError, LearningStore, PROTOCOL_VERSION, content_hash, encoded, validate_payload, validate_speaking_feedback_reference

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "src/study365/fixtures/r3-records.json").read_text())
def record(record_id):
    return next(item for item in FIXTURE["records"] if item["recordId"] == record_id)
def work_for(payload):
    return next(item for item in FIXTURE["records"] if item["request"]["revisionId"] == payload["workRevisionId"])
def invalid_payload(case):
    value = copy.deepcopy(record(case["recordId"])["request"]["payload"])
    if case.get("referenceTarget"):
        work = record(case["referenceTarget"])
        value.update(workId=work["recordId"], workRevisionId=work["request"]["revisionId"], inputHash=work["expectedContentHash"])
        if case.get("omitBands"):
            value.pop("bands", None)
        return value
    target = value
    for key in case["path"][:-1]:
        target = target[key]
    if case.get("remove"):
        del target[case["path"][-1]]
    else:
        target[case["path"][-1]] = case["value"]
    return value

class R3ContractTest(unittest.TestCase):
    def test_fixed_ids_and_error_subset_keep_protocol_two(self):
        self.assertEqual(PROTOCOL_VERSION, 2)
        self.assertEqual(FIXTURE["fixtureVersion"], 2)
        self.assertEqual(FIXTURE["purpose"], "synthetic-r3-speaking-wire-examples-not-user-learning-records")
        self.assertEqual(len(SPEAKING_CHECKLIST_IDS), 10)
        self.assertTrue(all(item.startswith("speaking-") for item in SPEAKING_CHECKLIST_IDS))
        self.assertEqual(SPEAKING_ERROR_CAUSES, ERROR_CAUSES - {"task-response", "task-achievement", "spelling", "word-limit"})

    def test_all_revisions_reopen_and_replay_with_exact_original_payloads_hashes_and_receipts(self):
        with tempfile.TemporaryDirectory(prefix="band-r3-contract-") as directory:
            database = Database(Path(directory) / "learning.sqlite3")
            with database.connect() as db:
                db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r3-test-user", "r3-contract-user", "unused-test-hash", 1))
            store, responses = LearningStore(database), {}
            for item in FIXTURE["records"]:
                result = store.put("r3-test-user", item["recordId"], item["request"])
                self.assertEqual(result[0], 200, result)
                self.assertEqual(result[1]["record"]["payload"], item["request"]["payload"])
                self.assertEqual(result[1]["record"]["contentHash"], item["expectedContentHash"])
                responses[item["request"]["mutationId"]] = result
            with database.connect() as db:
                rows = [tuple(row) for row in db.execute("SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq")]
                receipts = [tuple(row) for row in db.execute("SELECT * FROM learning_mutation_receipts ORDER BY mutation_id")]
                self.assertEqual(db.execute("SELECT count(*) FROM snapshots").fetchone()[0], 0)
            reopened = LearningStore(Database(database.path))
            for item in FIXTURE["records"]:
                self.assertEqual(reopened.put("r3-test-user", item["recordId"], item["request"]), responses[item["request"]["mutationId"]])
            actual = reopened.list("r3-test-user")["items"]
            self.assertEqual(len(actual), len(FIXTURE["records"]))
            for value, item in zip(actual, FIXTURE["records"]):
                self.assertEqual(value["payload"], item["request"]["payload"])
            legacy = next(value for value in actual if value["id"] == "r3-speaking-legacy")
            self.assertNotIn("part", legacy["payload"])
            self.assertNotIn("recordingStatus", legacy["payload"])
            with database.connect() as db:
                self.assertEqual(rows, [tuple(row) for row in db.execute("SELECT revision_id,payload,content_hash FROM learning_revisions ORDER BY seq")])
                self.assertEqual(receipts, [tuple(row) for row in db.execute("SELECT * FROM learning_mutation_receipts ORDER BY mutation_id")])
                self.assertEqual([row[0] for row in db.execute("SELECT version FROM learning_schema_migrations ORDER BY version")], [1, 2])

    def test_speaking_hash_is_only_exact_transcript_utf8(self):
        value = record("r3-speaking-part1")["request"]["payload"]
        expected = hashlib.sha256(value["transcript"].encode("utf-8")).hexdigest()
        self.assertEqual(content_hash("speaking", {**value, "part": 3, "prepSeconds": 0, "durationSeconds": 0, "recordingStatus": "none", "recordingId": None, "conditions": {"timed": False}}), expected)
        self.assertNotEqual(content_hash("speaking", {**value, "transcript": value["transcript"].strip()}), expected)

    def test_empty_transcript_is_a_valid_response(self):
        item = record("r3-speaking-empty")
        validate_payload("speaking", item["request"]["payload"], item["recordId"])
        self.assertEqual(item["expectedContentHash"], hashlib.sha256(b"").hexdigest())

    def test_legacy_feedback_does_not_gain_a_discriminator(self):
        item = record("r3-feedback-legacy")
        validate_payload("feedback", item["request"]["payload"], item["recordId"])
        self.assertNotIn("taskType", item["request"]["payload"])

    def test_weekly_calibration_keeps_the_existing_four_dimension_route(self):
        value = record("r3-weekly-human")["request"]["payload"]
        validate_payload("assessment", value, "weekly-fixture")
        self.assertNotIn("taskType", value)
        self.assertEqual(set(value["bands"]), {"fluency", "lexical", "grammar", "pronunciation"})

    def test_speaking_discriminator_does_not_expand_essay_types(self):
        with self.assertRaisesRegex(LearningError, "task1"):
            validate_payload("essay", {"planId": "r3-plan", "text": "A synthetic draft.", "taskType": "speaking"}, "invalid-essay")

    def test_speaking_discriminator_does_not_expand_assessment_types(self):
        with self.assertRaisesRegex(LearningError, "任务类型"):
            validate_payload("assessment", {**record("r3-weekly-human")["request"]["payload"], "taskType": "speaking"}, "invalid-assessment")

    def test_integer_valued_json_numbers_match_the_frontend_number_model(self):
        value = {**record("r3-speaking-part2")["request"]["payload"], "part": 2.0, "prepSeconds": 60.0}
        validate_payload("speaking", value, "json-integers")

for index, item in enumerate(FIXTURE["records"]):
    def check(self, item=item):
        before = encoded(item["request"])
        request = item["request"]
        validate_payload(request["kind"], request["payload"], item["recordId"])
        if request["kind"] == "feedback" and request["payload"].get("taskType") == "speaking":
            work = work_for(request["payload"])
            validate_speaking_feedback_reference(request["payload"], work["request"]["kind"], work["request"]["payload"])
        self.assertEqual(content_hash(request["kind"], request["payload"]), item["expectedContentHash"])
        self.assertEqual(encoded(item["request"]), before)
    setattr(R3ContractTest, f"test_shared_wire_{index+1:02d}_{item['recordId'].replace('-', '_')}", check)
for index, case in enumerate(FIXTURE["invalidCases"]):
    def check(self, case=case):
        value, kind = invalid_payload(case), record(case["recordId"])["request"]["kind"]
        if case.get("referenceTarget"):
            validate_payload(kind, value, "invalid-reference")
            work = record(case["referenceTarget"])
            with self.assertRaisesRegex(LearningError, case["error"]):
                validate_speaking_feedback_reference(value, work["request"]["kind"], work["request"]["payload"])
        else:
            with self.assertRaisesRegex(LearningError, case["error"]):
                validate_payload(kind, value, "invalid-field")
    setattr(R3ContractTest, f"test_invalid_{index+1:02d}_{case['label'].replace(' ', '_').replace('-', '_')}", check)
for cause in sorted(SPEAKING_ERROR_CAUSES):
    def check(self, cause=cause):
        value = {**record("r3-feedback-self")["request"]["payload"], "errorCauses": [cause]}
        validate_payload("feedback", value, "allowed-speaking-cause")
    setattr(R3ContractTest, f"test_allowed_cause_{cause.replace('-', '_')}", check)
for field in ["audio", "audioBase64", "blob", "audioUrl"]:
    def check(self, field=field):
        with self.assertRaisesRegex(LearningError, "不支持的字段"):
            validate_payload("speaking", {"planId": "r3-plan", "transcript": "Synthetic", field: "not-real-audio"}, "forbidden-audio")
    setattr(R3ContractTest, f"test_rejects_undeclared_{field}", check)

NEW_FIELDS = [("speaking", "part", 1), ("speaking", "prepSeconds", 0), ("speaking", "conditions", {"timed": True, "firstAttempt": True, "unseen": False}), ("speaking", "sourceRef", "Self-authored practice"), ("speaking", "recordingStatus", "none"), ("feedback", "taskType", "speaking"), ("feedback", "errorCauses", ["fluency-pause"]), ("feedback", "checklist", {"speaking-fluency-continuity": True})]
for kind, field, value in NEW_FIELDS:
    def check(self, kind=kind, field=field, value=value):
        base = {"planId": "r3-plan", "transcript": "A synthetic spoken answer."} if kind == "speaking" else {"planId": "r3-plan", "taskType": "speaking", "workRevisionId": "71000000-0000-4000-8000-000000000001", "inputHash": "0" * 64, "source": "self", "text": "A synthetic review."}
        validate_payload(kind, {**base, field: value}, "independent-field")
    setattr(R3ContractTest, f"test_independent_{kind}_{field}", check)

class R3ReferenceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="band-r3-reference-")
        self.addCleanup(self.directory.cleanup)
        self.database = Database(Path(self.directory.name) / "learning.sqlite3")
        with self.database.connect() as db:
            db.execute("INSERT INTO users VALUES(?,?,?,?)", ("r3-test-user", "r3-contract-user", "unused-test-hash", 1))
        self.store = LearningStore(self.database)
        for item in FIXTURE["records"]:
            self.store.put("r3-test-user", item["recordId"], item["request"])

    def reject_reference(self, value, message):
        validate_payload("feedback", value, "r3-invalid-reference")
        body = {"schemaVersion": 2, "kind": "feedback", "revisionId": str(uuid.uuid4()), "mutationId": str(uuid.uuid4()), "baseRevision": None, "payload": value}
        with self.assertRaisesRegex(LearningError, message):
            self.store.put("r3-test-user", "r3-invalid-reference", body)
        with self.database.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM learning_revisions").fetchone()[0], len(FIXTURE["records"]))

    def test_speaking_self_check_cannot_reference_an_essay_with_accurate_ids_and_hash(self):
        case = next(case for case in FIXTURE["invalidCases"] if case.get("referenceTarget") and case["recordId"] == "r3-feedback-self")
        self.reject_reference(invalid_payload(case), "口语原稿")

    def test_speaking_discriminator_alone_cannot_reference_an_essay(self):
        case = next(case for case in FIXTURE["invalidCases"] if case.get("referenceTarget") and case["recordId"] == "r3-feedback-rules")
        value = invalid_payload(case)
        self.assertFalse(set(value) & {"bands", "errorCauses", "checklist", "spellingCheck"})
        self.reject_reference(value, "口语原稿")

    def test_changed_transcript_hash_cannot_reuse_an_earlier_review(self):
        value = {**record("r3-feedback-self")["request"]["payload"], "inputHash": "0" * 64}
        self.reject_reference(value, "原稿版本不匹配")

if __name__ == "__main__":
    unittest.main()
