"""Find look-alike headwords that learners mix up (adapt/adopt, affect/effect, quite/quiet, desert/dessert).

Two words are paired when one becomes the other through at most one or two "soft" edits: a vowel
for another vowel, c/s/x/z for each other, a doubled or dropped letter or vowel, or two letters
swapped. Other letter changes (hide/ride, loyal/royal) do not count, nor do inflections
(walk/walked), British and American spellings (organise/organize) or words under four letters.

Usage: python3 scripts/ielts/build_confusables.py
Writes public/ielts/confusables.json: {atlas id: [look-alike ids]}.
"""
import collections
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/ielts/confusables.json"
VOWELS = set("aeiouy")
SIBILANTS = set("csxz")
HARD = 10
SUFFIXES = ("s", "es", "ed", "d", "ing", "er", "ers", "est", "ly", "al", "ally", "ion", "ions", "ive", "ment", "ness", "y",
            "ity", "ize", "ise", "ous", "ful", "less", "able", "ible", "ance", "ence", "ant", "ent", "ist", "ism", "ic", "ical")
# British -> American, applied to both words: pairs that become equal are spelling variants.
VARIANTS = [(r"isation", "ization"), (r"is(e|ed|es|ing|er)$", r"iz\1"), (r"our", "or"), (r"ll", "l"), (r"tre$", "ter"),
            (r"yre$", "ire"), (r"ae", "e"), (r"ogue$", "og"), (r"ence$", "ense")]


def soft_cost(a: str, b: str) -> int:
    """Edit cost where soft edits cost 1 and any other edit costs HARD."""
    n, m = len(a), len(b)
    INF = 99
    d = [[INF] * (m + 1) for _ in range(n + 1)]
    d[0][0] = 0
    for i in range(n + 1):
        for j in range(m + 1):
            if not i and not j:
                continue
            best = INF
            if i and j:
                x, y = a[i - 1], b[j - 1]
                c = 0 if x == y else 1 if (x in VOWELS and y in VOWELS) or (x in SIBILANTS and y in SIBILANTS) else HARD
                best = d[i - 1][j - 1] + c
            if i:
                x = a[i - 1]
                c = 1 if x in VOWELS or (i > 1 and a[i - 2] == x) or (i < n and a[i] == x) else HARD
                best = min(best, d[i - 1][j] + c)
            if j:
                y = b[j - 1]
                c = 1 if y in VOWELS or (j > 1 and b[j - 2] == y) or (j < m and b[j] == y) else HARD
                best = min(best, d[i][j - 1] + c)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1] and a[i - 1] != a[i - 2]:
                best = min(best, d[i - 2][j - 2] + 1)
            d[i][j] = best
    return d[n][m]


def inflected(a: str, b: str) -> bool:
    """One word is the other plus a suffix (walk/walked, make/making, happy/happily)."""
    s, l = sorted((a, b), key=len)
    if l.startswith(s) and l[len(s):] in SUFFIXES:
        return True
    if s.endswith("e") and l.startswith(s[:-1]) and l[len(s) - 1:] in SUFFIXES:
        return True
    return s.endswith("y") and l.startswith(s[:-1]) and l[len(s) - 1:] in ("ies", "ied", "ily", "iness", "ier", "iest")


def variant(a: str, b: str) -> bool:
    def us(w):
        for pat, rep in VARIANTS:
            w = re.sub(pat, rep, w)
        return w
    return us(a) == us(b)


def main():
    atlas = json.loads((ROOT / "data/word-atlas.json").read_text(encoding="utf-8"))
    words = [(w["id"], w["w"]) for w in atlas if re.fullmatch(r"[a-z]{4,}", w["w"])]
    by_len = collections.defaultdict(list)
    for i, w in words:
        by_len[len(w)].append((i, w))
    out = collections.defaultdict(list)
    pairs = 0
    for i, a in words:
        for n in (len(a), len(a) + 1):
            for j, b in by_len[n]:
                if n == len(a) and j <= i:
                    continue
                if a[0] != b[0] and not (a[0] in VOWELS and b[0] in VOWELS):
                    continue
                # Short words differ by one soft edit at most, or the pairs get silly (hall/hull).
                if soft_cost(a, b) <= (1 if min(len(a), len(b)) <= 5 else 2) and not inflected(a, b) and not variant(a, b):
                    out[i].append(j)
                    out[j].append(i)
                    pairs += 1
    OUT.write_text(json.dumps({k: sorted(v) for k, v in sorted(out.items())}, separators=(",", ":")), encoding="utf-8")
    print(f"{pairs} look-alike pairs over {len(out)} words -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
