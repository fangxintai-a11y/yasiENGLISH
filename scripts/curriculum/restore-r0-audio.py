#!/usr/bin/env python3
"""Restore the existing self-authored fixture, never tracking media in the current tree."""
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SOURCE_COMMIT = 'afa9369672907ad843b7706185844956b77702ba'
RELATIVE = 'public/curriculum365/v1/audio/listening-sample-01.mp3'
URL = f'https://raw.githubusercontent.com/fangxintai-a11y/yasiENGLISH/{SOURCE_COMMIT}/{RELATIVE}'


def restore(root=ROOT, opener=urllib.request.urlopen):
    root = Path(root)
    target = root / RELATIVE
    expected = json.loads(target.with_name('provenance.json').read_text())['sha256']
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        return 'Existing self-authored audio verified.'
    # This exact public historical blob already exists; no voice regeneration or real exam fetch.
    with opener(URL, timeout=60) as response:
        content = response.read(4 * 1024 * 1024 + 1)
    if len(content) > 4 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != expected:
        raise ValueError('Fixture SHA256 or size failed; existing local data was not changed.')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
        partial = Path(temporary.name)
        temporary.write(content)
    try:
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return 'Self-authored audio restored and verified outside Git.'


if __name__ == '__main__':
    print(restore())
