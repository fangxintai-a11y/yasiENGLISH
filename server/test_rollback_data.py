"""Vocabulary rollback leaves archived records and existing account data untouched."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

try:
    from . import app
except ImportError:
    import app


class RollbackDataTest(unittest.TestCase):
    def test_startup_preserves_existing_vocabulary_and_unread_archive_tables(self):
        with tempfile.TemporaryDirectory(prefix='band-vocabulary-rollback-') as scratch:
            path = Path(scratch) / 'progress.sqlite3'
            database = app.Database(path)
            with database.connect() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,?)', ('owner', 'owner', 'fixture password hash', 1))
                payload = '{"progress":{"version":2},"fixture":"原始词汇快照"}'
                db.execute('INSERT INTO snapshots VALUES(?,?,?,?,?)', ('owner', 'word-atlas-open', 42, payload, 1))
                db.execute('INSERT INTO snapshot_history VALUES(?,?,?,?,?)', ('owner', 'word-atlas-open', 41, payload, 1))
                # The rollback must not interpret, overwrite, migrate backwards or delete these tables.
                for name in ['learning_records', 'learning_revisions', 'learning_mutation_receipts', 'learning_schema_migrations']:
                    db.execute(f'CREATE TABLE {name}(fixture_id INTEGER PRIMARY KEY, payload TEXT)')
                    db.execute(f'INSERT INTO {name} VALUES(1,?)', ('原始作品正文，不属于词汇版的写入范围',))
            tables = ['users', 'snapshots', 'snapshot_history', 'learning_records', 'learning_revisions', 'learning_mutation_receipts', 'learning_schema_migrations']
            def rows():
                with closing(sqlite3.connect(path)) as db:
                    return {name: db.execute(f'SELECT * FROM {name}').fetchall() for name in tables}
            before = rows()
            server = app.create_server(port=0, db_path=path, single_user=True)
            server.server_close()
            self.assertEqual(rows(), before)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_snapshot_accepts_both_preference_formats_without_stripping_them(self):
        snapshot = {'settings': {'feedbackMode': 'rules', 'aiModel': 'legacy model name'}, 'progress': {
            'version': 2, 'datasetId': 'word-atlas-open', 'cards': {}, 'skills': {}, 'session': None,
        }}
        before = json.dumps(snapshot)
        self.assertEqual(app.validate_snapshot(snapshot, 'word-atlas-open'), snapshot)
        self.assertEqual(json.dumps(snapshot), before)
