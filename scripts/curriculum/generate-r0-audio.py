#!/usr/bin/env python3
"""Reproduce the R0 ten-question Section 4 from the repository's segment texts.

Run in an environment that already provides kokoro-onnx, onnxruntime, soundfile,
numpy, phonemizer and espeakng-loader. Versions used for the checked-in WAV are
recorded in public/curriculum365/v1/audio/provenance.json. This script does not
install dependencies or download models, and is not an application dependency.

Example:
    python scripts/curriculum/generate-r0-audio.py \
      --model /path/to/kokoro-v1.0.int8.onnx \
      --voices /path/to/voices-v1.0.bin

Inputs must match the official model-files-v1.1 int8/voice digests below. Only
public/curriculum365/v1/audio/listening-sample-01.wav, provenance.json and the
sample's duration/evidence timestamps in samples.json are written. Runtime
and platform differences can affect generated samples; the provenance records
the exact output hash rather than promising bit-identical cross-platform TTS.
"""

from __future__ import annotations

import argparse
from datetime import datetime
from importlib import metadata
import hashlib
import json
from pathlib import Path
import platform
from zoneinfo import ZoneInfo


REPOSITORY = Path(__file__).resolve().parents[2]
SAMPLE_ID = "listening-sample-01"
SAMPLES_PATH = REPOSITORY / "public/curriculum365/v1/samples.json"
OUTPUT_DIRECTORY = REPOSITORY / "public/curriculum365/v1/audio"
GENERATOR_PATH = "scripts/curriculum/generate-r0-audio.py"
SAMPLE_RATE = 24000
VOICE = "af_heart"
LANGUAGE = "en-us"
SPEED = 0.9
MODEL_NAME = "kokoro-v1.0.int8.onnx"
VOICES_NAME = "voices-v1.0.bin"
MODEL_SHA256 = "ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c"
VOICES_SHA256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"
RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for data in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def read_segments() -> list[dict[str, str]]:
    catalog = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))
    materials = [item for item in catalog["materials"] if item["id"] == SAMPLE_ID]
    if len(materials) != 1 or materials[0]["skill"] != "listening":
        raise ValueError("Expected exactly one listening-sample-01 material.")
    segments = materials[0]["segments"]
    if len(segments) != 10 or len(materials[0]["questions"]) != 10:
        raise ValueError("The R0 Section 4 sample requires ten segments and questions.")
    if any(
        not isinstance(segment.get("id"), str)
        or not segment["id"]
        or not isinstance(segment.get("text"), str)
        or not segment["text"].strip()
        for segment in segments
    ) or len({segment["id"] for segment in segments}) != len(segments):
        raise ValueError("Segment IDs must be unique; each segment needs text.")
    if " ".join(segment["text"] for segment in segments) != materials[0]["transcript"]:
        raise ValueError("Segments must exactly match the immutable source transcript.")
    for question in materials[0]["questions"]:
        if sum(segment["text"] == question["evidence"]["quote"] for segment in segments) != 1:
            raise ValueError("Each question must reference exactly one complete audio segment.")
    return [{"id": segment["id"], "text": segment["text"]} for segment in segments]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, type=Path, help="Official kokoro-v1.0.int8.onnx file")
    parser.add_argument("--voices", required=True, type=Path, help="Official voices-v1.0.bin file")
    args = parser.parse_args()
    segments = read_segments()
    for path, expected in ((args.model, MODEL_SHA256), (args.voices, VOICES_SHA256)):
        if not path.is_file() or sha256_file(path) != expected:
            raise ValueError(f"Missing model asset or unexpected SHA256: {path.name}")

    # Imports are delayed so --help remains usable without TTS dependencies.
    import numpy as np
    import onnxruntime as rt
    import soundfile as sf
    from kokoro_onnx import Kokoro

    rt.disable_telemetry_events()
    options = rt.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = rt.InferenceSession(str(args.model), options, providers=["CPUExecutionProvider"])
    engine = Kokoro.from_session(session, str(args.voices))

    def silence(seconds: float):
        return np.zeros(round(seconds * SAMPLE_RATE), dtype=np.float32)

    parts = [silence(0.25)]
    offset = len(parts[0])
    timed_segments = []
    for index, segment in enumerate(segments):
        text = segment["text"]
        samples, sample_rate = engine.create(text, voice=VOICE, speed=SPEED, lang=LANGUAGE)
        samples = np.asarray(samples, dtype=np.float32)
        if (
            sample_rate != SAMPLE_RATE
            or samples.ndim != 1
            or samples.size <= SAMPLE_RATE
            or not np.isfinite(samples).all()
            or float(np.max(np.abs(samples))) <= 0.01
        ):
            raise ValueError(f"Unexpected or silent synthesis for {segment['id']}")
        timed_segments.append({
            "id": segment["id"],
            "text": text,
            "startSeconds": round(offset / SAMPLE_RATE, 6),
            "endSeconds": round((offset + len(samples)) / SAMPLE_RATE, 6),
            "durationSeconds": round(len(samples) / SAMPLE_RATE, 6),
            "startFrame": offset,
            "endFrame": offset + len(samples),
        })
        parts.append(samples)
        offset += len(samples)
        if index < len(segments) - 1:
            parts.append(silence(0.5))
            offset += len(parts[-1])
    parts.append(silence(0.25))
    audio = np.concatenate(parts)
    peak = float(np.max(np.abs(audio)))
    gain = min(1.0, 0.95 / peak)
    audio *= gain

    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    audio_path = OUTPUT_DIRECTORY / f"{SAMPLE_ID}.wav"
    sf.write(audio_path, audio, SAMPLE_RATE, subtype="PCM_16", format="WAV")
    written, written_rate = sf.read(audio_path, dtype="float32")
    if (
        written_rate != SAMPLE_RATE
        or written.ndim != 1
        or not np.isfinite(written).all()
        or float(np.max(np.abs(written))) <= 0.01
    ):
        raise ValueError("WAV round-trip verification failed.")

    dependencies = ["kokoro-onnx", "onnxruntime", "phonemizer", "espeakng-loader", "numpy", "soundfile"]
    provenance = {
        "schemaVersion": 1,
        "audioPath": audio_path.name,
        "sha256": sha256_file(audio_path),
        "durationSeconds": round(len(written) / SAMPLE_RATE, 6),
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "format": "PCM_16",
        "engine": "kokoro-onnx",
        "voice": VOICE,
        "language": LANGUAGE,
        "speed": SPEED,
        "generatedOn": datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat(),
        "syntheticSpeech": True,
        "textSource": "Project-authored AI-assisted fictional Section 4 lecture; not a released IELTS paper",
        "transcriptSha256": hashlib.sha256(" ".join(segment["text"] for segment in segments).encode("utf-8")).hexdigest(),
        "textPreprocessing": "Ten original lecture segments passed unchanged, synthesized separately without transcript rewriting.",
        "postprocessing": {"leadSilenceSeconds": 0.25, "gapSeconds": 0.5, "tailSilenceSeconds": 0.25, "gain": gain, "peakLimit": 0.95},
        "pythonVersion": platform.python_version(),
        "dependencyVersions": {name: metadata.version(name) for name in dependencies},
        "dependencySources": {name: f"https://pypi.org/project/{name}/{metadata.version(name)}/" for name in dependencies},
        "generatorPath": GENERATOR_PATH,
        "generatorSha256": sha256_file(Path(__file__)),
        "sources": [
            {"component": "kokoro-onnx", "url": "https://github.com/thewh1teagle/kokoro-onnx", "license": "MIT"},
            {"component": "Kokoro model and voice", "url": "https://huggingface.co/hexgrad/Kokoro-82M", "license": "Apache-2.0"},
            {"component": MODEL_NAME, "url": f"{RELEASE_URL}/{MODEL_NAME}", "sha256": MODEL_SHA256, "bytes": args.model.stat().st_size},
            {"component": VOICES_NAME, "url": f"{RELEASE_URL}/{VOICES_NAME}", "sha256": VOICES_SHA256, "bytes": args.voices.stat().st_size},
        ],
        "segments": timed_segments,
        "verification": {
            "checks": ["upstream asset SHA256 match", "finite non-silent synthesized speech", "mono 24000Hz PCM16 WAV round-trip", "exact frame-based segment timing"],
            "humanListeningReview": "pending",
        },
    }
    (OUTPUT_DIRECTORY / "provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    catalog = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))
    material = next(item for item in catalog["materials"] if item["id"] == SAMPLE_ID)
    # Prevent using this generator to hide an intervening transcript change.
    if material["segments"] != segments:
        raise ValueError("Sample text changed while audio was being generated; do not publish this output.")
    material["audio"]["durationSeconds"] = provenance["durationSeconds"]
    for question in material["questions"]:
        segment = next(segment for segment in timed_segments if segment["text"] == question["evidence"]["quote"])
        question["evidence"]["startSeconds"] = segment["startSeconds"]
        question["evidence"]["endSeconds"] = segment["endSeconds"]
    SAMPLES_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"audioPath": audio_path.name, "sha256": provenance["sha256"], "durationSeconds": provenance["durationSeconds"]}))


if __name__ == "__main__":
    main()
