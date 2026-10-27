import { irregularBase } from "../lib/text";
import { recallAt, type CardState } from "../store/srs";

/**
 * Paste any English text (a Cambridge passage, an article) and see which words in it you have
 * not learned yet. Matching is headword-first with light, safe lemmatisation.
 */

export interface WordLike {
  id: string;
  word: string;
  cefr: number;
}

const STOP = new Set(
  "a an the and or but if of to in on at by for with from as is are was were be been being am do does did have has had i you he she it we they me him her us them my your his its our their this that these those there here what which who whom whose when where why how not no yes so than then too very can could will would shall should may might must just also only".split(
    " ",
  ),
);

export function lookupIndex(words: WordLike[]) {
  const m = new Map<string, WordLike>();
  for (const w of words) if (!/\s/.test(w.word)) m.set(w.word.toLowerCase(), w);
  return m;
}

/** Candidate base forms for an inflected token, most likely first. */
export function baseForms(token: string) {
  const t = token.toLowerCase();
  const out = [t];
  const irr = irregularBase(t);
  if (irr) out.push(irr);
  const add = (s: string) => s.length >= 2 && out.push(s);
  if (t.endsWith("ies")) add(t.slice(0, -3) + "y");
  if (t.endsWith("ves")) add(t.slice(0, -3) + "f"), add(t.slice(0, -3) + "fe");
  if (t.endsWith("es")) add(t.slice(0, -2));
  if (t.endsWith("s") && !t.endsWith("ss")) add(t.slice(0, -1));
  if (t.endsWith("ied")) add(t.slice(0, -3) + "y");
  if (t.endsWith("ed")) {
    add(t.slice(0, -2));
    add(t.slice(0, -1));
    if (/([bdgklmnprt])\1ed$/.test(t)) add(t.slice(0, -3));
  }
  if (t.endsWith("ing")) {
    add(t.slice(0, -3));
    add(t.slice(0, -3) + "e");
    if (/([bdgklmnprt])\1ing$/.test(t)) add(t.slice(0, -4));
  }
  if (t.endsWith("ier")) add(t.slice(0, -3) + "y");
  if (t.endsWith("iest")) add(t.slice(0, -4) + "y");
  if (t.endsWith("er")) add(t.slice(0, -2)), add(t.slice(0, -1));
  if (t.endsWith("est")) add(t.slice(0, -3)), add(t.slice(0, -2));
  if (t.endsWith("ily")) add(t.slice(0, -3) + "y");
  if (t.endsWith("ly")) add(t.slice(0, -2));
  return out;
}

export interface TextReport {
  tokens: number;
  /** Atlas words found, with how often they occur. */
  found: { word: WordLike; count: number; status: "new" | "weak" | "known" }[];
  /** Share of content-word tokens the learner already recalls well. */
  coverage: number;
  /** Tokens not in the atlas (names, rare words), most frequent first. */
  outside: string[];
}

export function analyzeText(text: string, index: Map<string, WordLike>, cards: Record<string, CardState>, now: number, retention = 0.9): TextReport {
  const raw = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  const counts = new Map<string, { word: WordLike; count: number }>();
  const outside = new Map<string, number>();
  let content = 0;
  let knownTokens = 0;
  for (const tok of raw) {
    const t = tok.replace(/['’]s$/i, "");
    if (STOP.has(t.toLowerCase()) || t.length < 2) continue;
    content++;
    let hit: WordLike | undefined;
    for (const b of baseForms(t)) {
      hit = index.get(b);
      if (hit) break;
    }
    if (!hit) {
      const k = t.toLowerCase();
      outside.set(k, (outside.get(k) ?? 0) + 1);
      continue;
    }
    const e = counts.get(hit.id) ?? { word: hit, count: 0 };
    e.count++;
    counts.set(hit.id, e);
    const c = cards[hit.id];
    if (c && recallAt(c, now) >= retention) knownTokens++;
  }
  const found = [...counts.values()]
    .map(({ word, count }) => {
      const c = cards[word.id];
      const status: "new" | "weak" | "known" = !c ? "new" : recallAt(c, now) >= retention ? "known" : "weak";
      return { word, count, status };
    })
    .sort((a, b) => (a.status === b.status ? b.word.cefr - a.word.cefr || b.count - a.count : a.status === "new" ? -1 : b.status === "new" ? 1 : a.status === "weak" ? -1 : 1));
  return {
    tokens: raw.length,
    found,
    coverage: content ? knownTokens / content : 0,
    outside: [...outside.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([w]) => w),
  };
}
