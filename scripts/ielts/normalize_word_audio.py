"""Bring every word recording to the loudness of the sentence recordings (about -19 LUFS).

The British word recordings sat around -23 LUFS and the American ones around -19, so switching
accent, or going from a word to its sentence, jumped in volume. Each file is measured and given
the gain it needs, with a limiter so nothing clips; the voice itself is untouched.

Usage: python3 scripts/ielts/normalize_word_audio.py [--workers 2]
Reads public/atlas/audio/{uk,us}/ and writes public/atlas/audio/{word-uk,word-us}/ (new folders, so
browsers and offline packs fetch the new files instead of keeping the old ones). Resumable.
"""
import argparse
import concurrent.futures as cf
import os
import re
import subprocess
from pathlib import Path

AUDIO = Path(__file__).resolve().parents[2] / "public/atlas/audio"
TARGET = -19.0
PAIRS = {"uk": "word-uk", "us": "word-us"}


def loudness(path: Path) -> float | None:
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.findall(r"I:\s+(-?\d+(?:\.\d+)?) LUFS", p.stderr)
    return float(m[-1]) if m else None


def fix(src: Path, dest: Path) -> str:
    level = loudness(src)
    # Very short or silent clips measure badly: leave their level alone rather than blow them up.
    gain = 0.0 if level is None or level < -45 else max(-8.0, min(10.0, TARGET - level))
    tmp = dest.with_suffix(".part.mp3")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-af", f"volume={gain:.2f}dB,alimiter=limit=0.89:level=false",
                    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", "-map_metadata", "-1", str(tmp)], check=True)
    os.replace(tmp, dest)
    return f"{gain:+.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    jobs = []
    for src_dir, out_dir in PAIRS.items():
        (AUDIO / out_dir).mkdir(exist_ok=True)
        for f in sorted((AUDIO / src_dir).glob("*.mp3")):
            dest = AUDIO / out_dir / f.name
            if not dest.exists():
                jobs.append((f, dest))
    print(f"{len(jobs)} to normalise", flush=True)
    with cf.ThreadPoolExecutor(a.workers) as pool:
        for n, _ in enumerate(pool.map(lambda j: fix(*j), jobs), 1):
            if n % 500 == 0:
                print(f"{n}/{len(jobs)}", flush=True)


if __name__ == "__main__":
    main()
