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
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=30) as source, sqlite3.connect(temporary) as output:
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
    arguments = parser.parse_args()
    target = backup_database(arguments.db, arguments.directory, arguments.prefix)
    print("Database backup completed." if target else "Database not created yet; no backup needed.")


if __name__ == "__main__":
    main()
