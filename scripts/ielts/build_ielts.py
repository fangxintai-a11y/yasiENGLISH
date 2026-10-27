"""Build the IELTS layer that sits on top of the Word Atlas data.

Outputs (all served statically):
  public/ielts/tags.json        listening words (王陆语料库), AWL sublists, synonym graph
  public/ielts/mnemo/<n>.json   roots / memory tips / stories from DictionaryByGPT4, chunked like atlas entries

Usage: python3 -I scripts/ielts/build_ielts.py
"""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "sources"
OUT = ROOT / "public" / "ielts"

ATLAS = json.loads((ROOT / "data" / "word-atlas.json").read_text(encoding="utf-8"))
INDEX = json.loads((ROOT / "public" / "atlas" / "index.json").read_text(encoding="utf-8"))
ORDER = {row[0]: i for i, row in enumerate(INDEX["words"])}
BY_WORD = {w["w"].lower(): w["id"] for w in ATLAS}


def to_id(token: str) -> str | None:
    """Exact headword first, then a few safe inflection strips."""
    t = token.strip().lower()
    if t in BY_WORD:
        return BY_WORD[t]
    for suf, rep in (("ies", "y"), ("ves", "f"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("ing", ""), ("ing", "e")):
        if t.endswith(suf):
            base = t[: -len(suf)] + rep
            if len(base) >= 3 and base in BY_WORD:
                return BY_WORD[base]
    return None


def listening():
    rows = list(csv.reader((SRC / "wanglu-listening.csv").open(encoding="utf-8")))
    header = rows[0]
    words: dict[str, str] = {}
    phrases: list[list[str]] = []
    for row in rows[3:]:
        for i, cell in enumerate(row):
            item = cell.strip()
            chapter = header[i].strip() if i < len(header) else ""
            if not item or not chapter:
                continue
            item = item.split("=")[0].strip()
            wid = to_id(item) if re.fullmatch(r"[A-Za-z'-]+", item) else None
            if wid:
                words.setdefault(wid, chapter)
            else:
                phrases.append([item, chapter])
    seen = set()
    uniq = []
    for p in phrases:
        key = p[0].lower()
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return words, uniq


def awl():
    out: dict[str, int] = {}
    sub = 0
    for line in (SRC / "awl-sublists.txt").read_text(encoding="utf-8").splitlines():
        m = re.match(r"Sublist (\d+) of the Academic Word List", line)
        if m:
            sub = int(m.group(1))
            continue
        word = line.strip().lower()
        if not sub or not re.fullmatch(r"[a-z-]+", word):
            continue
        wid = BY_WORD.get(word)
        if wid and wid not in out:
            out[wid] = sub
    return out


def synonyms():
    graph: dict[str, set[str]] = {}
    for w in ATLAS:
        for s in w.get("syn", []):
            other = BY_WORD.get(s.strip().lower())
            if other and other != w["id"]:
                graph.setdefault(w["id"], set()).add(other)
                graph.setdefault(other, set()).add(w["id"])
    return {k: sorted(v, key=lambda x: ORDER.get(x, 0)) for k, v in sorted(graph.items())}


SECTION_KEYS = {
    "root": ["词根分析", "词根词缀分析", "词根和词缀分析", "词根分析和词缀分析", "词根与词缀分析", "词根词缀"],
    "affix": ["词缀分析"],
    "history": ["发展历史和文化背景", "开发历史和文化背景", "发展历史与文化背景", "历史和文化背景", "文化背景"],
    "memory": ["记忆辅助"],
    "story": ["小故事"],
}
OTHER_HEADS = ["分析词义", "列举例句", "单词变形", "例句", "词义分析", "固定搭配", "单词分析", "单词变形和固定搭配", "小故事翻译", "小故事的中文翻译", "中文翻译", "举例", "例句列举"]
ALL_HEADS = sorted({h for hs in SECTION_KEYS.values() for h in hs} | set(OTHER_HEADS), key=len, reverse=True)
HEAD_RE = re.compile(r"^\s*(?:#+\s*)?(" + "|".join(map(re.escape, ALL_HEADS)) + r")\s*[:：]?\s*(.*)$")
EMPTY = re.compile(r"^(无|没有|不适用|N/?A)[。.，,]?$")


def clean(text: str) -> str:
    text = text.replace("\u00a0", " ").replace("**", "").replace("__", "")
    # Markdown list bullets ("* ", "- ") read as noise in the app; numbered lists stay.
    lines = [re.sub(r"^[*\-•]\s+", "", ln.strip()) for ln in text.splitlines()]
    out: list[str] = []
    blank = False
    for ln in lines:
        if not ln:
            blank = bool(out)
            continue
        if blank:
            out.append("")
            blank = False
        out.append(ln)
    return "\n".join(out).strip()


def sections(content: str) -> dict[str, str]:
    found: dict[str, list[str]] = {}
    current = None
    for line in content.splitlines():
        m = HEAD_RE.match(line)
        if m:
            current = m.group(1)
            found.setdefault(current, [])
            if m.group(2).strip():
                found[current].append(m.group(2))
            continue
        if current:
            found[current].append(line)
    return {k: clean("\n".join(v)) for k, v in found.items()}


def mnemonics():
    result: dict[str, dict[str, str]] = {}
    for line in (SRC / "gptwords.jsonl").open(encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        wid = BY_WORD.get(item["word"].strip().lower())
        if not wid:
            continue
        secs = sections(item["content"])
        entry: dict[str, str] = {}
        for field, heads in SECTION_KEYS.items():
            for h in heads:
                text = secs.get(h, "")
                if text and not EMPTY.match(text):
                    entry[field] = text[:700]
                    break
        translation = secs.get("小故事翻译") or secs.get("小故事的中文翻译")
        if entry.get("story") and translation:
            entry["story"] += "\n" + translation[:300]
        if entry:
            result[wid] = entry
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    listen_words, phrases = listening()
    tags = {
        "version": 1,
        "sources": {
            "listening": "雅思王听力语料库（王陆），via github.com/daddywolf/IELTS-Listening-Vocabulary-and-Collocation",
            "awl": "Coxhead Academic Word List (2000)",
            "syn": "Word Atlas syn field, matched within the atlas",
            "mnemo": "DictionaryByGPT4 (CC BY-SA 4.0), github.com/Ceelog/DictionaryByGPT4",
        },
        "listening": listen_words,
        "phrases": phrases,
        "awl": awl(),
        "syn": synonyms(),
    }
    (OUT / "tags.json").write_text(json.dumps(tags, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    mn = mnemonics()
    chunk = INDEX["chunk"]
    buckets: dict[int, dict] = {}
    for wid, entry in mn.items():
        buckets.setdefault(ORDER[wid] // chunk, {})[wid] = entry
    mdir = OUT / "mnemo"
    mdir.mkdir(exist_ok=True)
    for old in mdir.glob("*.json"):
        old.unlink()
    for n in range(-(-len(ORDER) // chunk)):
        (mdir / f"{n}.json").write_text(json.dumps(buckets.get(n, {}), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"listening {len(listen_words)} words + {len(phrases)} phrases · awl {len(tags['awl'])} · "
        f"syn {len(tags['syn'])} words · mnemonics {len(mn)}"
    )


if __name__ == "__main__":
    main()
