"""Split every headword into spoken syllables, written with its own letters (en·vi·ron·ment).

Hyphenation patterns break words where a printer may, not where a speaker does
(they give "en·vi·ron·men·t", "veg·etable"). So the split here starts from the
pronunciation: the CMU Pronouncing Dictionary gives the phonemes, they are grouped into
syllables (maximal onset, a stressed short vowel keeps the next consonant: lem·on,
prob·lem), the phonemes are aligned to the letters, and the cut is made between the
letters of neighbouring syllables (double letters split in the middle: rab·bit).

Usage: python3 scripts/ielts/build_syllables.py [--cmudict path/to/cmudict.dict]
  With --cmudict the full dictionary is read and the entries the atlas needs are saved to
  data/sources/cmudict-atlas.txt; without it that saved subset is used.
Writes public/ielts/syl.json: {atlas id: "en·vi·ron·ment"} for words of two or more syllables.
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUBSET = ROOT / "data/sources/cmudict-atlas.txt"
OUT = ROOT / "public/ielts/syl.json"
DOT = "·"

VOWELS = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
LAX = {"AE", "EH", "IH", "AH", "UH"}
ONSETS = {tuple(o.split()) for o in """
P R|P L|B R|B L|T R|D R|K R|K L|G R|G L|F R|F L|TH R|SH R|S P|S T|S K|S M|S N|S L|S W|T W|K W|G W|
P Y|B Y|F Y|V Y|M Y|K Y|HH Y|S P R|S P L|S T R|S K R|S K W|S K Y|S P Y""".replace("\n", "").split("|") if o.strip()}

# Spellings each phoneme (or phoneme pair) can come from. Generous on purpose: the cost
# of a wrong guess is a slightly odd cut, the cost of a missing one is no cut at all.
G2P = {
    "AA": "a o ah al au aw ea ho ou oi",
    "AE": "a ai au",
    "AH": "u o a e i ou oo oe y io ai ea eo ia iou",
    "AO": "o a au aw ou oa augh ough al oo ar or",
    "AW": "ou ow au ough",
    "AY": "i y ie igh ai ei eye uy ye is ia ui",
    "EH": "e ea a ai ie ay ei eo u ae",
    "ER": "er ir ur ear or our ar yr ere re err irr urr eur r ure",
    "EY": "a ai ay ei ey ea eigh aigh e et ae au",
    "IH": "i y e ee ie a u o ui ea ei ia",
    "IY": "e ee ea ie ei y i ey eo ae oe ay",
    "OW": "o oa ow oe ou ough eau ew au oo",
    "OY": "oi oy uoy",
    "UH": "u oo o ou oul",
    "UW": "u oo o ue ew ou ui oe ough eu wo",
    "B": "b bb bu",
    "CH": "ch tch t c ti cz",
    "D": "d dd ed",
    "DH": "th",
    "F": "f ff ph gh pph",
    "G": "g gg gh gu",
    "HH": "h wh j",
    "JH": "j g dg gi gg d di",
    "K": "k c ck ch cc q qu kk cq cqu",
    "L": "l ll",
    "M": "m mm mb mn lm gm",
    "N": "n nn kn gn pn mn",
    "NG": "ng n",
    "P": "p pp",
    "R": "r rr wr rh",
    "S": "s ss c sc ps z",
    "SH": "sh ti ci si ssi sci ch s ss xi sch",
    "T": "t tt ed th pt",
    "TH": "th",
    "V": "v f ph vv",
    "W": "w wh u o",
    "Y": "y i j",
    "Z": "z zz s ss x cz",
    "ZH": "s si g z ti j",
    ("Y", "UW"): "u ue ew eu iew eau ieu you",
    ("Y", "UH"): "u eu",
    ("Y", "ER"): "ur ure",
    ("Y", "AH"): "u",
    ("K", "S"): "x xc cc xs",
    ("G", "Z"): "x xh",
    ("K", "SH"): "x xi",
    ("K", "W"): "qu q cqu",
    ("G", "W"): "gu",
    ("W", "AH"): "o",
    ("AH", "L"): "le",
    ("ER", "R"): "err urr er ir ur or ar our",
    ("T", "S"): "z zz ts tz",
    ("G", "ZH"): "x",
    ("SH", "IY"): "ti ci si",
    ("SH", "IH"): "ti ci",
    ("CH", "UW"): "tu",
    ("JH", "UW"): "du",
    ("CH", "AH", "W"): "tu",
    ("JH", "AH", "W"): "du",
    ("ZH", "AH", "W"): "su",
    ("SH", "AH", "W"): "su",
    ("CH", "ER"): "tur ture",
    ("ZH", "ER"): "sur sure",
    ("SH", "ER"): "sur sure",
}
G2P = {k: set(v.split()) for k, v in G2P.items()}
DOUBLES = {c * 2 for c in "bcdfgklmnprstvz"}


def phones_of(line):
    word, *ph = line.split()
    return re.sub(r"\(\d+\)$", "", word), ph


def load_cmu(path: Path):
    cmu = {}
    for line in path.read_text(encoding="latin-1").splitlines():
        if line.strip() and not line.startswith(";;;"):
            line = line.split("#")[0]
            w, ph = phones_of(line)
            cmu.setdefault(w.lower(), []).append(ph)
    return cmu


def nucleus(p):
    return p.rstrip("012") in VOWELS


def syllabify(ph, spans, low):
    """Start index of each syllable: maximal onset, then a stressed short vowel keeps one consonant."""
    def own_syllable(i):
        if spans[i][0] == spans[i][1]:  # a schwa the spelling does not show (-ism, rhythm)
            return False
        # The r-colouring of fire, tire, hour is not a syllable of its own in the spelling.
        return not (ph[i].startswith("ER") and i and ph[i - 1].rstrip("012") in ("AY", "AW", "OY")
                    and low[spans[i][0]] == "r")

    vi = [i for i, p in enumerate(ph) if nucleus(p) and own_syllable(i)]
    if not vi:
        return []

    def short(i):
        b = ph[i].rstrip("012")
        if ph[i][-1] not in "12":
            return False
        if b in LAX:
            return True
        # Spelt "o" before a consonant other than r, AA/AO is the British short o (prob·lem, knowl·edge).
        g = low[spans[i][0]:spans[i][1]]
        return b in ("AA", "AO") and g == "o" and i + 1 < len(ph) and ph[i + 1] != "R"

    def lax(i):
        return short(i) or (ph[i].rstrip("012") in LAX and ph[i][-1] == "0")

    starts = [0]
    for a, b in zip(vi, vi[1:]):
        cons = [p.rstrip("012") for p in ph[a + 1:b]]
        k = len(cons)

        def joined(k):  # an onset cannot straddle a silent letter (shape·less, not sha·peless)
            return all(spans[q][1] == spans[q + 1][0] for q in range(b - k, b - 1))

        while k > 1 and (tuple(cons[len(cons) - k:]) not in ONSETS or not joined(k)):
            k -= 1
        if k == 1 and cons and cons[-1] == "NG":
            k = 0
        cut = b - k
        # A consonant written together with the next vowel (the t of "tu" in ac·tu·al) cannot move.
        # Nor can one whose letters include a vowel (the ci of spe·cial).
        fused = cut < b and (spans[cut] == spans[cut + 1] or re.search(r"[aeiouy]", low[spans[cut][0]:spans[cut][1]]))
        if not fused and cut < b and cut == a + 1 and short(a):
            cut += 1
        # s + stop after a short vowel splits: sus·tain, mis·take, in·ter·est·ing.
        elif not fused and cut == a + 1 and cut < b - 1 and cons[0] == "S" and not (a == vi[0] and re.match(r"[^aeiou]+e$", low[:spans[a][1]])) and ph[cut + 1].rstrip("012") in ("P", "T", "K") and lax(a):
            cut += 1
        starts.append(cut)
    return starts


def align(letters, ph):
    """Map each phoneme to a [start, end) letter span; None if the spelling cannot be matched."""
    base = [p.rstrip("012") for p in ph]
    n, m = len(letters), len(ph)
    INF = 10 ** 9
    dp = [[INF] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0
    for i in range(n + 1):
        for j in range(m + 1):
            c = dp[i][j]
            if c >= INF:
                continue
            if i < n:  # a silent letter
                ch = letters[i]
                cost = 1 if ch == "e" else 2 if ch in "aiouhwy" else 3
                if c + cost < dp[i + 1][j]:
                    dp[i + 1][j], back[i + 1][j] = c + cost, (i, j, None)
            if j < m and base[j] in ("AH", "IH") and ph[j][-1] == "0":  # an inserted schwa
                if c + 2 < dp[i][j + 1]:
                    dp[i][j + 1], back[i][j + 1] = c + 2, (i, j, (i, i))
            for span in (1, 2, 3):
                if j + span > m:
                    continue
                key = base[j] if span == 1 else tuple(base[j:j + span])
                if key not in G2P:
                    continue
                for k in range(1, 5):
                    if i + k <= n and letters[i:i + k] in G2P[key]:
                        cost = c + (0 if span == 1 else 0.5)
                        if cost < dp[i + k][j + span]:
                            dp[i + k][j + span], back[i + k][j + span] = cost, (i, j, (i, i + k))
    if dp[n][m] >= INF or dp[n][m] > 3 + n // 3:
        return None
    spans = [None] * m
    i, j = n, m
    while (i, j) != (0, 0):
        pi, pj, sp = back[i][j]
        if sp is not None:
            for q in range(pj, j):
                spans[q] = sp
        i, j = pi, pj
    return spans


def cut_letters(low, ph, spans, starts):
    """Letter positions between syllables, or None when the cut would leave a part without a vowel."""
    cuts = []
    for s in starts[1:]:
        prev = next((spans[q] for q in range(s - 1, -1, -1) if spans[q][1] > spans[q][0]), (0, 0))
        nxt = next((spans[q] for q in range(s, len(ph)) if spans[q][1] > spans[q][0]), None)
        if nxt is None:
            return None
        if prev == nxt:  # one grapheme for both sides (x in tax·i, tu in ac·tu·al): cut after it
            seg = low[nxt[0]:nxt[1]]
            cuts.append(nxt[0] + 1 if seg in DOUBLES | {"xc"} else nxt[1])  # piz·za, ex·cess
            continue
        # Silent letters in between: a silent vowel stays with what came before (some·thing,
        # busi·ness), silent consonants go with what follows (of·ten, de·sign).
        gap = list(range(prev[1], nxt[0]))
        while gap and low[gap[0]] in "aeiouy":
            gap.pop(0)
        cut = gap[0] if gap else nxt[0]
        seg_prev, seg_next = low[prev[0]:prev[1]], low[nxt[0]:nxt[1]]
        # Double letters split in the middle (rab·bit, ac·cept); "ck" and "x" stay behind (pock·et).
        if cut == nxt[0] and seg_next[:2] in DOUBLES:
            cut += 1
        elif cut == prev[1] and not gap and seg_prev[-2:] in DOUBLES | {"sc"} and low[nxt[0]] in "aeiouylr":
            cut -= 1
        elif seg_next in ("ck", "x"):
            cut = nxt[1]
        cuts.append(cut)
    if re.search(r"[^aeiouy]le$", low) and not low.endswith("ckle") and cuts and cuts[-1] == len(low) - 2:
        cuts[-1] -= 1
    if cuts != sorted(set(cuts)) or cuts[0] <= 0 or cuts[-1] >= len(low):
        return None
    parts = [low[a:b] for a, b in zip([0] + cuts, cuts + [len(low)])]
    if not all(re.search(r"[aeiouy]", p) for p in parts):
        return None
    return cuts


# Suffix -> shortest stem it is trusted after ("corn·er" and "numb·er" are not wanted).
SUFFIXES = {"ing": 3, "able": 3, "ible": 3, "est": 3, "ed": 3, "er": 5, "ous": 5,
            "less": 3, "ness": 3, "ment": 3, "ful": 3, "ly": 3, "ship": 3}


def stems(w):
    """Possible stems of a suffixed word (interest·ing, sus·tain·a·ble, mak·ing, help·less)."""
    return [(w[:-len(x)], w[:-len(x)] + e) for x, n in SUFFIXES.items() if w.endswith(x) and len(w) - len(x) >= n
            for e in ("", "e")]


def keep_stem(low, cuts, cmu):
    """Move a cut that falls just inside a known stem to the stem's end: in·ter·es·ting -> in·ter·est·ing."""
    for stem, word in stems(low):
        st = len(stem)
        # Not after a doubled consonant (stir·ring) or a dropped syllabic -le (smug·gling).
        if word not in cmu or stem[-1] in "aeiouy" or stem[-1] == stem[-2] or re.search(r"[^aeiouy]le$", word):
            continue
        vowel_suffix = low[st] in "aeiouy"
        for i, c in enumerate(cuts):
            # Before a vowel suffix the cut sits inside the stem (in·ter·es|ting); before a
            # consonant suffix the stem's last consonants went to the suffix (hel|pless).
            near = st - 2 <= c < st if vowel_suffix else st - 2 <= c <= st + 1
            if near and c != st and not re.search(r"[aeiouy]", low[min(c, st):max(c, st)]) and \
                    (i == 0 or cuts[i - 1] < st) and (i + 1 == len(cuts) or cuts[i + 1] > st):
                cuts = cuts[:i] + [st] + cuts[i + 1:]
                break
        break
    return cuts


PREFIXES = ("dis", "mis", "un", "in", "im", "non", "sub", "over", "under", "out", "inter", "super")


def keep_prefix(low, cuts, cmu):
    """Cut right after a prefix whose remainder is a word: dis·a·gree, un·a·ble, not di·sa·gree, u·na·ble."""
    for pre in PREFIXES:
        p = len(pre)
        if low.startswith(pre) and len(low) - p >= 3 and low[p:] in cmu:
            for i, c in enumerate(cuts):
                if abs(c - p) == 1 and (i == 0 or cuts[i - 1] < p) and (i + 1 == len(cuts) or cuts[i + 1] > p):
                    return cuts[:i] + [p] + cuts[i + 1:]
            break
    return cuts


STRESS = "ˈ"


def ipa_stress(ipa):
    """Index of the stressed syllable in a /.../ transcription (vowel runs before ˈ), or None."""
    if not ipa or "ˈ" not in ipa:
        return None
    return len(re.findall(r"[aeiouæɑɒɔəɜɪʊʌɛɐ]+", ipa.split("ˈ")[0]))


def cmu_stress(ph):
    first = next((j for j, x in enumerate(ph) if x.endswith("1")), None)
    return None if first is None else sum(nucleus(x) for x in ph[:first])


def split_word(word, prons, cmu=None, stress=None, ipa_count=None):
    """Best syllable split of one alphabetic word: list of parts, the stressed one marked ˈ, or None.

    `stress` is the stressed syllable from the atlas transcription (British first): it picks
    between the noun and the verb of ˈrec·ord / re·ˈcord."""
    low = word.lower()
    # The fullest pronunciation maps best onto the spelling (com·for·ta·ble, gov·ern·ment).
    for ph in sorted(prons, key=lambda p: (cmu_stress(p) != stress, -sum(nucleus(x) for x in p), -len(p))):
        if sum(nucleus(x) for x in ph) < 2:
            return [word] if any(nucleus(x) for x in ph) else None
        spans = align(low, ph)
        if not spans:
            continue
        starts = syllabify(ph, spans, low)
        if len(starts) == 1:
            return [word]
        cuts = cut_letters(low, ph, spans, starts) if starts else None
        if cuts and cmu:
            cuts = keep_prefix(low, keep_stem(low, cuts, cmu), cmu)
        if cuts:
            parts = [word[a:b] for a, b in zip([0] + cuts, cuts + [len(word)])]
            primary = next((j for j, x in enumerate(ph) if x.endswith("1")), None)
            if stress is not None and stress < len(parts) and ipa_count == len(parts):
                parts[stress] = STRESS + parts[stress]  # the British stress (ˈgar·age)
            elif primary is not None:
                k = max(i for i, st in enumerate(starts) if st <= primary)
                parts[k] = STRESS + parts[k]
            return parts
    return None


US = [(r"our$", "or"), (r"our(s|ed|ing|ite|able|ful|less)$", r"or\1"), (r"tre$", "ter"), (r"tres$", "ters"),
      (r"is(e|ed|es|ing|ation|ations|er|ers)$", r"iz\1"), (r"ys(e|ed|es|ing)$", r"yz\1"), (r"ogue$", "og"),
      (r"ll(ed|ing|er|ers)$", r"l\1"), (r"ence$", "ense"), (r"ae", "e"), (r"oe", "e"), (r"mme$", "m"),
      (r"([bt])re$", r"\1er"), (r"([bt])res$", r"\1ers"), (r"rol$", "roll"), (r"lli$", "li"), (r"^sc", "sk"), (r"yjam", "ajam")]


def halves(w):
    """Ways to read an unknown word as a compound of two (notice|board, tooth|ache)."""
    return [(w[:i], w[i:]) for i in range(len(w) - 3, 2, -1)]


def pronunciations(word, cmu):
    w = word.lower()
    if w in cmu:
        return cmu[w]
    for pat, rep in US:
        alt = re.sub(pat, rep, w)
        if alt != w and alt in cmu:
            return cmu[alt]
    return None


def split_token(word, cmu, stress=None, ipa_count=None):
    prons = pronunciations(word, cmu)
    if prons:
        return split_word(word, prons, cmu, stress, ipa_count)
    for a, b in halves(word):
        pa, pb = pronunciations(a, cmu), pronunciations(b, cmu)
        if pa and pb:
            sa, sb = split_word(a, pa), split_word(b, pb)
            if sa and sb:
                # Compounds take the stress on their first half (ˈtooth·ache).
                sa = [x.lstrip(STRESS) for x in sa]
                return [STRESS + sa[0]] + sa[1:] + [x.lstrip(STRESS) for x in sb]
    return None


def split_headword(head, cmu, ipa=None):
    """Split each word of a headword; separators (space, hyphen) are kept."""
    pieces = re.split(r"([ \-'’/.]+)", head)
    ipa = (ipa or "").split(";")[0]
    stress = ipa_stress(ipa) if len(pieces) == 1 else None
    count = len(re.findall(r"[aeiouæɑɒɔəɜɪʊʌɛɐ]+", ipa)) if stress is not None else None
    out, multi = [], False
    for p in pieces:
        if not p or not p.isalpha():
            out.append(p)
            continue
        parts = split_token(p, cmu, stress, count)
        if not parts:
            return None
        multi |= len(parts) > 1
        out.append(DOT.join(parts))
    return "".join(out) if multi else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmudict")
    ap.add_argument("--report", action="store_true", help="print words that could not be split")
    a = ap.parse_args()
    words = json.loads((ROOT / "data/word-atlas.json").read_text(encoding="utf-8"))
    tokens = {t.lower() for w in words for t in re.split(r"[ \-'’/.]+", w["w"]) if t.isalpha()}
    if a.cmudict:
        cmu = load_cmu(Path(a.cmudict))
        need = set()
        for t in tokens:
            for w in [t] + [x for _, x in stems(t)] + [t[len(x):] for x in PREFIXES if t.startswith(x)] + ([x for h in halves(t) for x in h] if t not in cmu else []):
                need.add(w)
                need.update(re.sub(pat, rep, w) for pat, rep in US)
        keep = {w: v for w, v in cmu.items() if w in need}
        lines = [f"{w}{'' if i == 0 else f'({i + 1})'} {' '.join(ph)}" for w in sorted(keep) for i, ph in enumerate(keep[w])]
        SUBSET.write_text(";;; Subset of the CMU Pronouncing Dictionary (cmusphinx/cmudict) for the atlas headwords.\n"
                          ";;; Copyright (C) 1993-2015 Carnegie Mellon University. BSD 2-Clause, see cmudict.LICENSE.\n"
                          + "\n".join(lines) + "\n", encoding="latin-1")
    cmu = load_cmu(SUBSET)
    out, missed, single = {}, [], 0
    for w in words:
        s = split_headword(w["w"], cmu, w.get("uk") or w.get("us"))
        if s:
            out[w["id"]] = s
        else:
            toks = [t for t in re.split(r"[ \-'’/.]+", w["w"]) if t.isalpha()]
            if toks and all(split_token(t, cmu) and len(split_token(t, cmu)) == 1 for t in toks):
                single += 1
            else:
                missed.append(w["w"])
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} split, {single} single-syllable, {len(missed)} not split -> {OUT.relative_to(ROOT)}")
    if a.report:
        print(" ".join(missed))


if __name__ == "__main__":
    main()
