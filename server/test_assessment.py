"""Per-word assessment snapshots remain compatible with older browser tabs."""
import copy
import json
import sqlite3
import tempfile
from pathlib import Path
import unittest

try:
    from .app import ApiError, Database, MAX_BODY, validate_snapshot
except ImportError:
    from app import ApiError, Database, MAX_BODY, validate_snapshot


def snapshot():
    return {"progress": {"version": 2, "datasetId": "words", "cards": {}, "session": None}, "settings": {}}


class AssessmentTest(unittest.TestCase):
    def test_full_catalog_with_three_memory_tracks_and_assessment_fits_snapshot_limits(self):
        root = Path(__file__).resolve().parents[1]
        base = json.loads((root / "public/atlas/index.json").read_text())
        extra = json.loads((root / "public/atlas/supplement.json").read_text())
        ids = [row[0] for row in base["words"]] + [row["id"] for row in extra["entries"]]
        self.assertEqual(len(set(ids)), 9860)
        card = {"due": 1795000000000, "s": 12.12345678912345, "d": 4.12345678901234, "el": 3, "sd": 12, "ls": 0, "reps": 10, "lapses": 1, "st": 2, "last": 1794000000000, "seen": 1793000000000}
        value = snapshot()
        value["progress"]["cards"] = {word: card for word in ids}
        value["progress"]["skills"] = {prefix + word: card for word in ids for prefix in ("l:", "p:")}
        value["progress"]["assessment"] = {"marks": {word: {"state": "unknown", "at": 1794000000000} for word in ids}}
        self.assertLess(len(json.dumps(value, separators=(",", ":")).encode()), MAX_BODY)
        self.assertEqual(validate_snapshot(value, "words"), value)

    def test_word_ids_are_not_credentials_but_unrecognized_mark_fields_are_rejected(self):
        value = snapshot()
        value["progress"]["assessment"] = {"marks": {word: {"state": "unknown", "at": 100} for word in ("key", "secret", "password")}}
        self.assertEqual(validate_snapshot(value, "words"), value)
        empty = snapshot()
        empty["progress"]["assessment"] = None
        with self.assertRaises(ApiError):
            validate_snapshot(empty, "words")
        bad = copy.deepcopy(value)
        bad["progress"]["assessment"]["marks"]["key"]["apiKey"] = "private"
        with self.assertRaises(ApiError):
            validate_snapshot(bad, "words")
        for state, at in (("mastered", 100), ("known", True), ("unknown", -1)):
            bad = snapshot()
            bad["progress"]["assessment"] = {"marks": {"book": {"state": state, "at": at}}}
            with self.assertRaises(ApiError):
                validate_snapshot(bad, "words")

    def test_legacy_snapshot_cannot_erase_assessment_but_an_explicit_empty_map_can(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.sqlite3"
            database = Database(path)
            with sqlite3.connect(path) as db:
                db.execute("INSERT INTO users VALUES(?,?,?,?)", ("owner", "fixture", "unchanged-hash", 1))
                account_before = db.execute("SELECT * FROM users").fetchall()
            first = snapshot()
            first["progress"]["assessment"] = {"marks": {"book": {"state": "unknown", "at": 100}}}
            first["progress"]["days"] = {"2026-11-07": {"n": 1, "r": 2, "c": 1, "t": 60, "sp": 5, "sc": 3, "sh": 1}}
            self.assertTrue(database.put_snapshot("owner", "words", 0, first, "first")[0])
            legacy = snapshot()
            legacy["progress"]["days"] = {"2026-11-07": {"n": 1, "r": 3, "c": 2, "t": 70}}
            accepted, result = database.put_snapshot("owner", "words", 1, legacy, "legacy")
            self.assertTrue(accepted)
            self.assertEqual(result["snapshot"]["progress"]["assessment"], first["progress"]["assessment"])
            self.assertEqual(result["snapshot"]["progress"]["days"]["2026-11-07"]["sp"], 5)
            self.assertEqual(result["snapshot"]["progress"]["days"]["2026-11-07"]["r"], 3)
            clear = snapshot()
            clear["progress"]["assessment"] = {"marks": {}}
            self.assertTrue(database.put_snapshot("owner", "words", 2, clear, "clear")[0])
            accepted, result = database.put_snapshot("owner", "words", 3, snapshot(), "legacy-again")
            self.assertEqual(result["snapshot"]["progress"]["assessment"], {"marks": {}})
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("SELECT * FROM users").fetchall(), account_before)


if __name__ == "__main__":
    unittest.main()
