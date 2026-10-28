import { useSyncExternalStore } from "react";

/** IELTS layer built by scripts/ielts/build_ielts.py on top of the atlas ids. */
export interface IeltsTags {
  /** Atlas id → chapter of the 王陆 listening corpus it comes from. */
  listening: Record<string, string>;
  /** Corpus items that are not atlas headwords (phrases, names, plurals): [text, chapter]. */
  phrases: [string, string][];
  /** Atlas id → Academic Word List sublist (1 = most frequent). */
  awl: Record<string, number>;
  /** Symmetric synonym graph inside the atlas. */
  syn: Record<string, string[]>;
}

export interface Mnemonic {
  root?: string;
  affix?: string;
  history?: string;
  memory?: string;
  story?: string;
}

// Optional chaining keeps the module importable from node tests, where Vite env is absent.
const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
const EMPTY: IeltsTags = { listening: {}, phrases: [], awl: {}, syn: {} };

let tags: IeltsTags = EMPTY;
let loading: Promise<IeltsTags> | null = null;
const subs = new Set<() => void>();

export function loadTags() {
  if (!loading)
    loading = fetch(`${BASE}/ielts/tags.json`)
      .then((r) => (r.ok ? (r.json() as Promise<IeltsTags>) : EMPTY))
      .catch(() => EMPTY)
      .then((t) => {
        tags = { ...EMPTY, ...t };
        subs.forEach((f) => f());
        return tags;
      });
  return loading;
}

export const getTags = () => tags;

/** For tests and non-browser callers. */
export function setTags(t: Partial<IeltsTags>) {
  tags = { ...EMPTY, ...t };
  subs.forEach((f) => f());
}

export function useTags() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => tags,
    () => tags,
  );
}

/** Recording of a corpus phrase; the file name rule matches phrase_key() in gen_sentence_audio_kokoro.py. */
export function phraseAudio(text: string) {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${BASE}/ielts/phrase/${slug}.mp3` : null;
}

const mnemoChunks = new Map<number, Promise<Record<string, Mnemonic>>>();

/** Roots, memory tips and a short story for a word, if DictionaryByGPT4 covers it. */
export function loadMnemonic(order: number, id: string, chunk = 100): Promise<Mnemonic | null> {
  const n = Math.floor(order / chunk);
  let p = mnemoChunks.get(n);
  if (!p) {
    p = fetch(`${BASE}/ielts/mnemo/${n}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, Mnemonic>>) : {}))
      .catch(() => {
        mnemoChunks.delete(n);
        return {};
      });
    mnemoChunks.set(n, p);
  }
  return p.then((m) => m[id] ?? null);
}
