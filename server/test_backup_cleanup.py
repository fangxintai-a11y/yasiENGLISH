import sqlite3
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

try:
    from . import app
except ImportError:
    import app


class BackupCleanupTest(unittest.TestCase):
    def test_backup_closes_destination_connection(self):
        with tempfile.TemporaryDirectory(prefix="band-backup-close-") as scratch:
            database = app.Database(Path(scratch) / "source.sqlite3")
            target = (Path(scratch) / "backup.sqlite3").resolve()
            original_connect, outputs = sqlite3.connect, []

            def track(path, *args, **kwargs):
                connection = original_connect(path, *args, **kwargs)
                if str(path) == str(target):
                    outputs.append(connection)
                return connection

            try:
                with patch.object(app.sqlite3, "connect", side_effect=track):
                    database.backup(target)
                self.assertEqual(len(outputs), 1)
                with self.assertRaises(sqlite3.ProgrammingError):
                    outputs[0].execute("SELECT 1")
            finally:
                for connection in outputs:
                    connection.close()
