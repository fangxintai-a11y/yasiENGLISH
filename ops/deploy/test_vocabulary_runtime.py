"""Only the reviewed account-preserving vocabulary runtime may replace the learning API."""
import hashlib
import importlib.util
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

OPS = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('vocabulary_backup_guard', OPS / 'backup-sync.py')
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)


class VocabularyRuntimeTest(unittest.TestCase):
    def test_reviewed_pair_accepts_archived_data_and_rejects_either_module_drift(self):
        with tempfile.TemporaryDirectory(prefix='band-vocabulary-runtime-') as scratch:
            root = Path(scratch)
            target = root / 'release'
            target.mkdir()
            for name in ('app.py', 'auth_access.py'):
                shutil.copyfile(OPS.parents[1] / 'server' / name, target / name)
            database = root / 'existing.sqlite3'
            db = sqlite3.connect(database)
            db.execute('CREATE TABLE learning_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)')
            db.execute('INSERT INTO learning_schema_migrations VALUES(2,1)')
            db.commit()
            db.close()
            before = hashlib.sha256(database.read_bytes()).hexdigest()
            self.assertTrue(GUARD.verify_api_compatibility(database, target))
            for name in ('app.py', 'auth_access.py'):
                original = (target / name).read_bytes()
                (target / name).write_bytes(original + b'\n# changed after review\n')
                self.assertFalse(GUARD.verify_api_compatibility(database, target))
                (target / name).write_bytes(original)
            (target / 'auth_access.py').unlink()
            self.assertFalse(GUARD.verify_api_compatibility(database, target))
            (target / 'auth_access.py').symlink_to(OPS.parents[1] / 'server/auth_access.py')
            self.assertFalse(GUARD.verify_api_compatibility(database, target))
            self.assertEqual(hashlib.sha256(database.read_bytes()).hexdigest(), before)


if __name__ == '__main__':
    unittest.main()
