"""Set the example-sentence media bits from the recordings that exist (run after gen_sentence_audio_kokoro.py).

Bit 8 = public/atlas/audio/say/<id>.mp3 (everyday sentence), bit 16 = say2/<id>.mp3 (IELTS context).
Updates public/atlas/index.json and public/atlas/entries/*.json in place.
"""
import json
from pathlib import Path

ATLAS = Path(__file__).resolve().parents[2] / "public/atlas"
BITS = {8: ATLAS / "audio/say", 16: ATLAS / "audio/say2"}


def media(word_id: str, m: int) -> int:
    for bit, folder in BITS.items():
        m = m | bit if (folder / f"{word_id}.mp3").exists() else m & ~bit
    return m


def dump(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    index = json.loads((ATLAS / "index.json").read_text(encoding="utf-8"))
    for row in index["words"]:
        row[6] = media(row[0], row[6])
    dump(ATLAS / "index.json", index)
    for n in range((index["count"] + index["chunk"] - 1) // index["chunk"]):
        path = ATLAS / f"entries/{n}.json"
        chunk = json.loads(path.read_text(encoding="utf-8"))
        for e in chunk:
            e["m"] = media(e["id"], e["m"])
        dump(path, chunk)
    counts = {bit: sum(1 for r in index["words"] if r[6] & bit) for bit in BITS}
    print(f"everyday sentences voiced: {counts[8]}, IELTS-context sentences voiced: {counts[16]} of {index['count']}")


if __name__ == "__main__":
    main()
