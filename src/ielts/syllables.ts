import { useSyncExternalStore } from "react";

/** One piece of a split headword: a spoken syllable, or what joins two words ("-", " "). */
export interface Piece {
  text: string;
  /** Carries the word's main stress. */
  stress?: boolean;
  /** A separator between words rather than a syllable. */
  gap?: boolean;
}

/** "moth·er-in-ˈlaw" → syllables and separators, stress marks lifted out. */
export function parseSyllables(s: string): Piece[] {
  const out: Piece[] = [];
  for (const tok of s.split(/([ \-'’/.]+)/)) {
    if (!tok) continue;
    if (/^[ \-'’/.]+$/.test(tok)) {
      out.push({ text: tok, gap: true });
      continue;
    }
    for (const part of tok.split("·")) {
      const stress = part.startsWith("ˈ");
      out.push(stress ? { text: part.slice(1), stress } : { text: part });
    }
  }
  return out;
}

/**
 * Where each syllable starts and ends in the recording, as fractions of its length.
 * Unknown timings are guessed from the letters: vowels and the stressed syllable take longer.
 */
export function syllableTimes(pieces: Piece[]): [number, number][] {
  const weight = (p: Piece) => (p.gap ? 0.6 : 1 + p.text.length * 0.5 + (p.text.match(/[aeiouy]/gi)?.length ?? 0) * 0.4 + (p.stress ? 1 : 0));
  // Recordings start and end with a little silence.
  const lead = 0.08;
  const tail = 0.12;
  const total = pieces.reduce((n, p) => n + weight(p), 0);
  let at = lead;
  return pieces.map((p) => {
    const span = ((1 - lead - tail) * weight(p)) / total;
    const t: [number, number] = [at, at + span];
    at += span;
    return t;
  });
}

// Optional chaining keeps the module importable from node tests, where Vite env is absent.
const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
let table: Record<string, string> = {};
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

export function loadSyllables() {
  if (!loading)
    loading = fetch(`${BASE}/ielts/syl.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : {}))
      .catch(() => {
        loading = null;
        return {};
      })
      .then((t) => {
        table = t;
        subs.forEach((f) => f());
      });
  return loading;
}

/** The split of an atlas word, or null for a word of one syllable (or before the table loads). */
export function useSyllables(id: string): string | null {
  const t = useSyncExternalStore(
    (f) => {
      subs.add(f);
      void loadSyllables();
      return () => subs.delete(f);
    },
    () => table,
    () => table,
  );
  return t[id] ?? null;
}
