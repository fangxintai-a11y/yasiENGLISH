/* 跟读 (shadowing): which sentences to practise, how a recording lines up with the text, and how close
   a spoken attempt was. Pure functions, so node:test can drive them. */

import type { CardState } from "../store/srs";

export const DAY = 864e5;

/** Example 0 is the everyday sentence, 1 the IELTS-context one. */
export type SentenceRef = { id: string; i: 0 | 1 };

export const sentenceKey = ({ id, i }: SentenceRef) => `${id}:${i}`;
export function parseSentenceKey(key: string): SentenceRef | null {
  const m = /^(.+):([01])$/.exec(key);
  return m ? { id: m[1], i: Number(m[2]) as 0 | 1 } : null;
}

export interface ShadowDone {
  /** Times practised. */
  n: number;
  /** Last practised. */
  at: number;
  /** Times the learner judged it close to the original. */
  good: number;
}

export interface ShadowStat {
  /** Sentences shadowed per day (YYYY-MM-DD → count). */
  days: Record<string, number>;
  /** Longest run of sentences judged close in a row. */
  best: number;
  done: Record<string, ShadowDone>;
}

export const emptyShadow = (): ShadowStat => ({ days: {}, best: 0, done: {} });

/** Words to shadow first in the next round, handed over by a finished word session (句子优先). Cleared when
    a round is started any other way, so it never leaks into a later one. */
let focus: string[] = [];
export function shadowNext(ids: string[]) {
  focus = ids;
}
export const shadowFocus = () => focus;

/** Days until a sentence comes back, by how many times it went well: practice spaced out, like the words. */
const GAPS = [1, 3, 7, 16, 35, 80];

export function shadowDue(d: ShadowDone | undefined, now: number) {
  if (!d) return true;
  const gap = d.good ? GAPS[Math.min(d.good - 1, GAPS.length - 1)] : 0.5;
  return now - d.at >= gap * DAY;
}

interface PickWord {
  id: string;
  media: number;
}

/**
 * Sentences for one round: words learned most recently first (their IELTS sentence before the
 * everyday one), sentences that are due again, then new words from the path to fill up.
 * One sentence per word, only sentences that have a recording.
 */
export function pickSentences(
  words: readonly PickWord[],
  cards: Record<string, CardState>,
  shadow: ShadowStat,
  now: number,
  n = 8,
  startOrder = 0,
  focus: readonly string[] = [],
): SentenceRef[] {
  const voiced = (w: PickWord, i: 0 | 1) => !!(w.media & (i ? 16 : 8));
  const byId = new Map(words.map((w) => [w.id, w]));
  const out: SentenceRef[] = [];
  const used = new Set<string>();
  const take = (id: string, fresh: boolean) => {
    const w = byId.get(id);
    if (!w || used.has(id)) return;
    for (const i of [1, 0] as const) {
      const d = shadow.done[sentenceKey({ id, i })];
      if (voiced(w, i) && (fresh ? !d : !!d && shadowDue(d, now))) {
        out.push({ id, i });
        used.add(id);
        return;
      }
    }
  };
  // Words the learner asked for (the session just finished) come first, practised today or not.
  for (const id of focus) {
    if (out.length >= n) break;
    const w = byId.get(id);
    if (!w || used.has(id)) continue;
    const i = ([1, 0] as const).find((k) => voiced(w, k) && !(shadow.done[sentenceKey({ id, i: k })]?.at > now - 6 * 3600e3));
    if (i !== undefined) {
      out.push({ id, i });
      used.add(id);
    }
  }
  const learned = Object.entries(cards)
    .sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0))
    .map(([id]) => id);
  // Sentences of words just learned, never shadowed yet.
  for (const id of learned.slice(0, 60)) if (out.length < n) take(id, true);
  // Sentences that went well before and are due again, oldest first.
  const due = Object.entries(shadow.done)
    .filter(([, d]) => shadowDue(d, now))
    .sort((a, b) => a[1].at - b[1].at);
  for (const [key] of due) {
    if (out.length >= n) break;
    const ref = parseSentenceKey(key);
    if (ref && !used.has(ref.id) && byId.has(ref.id) && voiced(byId.get(ref.id)!, ref.i)) {
      out.push(ref);
      used.add(ref.id);
    }
  }
  // The rest of the learned words, then the path.
  for (const id of learned) if (out.length < n) take(id, true);
  for (const w of words.slice(startOrder)) {
    if (out.length >= n) break;
    if (!cards[w.id]) take(w.id, true);
  }
  return out.slice(0, n);
}

/** Words of a sentence with their character offsets; punctuation stays attached to its word. */
export function sentenceWords(text: string): { w: string; start: number; end: number }[] {
  const out: { w: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push({ w: m[0], start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** Where each word sits in the recording (fractions), guessed from its length and the pauses after commas and full stops. */
export function wordTimes(text: string): [number, number][] {
  const words = sentenceWords(text).map((x) => x.w);
  const weight = (w: string) => 1.2 + w.replace(/[^A-Za-z0-9]/g, "").length * 0.55;
  const pause = (w: string) => (/[.!?]["”’)]*$/.test(w) ? 2.2 : /[,;:—–]["”’)]*$/.test(w) ? 1.4 : 0);
  const lead = 0.04;
  const tail = 0.06;
  const total = words.reduce((n, w, i) => n + weight(w) + (i < words.length - 1 ? pause(w) : 0), 0) || 1;
  let at = lead;
  return words.map((w, i) => {
    const span = ((1 - lead - tail) * weight(w)) / total;
    const t: [number, number] = [at, at + span];
    at += span + (i < words.length - 1 ? ((1 - lead - tail) * pause(w)) / total : 0);
    return t;
  });
}

/** "I went to the library." → "I w___ t_ t__ l______." A cue for saying it from memory. */
export function firstLetters(text: string) {
  return text.replace(/[A-Za-z][A-Za-z'’-]*/g, (w) => (w.length === 1 ? w : w[0] + w.slice(1).replace(/[A-Za-z]/g, "_")));
}

const NUMBERS: Record<string, string> = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten",
};

/** Lower-case word tokens for comparing what was said with what was written. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' -]/g, " ")
    .split(/[\s-]+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter(Boolean)
    .map((t) => NUMBERS[t] ?? t);
}

/**
 * Which written words were heard, by longest common subsequence: extra or swapped words cost only
 * themselves, not everything after them. Returns one flag per word of `target` (as sentenceWords splits it).
 */
export function heardWords(target: string, heard: string): boolean[] {
  const words = sentenceWords(target);
  const tw = words.map((x) => tokens(x.w));
  const flat: { tok: string; word: number }[] = [];
  tw.forEach((ts, word) => ts.forEach((tok) => flat.push({ tok, word })));
  const h = tokens(heard);
  const n = flat.length;
  const m = h.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = flat[i].tok === h[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hit = new Array<boolean>(n).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (flat[i].tok === h[j]) {
      hit[i] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  // A word counts as heard when all its tokens were (punctuation-only "words" count as heard).
  return words.map((_, k) => flat.every((f, i) => f.word !== k || hit[i]));
}

/** Share of words heard, 0..100. */
export function heardScore(target: string, heard: string) {
  const flags = heardWords(target, heard);
  return flags.length ? Math.round((flags.filter(Boolean).length / flags.length) * 100) : 0;
}
