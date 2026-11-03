#!/usr/bin/env python3
"""Back up a live SQLite database including its WAL; retain 14 days."""
import argparse
import datetime
import os
from pathlib import Path
import secrets
import sqlite3
import time
import re
import hashlib
import json
from contextlib import closing

# Reviewed vocabulary-only server/app.py from V1.2.0-11.3, commit
# f3384e35719b19f38e515f9cb8cfaca7c408f78f. Absence of learning.py alone
# says nothing about whether an entry point is safe to run after a migration.
VERIFIED_WORD_ONLY_SHA256 = frozenset({
    "9b9b7a38e67eb5c9bc26983e5daf544f86df87b413739b7b84fc36be34379611",
})


def verify_api_compatibility(database, target):
    """Read-only check; an unmarked learning API must never resume writes after v2 migration."""
    target, database = Path(target), Path(database).resolve()
    if target.is_symlink() or not (target / "app.py").is_file() or (target / "app.py").is_symlink():
        return False
    target = target.resolve()
    try:
        if not (target / "learning.py").exists():
            # Only exact reviewed code may use this legacy, non-learning path.
            return hashlib.sha256((target / "app.py").read_bytes()).hexdigest() in VERIFIED_WORD_ONLY_SHA256
        metadata_file = target / "runtime-meta.json"
        if metadata_file.is_symlink():
            return False
        metadata = json.loads(metadata_file.read_text())
        protocol = metadata["learningProtocolVersion"]
        schema = metadata["learningSchemaVersion"]
        if type(protocol) is not int or protocol < 2 or type(schema) is not int or schema < 0:
            return False
        current_schema = 0
        if database.is_file():
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='learning_schema_migrations'").fetchone():
                    current_schema = db.execute("SELECT COALESCE(MAX(version),0) FROM learning_schema_migrations").fetchone()[0]
        if schema != current_schema:
            return False
        hashes = metadata["moduleSha256"]
        if not isinstance(hashes, dict) or not {"app.py", "learning.py"}.issubset(hashes):
            return False
        for name, expected in hashes.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*\.py", name) or not isinstance(expected, str):
                return False
            source = target / name
            if not source.is_file() or source.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        return False


def backup_database(database, directory, prefix="daily", now=None):
    database, directory = Path(database).resolve(), Path(directory).resolve()
    if not database.is_file():
        return None
    now = time.time() if now is None else now
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target = directory / f"{prefix}-{stamp}-{secrets.token_hex(3)}.sqlite3"
    temporary = target.with_suffix(".partial")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=30)) as source, closing(sqlite3.connect(temporary)) as output:
            source.backup(output)
            if output.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Database backup integrity check failed")
        temporary.rename(target)
    finally:
        temporary.unlink(missing_ok=True)
    # Only remove complete backups made by this helper, after a new one succeeds.
    for old in directory.glob("*.sqlite3"):
        if re.fullmatch(r"(?:daily|predeploy)-\d{8}T\d{12}Z-[a-f0-9]{6}\.sqlite3", old.name) and not old.is_symlink() and old.is_file() and old.stat().st_mtime < now - 14 * 86400:
            old.unlink()
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="/var/lib/band-galaxy/progress.sqlite3")
    parser.add_argument("--directory", default="/var/lib/band-galaxy/backups")
    parser.add_argument("--prefix", choices=("daily", "predeploy"), default="daily")
    parser.add_argument("--verify-api", type=Path, help="Only check whether this API may write the current learning schema")
    arguments = parser.parse_args()
    if arguments.verify_api is not None:
        compatible = verify_api_compatibility(arguments.db, arguments.verify_api)
        print("API rollback compatibility verified." if compatible else "API rollback compatibility is unverified; writes must remain stopped.")
        raise SystemExit(0 if compatible else 1)
    target = backup_database(arguments.db, arguments.directory, arguments.prefix)
    print("Database backup completed." if target else "Database not created yet; no backup needed.")


if __name__ == "__main__":
    main()
