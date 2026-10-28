"""Voice every example sentence (and listening phrase) with one open voice, Kokoro af_heart (resumable).

The old recordings mixed two ElevenLabs voices and fell back to the device voice for the
6,000+ IELTS-context sentences that were never recorded. This replaces all of them with a
single voice so the whole app sounds the same.

Usage:
  python3 scripts/ielts/gen_sentence_audio_kokoro.py --lib <kokoro-onnx site dir> --model <dir with
      kokoro-v1.0.onnx + voices-v1.0.bin> [--kind ex ex2 phrase] [--workers 2 --threads 2] [--limit N]

Writes public/atlas/audio/{say,say2}/<id>.mp3 and public/ielts/phrase/<key>.mp3; existing files are
skipped, so the run can be stopped and resumed at any time.
"""
import argparse
import hashlib
import json
import multiprocessing as mp
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VOICE, LANG = "af_heart", "en-us"
LUFS, PEAK, RATE, BITRATE = -18, -1.5, 24000, "40k"
DIRS = {"ex": ROOT / "public/atlas/audio/say", "ex2": ROOT / "public/atlas/audio/say2", "phrase": ROOT / "public/ielts/phrase"}


def phrase_key(text: str) -> str:
    """Stable file name for a phrase; mirrored by phraseAudio() in src/ielts/tags.ts."""
    return hashlib.sha1(text.strip().lower().encode()).hexdigest()[:12]


def jobs(kinds, limit):
    words = json.loads((ROOT / "data/word-atlas.json").read_text(encoding="utf-8"))
    order = {c: i for i, c in enumerate(["A1", "A2", "B1", "B2", "C1", "C2"])}
    # Learning order first, so a partial run already covers the words people meet first.
    words.sort(key=lambda w: (order.get(w.get("cefr"), 9), w["id"]))
    out = []
    for kind in kinds:
        if kind == "phrase":
            tags = json.loads((ROOT / "public/ielts/tags.json").read_text(encoding="utf-8"))
            seen = set()
            for text, _ in tags["phrases"]:
                k = phrase_key(text)
                if k not in seen:
                    seen.add(k)
                    out.append((kind, k, text.strip()))
            continue
        i = 0 if kind == "ex" else 1
        for w in words:
            ex = w.get("ex") or []
            if len(ex) > i and ex[i]["en"].strip():
                out.append((kind, w["id"], ex[i]["en"].strip()))
    todo = [j for j in out if not (DIRS[j[0]] / f"{j[1]}.mp3").exists()]
    return (todo[:limit] if limit else todo), len(out) - len(todo), len(out)


def encode(samples, sr, dest: Path):
    tmp = dest.with_suffix(".part.mp3")
    # A short lead-in keeps Bluetooth headphones from swallowing the first syllable.
    af = f"adelay=60:all=1,apad=pad_dur=0.12,loudnorm=I={LUFS}:TP={PEAK}:LRA=11,aresample={RATE}"
    p = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-",
         "-af", af, "-ac", "1", "-c:a", "libmp3lame", "-b:a", BITRATE, "-map_metadata", "-1", str(tmp)],
        input=samples.astype("float32").tobytes(), capture_output=True)
    if p.returncode:
        raise RuntimeError(p.stderr.decode()[-300:])
    os.replace(tmp, dest)


def worker(args):
    lib, model, threads, q, done = args
    sys.path.insert(0, lib)
    import onnxruntime as rt
    from kokoro_onnx import Kokoro
    so = rt.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    sess = rt.InferenceSession(os.path.join(model, "kokoro-v1.0.onnx"), so, providers=["CPUExecutionProvider"])
    k = Kokoro.from_session(sess, os.path.join(model, "voices-v1.0.bin"))
    while True:
        job = q.get()
        if job is None:
            return
        kind, key, text = job
        try:
            samples, sr = k.create(text, voice=VOICE, speed=1.0, lang=LANG)
            encode(samples, sr, DIRS[kind] / f"{key}.mp3")
            done.put((kind, key, len(samples) / sr, None))
        except Exception as e:  # keep going; the file stays missing and a rerun retries it
            done.put((kind, key, 0, repr(e)[:200]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--kind", nargs="+", default=["ex2", "ex", "phrase"], choices=list(DIRS))
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-seconds", type=float, default=0, help="stop handing out work after this long")
    a = ap.parse_args()
    for d in DIRS.values():
        d.mkdir(parents=True, exist_ok=True)
        for f in d.glob("*.part.mp3"):
            f.unlink()
    todo, have, total = jobs(a.kind, a.limit)
    print(f"{len(todo)} to voice ({have} of {total} already done)", flush=True)
    if not todo:
        return
    ctx = mp.get_context("spawn")
    q, done = ctx.Queue(), ctx.Queue()
    procs = [ctx.Process(target=worker, args=((a.lib, a.model, a.threads, q, done),)) for _ in range(a.workers)]
    for p in procs:
        p.start()
    start = time.time()
    fed = 0
    # Feed lazily so --max-seconds can stop cleanly between sentences.
    for j in todo[: a.workers * 2]:
        q.put(j)
        fed += 1
    ok = fail = 0
    audio = 0.0
    while ok + fail < fed:
        kind, key, secs, err = done.get()
        if err:
            fail += 1
            print(f"FAIL {kind} {key}: {err}", flush=True)
        else:
            ok += 1
            audio += secs
        if fed < len(todo) and not (a.max_seconds and time.time() - start > a.max_seconds):
            q.put(todo[fed])
            fed += 1
        n = ok + fail
        if n % 100 == 0 or n == fed:
            el = time.time() - start
            print(f"{n}/{len(todo)} ok={ok} fail={fail} {el:.0f}s rtf={el / max(audio, 1e-9):.2f} "
                  f"eta={el / n * (len(todo) - n) / 60:.0f}min", flush=True)
    for _ in procs:
        q.put(None)
    for p in procs:
        p.join()


if __name__ == "__main__":
    main()
