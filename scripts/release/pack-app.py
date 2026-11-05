#!/usr/bin/env python3
"""Package an already built app; media stays in a separately synced shared directory."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile

MEDIA = {'.mp3', '.m4a', '.pdf', '.wav', '.ogg', '.webm'}
SHARED_PATHS = ('ielts/phrase', 'sfx', 'curriculum365/v1/audio')
BLOCKED = {'local-bank', 'local-content', 'private', '.git', 'node_modules'}

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def files(root):
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symbolic links are not accepted in build inputs: ' + str(path))
        if path.is_file():
            yield path

def forbidden(relative):
    parts = PurePosixPath(relative).parts
    name = parts[-1]
    return bool(set(parts) & BLOCKED or name.startswith('.env') or name.endswith(('.sqlite', '.sqlite3', '.sqlite3-wal', '.sqlite3-shm', '.key', '.pem')) or name in {'server.env', 'credentials.json'})

def package(source_root, dist, out, commit, atlas_out):
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Pass the full 40-character source commit')
    source_root, dist, out, atlas_out = map(lambda p: Path(p).resolve(), (source_root, dist, out, atlas_out))
    if not dist.is_dir() or not (dist/'index.html').is_file():
        raise ValueError('Build the frontend first')
    if out.exists():
        raise ValueError('The archive already exists; keep existing candidates immutable')
    if dist in out.parents or dist == atlas_out or dist in atlas_out.parents or atlas_out in dist.parents or source_root == atlas_out:
        raise ValueError('The shared output must be outside the app build')
    build = json.loads((dist/'build-info.json').read_text())
    if build.get('fullCommit') != commit or build.get('sourceDirty') is not False:
        raise ValueError('Build metadata must match a clean source commit')
    runtime = json.loads((source_root/'server/runtime-files.json').read_text())
    if not isinstance(runtime, list) or not {'app.py', 'learning.py'}.issubset(runtime) or len(runtime) != len(set(runtime)):
        raise ValueError('Invalid API runtime manifest')
    for name in runtime:
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*\.py', name):
            raise ValueError('Invalid API runtime module')
        path = source_root/'server'/name
        if path.is_symlink() or not path.is_file() or digest(path) != build.get('apiFiles', {}).get(name):
            raise ValueError('API source differs from the tested build: ' + name)
    source_atlas = dist/'atlas'
    if not all((source_atlas/p).is_file() for p in ('index.json',)):
        raise ValueError('Missing shared atlas')
    # Validate inputs before touching either output. Private banks are excluded, never copied.
    selected, shared = [], []
    for path in files(dist):
        rel = path.relative_to(dist).as_posix()
        if set(PurePosixPath(rel).parts) & BLOCKED:
            continue
        if forbidden(rel):
            raise ValueError('Unexpected sensitive build output: ' + rel)
        if rel.startswith('atlas/'):
            shared.append((path, rel[len('atlas/'):]))
        elif any(rel == p or rel.startswith(p + '/') for p in SHARED_PATHS):
            shared.append((path, '_public/' + rel))
        elif path.suffix.lower() in MEDIA:
            raise ValueError('Unmapped media must not enter the app archive: ' + rel)
        else:
            selected.append((path, 'dist/' + rel))
    shared_paths = [{'path': p, 'sharedPath': '_public/' + p} for p in SHARED_PATHS if (dist/p).is_dir()]
    release = {'formatVersion': 1, 'sharedAtlas': True, 'commit': commit, 'sharedPaths': shared_paths}
    out.parent.mkdir(parents=True, exist_ok=True)
    atlas_out.mkdir(parents=True, exist_ok=True)
    copied = 0
    for source, relative in shared:
        destination = atlas_out/relative
        if not destination.resolve().is_relative_to(atlas_out):
            raise ValueError('Shared output path escapes its root')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink():
            raise ValueError('Shared output cannot contain symlinks')
        if not destination.is_file() or digest(destination) != digest(source):
            shutil.copyfile(source, destination)
            copied += 1
    with tempfile.TemporaryDirectory(prefix='band-app-pack-') as temporary:
        stage = Path(temporary)
        for source, rel in selected:
            target = stage/rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        for name in ['runtime-files.json', *runtime]:
            target = stage/'server'/name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_root/'server'/name, target)
        (stage/'release-manifest.json').write_text(json.dumps(release, sort_keys=True, separators=(',', ':'))+'\n')
        entries = [{'path': p.relative_to(stage).as_posix(), 'bytes': p.stat().st_size, 'sha256': digest(p)} for p in files(stage)]
        partial = out.with_suffix(out.suffix+'.part')
        try:
            with partial.open('xb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT, pax_headers={'comment': commit}) as archive:
                    for p in files(stage):
                        info = archive.gettarinfo(str(p), p.relative_to(stage).as_posix())
                        info.uid = info.gid = 0
                        info.uname = info.gname = ''
                        info.mtime = 0
                        info.mode = 0o644
                        with p.open('rb') as content:
                            archive.addfile(info, content)
            if partial.stat().st_size >= 50 * 1024 * 1024:
                raise ValueError('Application archive exceeds 50 MiB')
            partial.replace(out)
        finally:
            partial.unlink(missing_ok=True)
    result = {'commit': commit, 'version': build.get('version'), 'archive': str(out), 'archiveBytes': out.stat().st_size, 'sha256': digest(out), 'files': entries, 'sharedAtlas': str(atlas_out), 'sharedFiles': len(shared), 'sharedBytes': sum(p.stat().st_size for p, _ in shared), 'sharedCopied': copied, 'sharedPaths': shared_paths}
    out.with_suffix(out.suffix+'.json').write_text(json.dumps(result, indent=2)+'\n')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--dist', default='dist')
    parser.add_argument('--out', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--atlas-out', required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.source_root, args.dist, args.out, args.commit, args.atlas_out), ensure_ascii=False, indent=2))
