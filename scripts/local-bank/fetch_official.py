"""Fetch the explicit official URL inventory; no source material enters git."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import zipfile


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("destination", nargs="?", default="local-content/official")
    parser.add_argument("--manifest", default=str(Path(__file__).parent.parent / "official-samples.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = Path(args.destination).resolve()
    config = json.loads(Path(args.manifest).read_text())
    if config.get("schemaVersion") != 1 or not isinstance(config.get("files"), list) or len(config["files"]) > 100:
        raise ValueError("官方清单格式无效。")
    if not args.dry_run:
        root.mkdir(parents=True, exist_ok=True)
    log_path = root / "fetch-log.json"
    try:
        previous = {row["path"]: row for row in json.loads(log_path.read_text())["files"] if row.get("sha256")}
    except (FileNotFoundError, ValueError, KeyError):
        previous = {}
    results = []
    for item in config["files"]:
        relative = PurePosixPath(item["path"])
        if relative.is_absolute() or ".." in relative.parts or "\\" in item["path"]:
            raise ValueError("官方清单含不安全路径。")
        output = root / item["path"]
        row = {"id": item["id"], "url": item["url"], "path": item["path"]}
        if args.dry_run:
            print(json.dumps({**row, "status": "planned"}, ensure_ascii=False))
            continue
        try:
            output.parent.mkdir(parents=True, exist_ok=True)
            expected = item.get("sha256") or previous.get(item["path"], {}).get("sha256")
            if output.is_file() and expected and digest(output) == expected:
                row["status"] = "skipped"
            else:
                part = Path(str(output) + ".part")
                subprocess.run(["curl", "-fL", "--retry", "3", "--connect-timeout", "30", "--max-time", "300", "-C", "-", item["url"], "-o", str(part)], check=True)
                if expected and digest(part) != expected:
                    raise ValueError("下载文件SHA256与清单不符，原文件保留。")
                part.replace(output)
                row["status"] = "downloaded"
            row.update(bytes=output.stat().st_size, sha256=digest(output))
            if item.get("role") == "archive":
                with zipfile.ZipFile(output) as archive:
                    for member in archive.infolist():
                        name = PurePosixPath(member.filename)
                        if name.is_absolute() or ".." in name.parts or member.external_attr >> 16 & 0o170000 == 0o120000:
                            raise ValueError("官方ZIP含不安全路径或链接，未解压。")
                    if archive.testzip() is not None:
                        raise ValueError("官方ZIP校验失败。")
                    archive.extractall(root / "cambridge-sample")
        except (OSError, ValueError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
            row.update(status="failed", error=str(error))
        results.append(row)
        log_path.write_text(json.dumps({"sourcePage": config.get("sourcePage"), "files": results}, ensure_ascii=False, indent=2))
    if not args.dry_run:
        print(json.dumps({"downloaded": sum(row["status"] == "downloaded" for row in results), "skipped": sum(row["status"] == "skipped" for row in results), "failed": sum(row["status"] == "failed" for row in results), "log": str(log_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
