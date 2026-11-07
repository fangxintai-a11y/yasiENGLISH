"""Build the attributed, text-only supplement without moving existing word IDs/chunks.

Input: the missing rows from qwerty-learner's IELTS_order, with original translations.
English/Chinese examples are extracted verbatim only when both halves can be parsed.
Missing images, recordings, examples and CEFR levels stay explicitly missing.
"""
import json
from pathlib import Path
import re
import hashlib

ROOT = Path(__file__).resolve().parents[2]
normal = lambda text: re.sub(r"[^a-z0-9]", "", text.lower())


def build():
    index = json.loads((ROOT / "public/atlas/index.json").read_text())
    source = json.loads((ROOT / "data/sources/qwerty-ielts-supplement.json").read_text())
    known = {normal(row[1]) for row in index["words"]}
    ids = {row[0] for row in index["words"]}
    examples = {}
    for line in (ROOT / "data/sources/gptwords.jsonl").read_text().splitlines():
        try:
            row = json.loads(line)
            examples[normal(row["word"])] = row["content"]
        except (ValueError, KeyError):
            continue
    entries = []
    for row in source["words"]:
        word = row["name"].strip()
        key = normal(word)
        if key in known or not re.fullmatch(r"[A-Za-z][A-Za-z0-9 ./’'\-]{0,79}", word):
            continue
        meanings = row["trans"] if isinstance(row["trans"], list) else [row["trans"]]
        meanings = [s.strip() for s in meanings if isinstance(s, str) and re.search(r"[\u4e00-\u9fff]", s)]
        if not meanings:
            continue
        known.add(key)
        slug = re.sub(r"[^a-z0-9]+", "-", word.lower()).strip("-")
        if slug in ids:
            slug += "-" + hashlib.sha1(word.encode()).hexdigest()[:6]
        ids.add(slug)
        pairs = []
        section = re.search(r"###\s*列举例句\s*(.*?)(?=\n###|\Z)", examples.get(key, ""), re.S)
        if section:
            for line in section.group(1).splitlines():
                line = re.sub(r"^\s*\d+[.)、]\s*", "", line).strip().replace("**", "")
                match = re.match(r'^["“]?(.*?)["”]?\s*[-—：:]\s*([\u4e00-\u9fff].*)$', line) or re.match(r"^(.*?)\s*[（(]([^()（）]*[\u4e00-\u9fff][^()（）]*)[）)]\s*$", line)
                if match:
                    en, zh = [s.strip(' "“”') for s in match.groups()]
                    if len(en) <= 400 and len(zh) <= 400 and key in normal(en) and re.search("[A-Za-z]", en):
                        pairs.append({"en": en, "zh": zh})
                if len(pairs) == 2:
                    break
        entries.append({"id": slug, "w": word, "uk": row.get("ukphone") or "", "us": row.get("usphone") or "",
                        "senses": [{"pos": "", "zh": s, "en": ""} for s in meanings[:3]], "ex": pairs,
                        "col": [], "fam": [], "syn": [], "ant": [], "tip": "", "cefr": "未分级", "topic": "unclassified",
                        "note": "补充词条；暂无插图和专用录音。未分级不代表难词。", "m": 0})
    (ROOT / "public/atlas/supplement.json").write_text(json.dumps({"metadata": source["metadata"], "entries": entries}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"base": index["count"], "supplement": len(entries), "total": index["count"] + len(entries), "withExamples": sum(bool(e["ex"]) for e in entries)}))


if __name__ == "__main__":
    build()
