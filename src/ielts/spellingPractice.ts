import type { Atlas } from "../atlas/types";
import { headwordPattern } from "../lib/text";
import type { Progress } from "../store/store";
import { diagnose } from "./spelling";

export type SpellingSource = "learned" | "mistakes" | "bookmarks" | "path";

export function spellingPool(
  atlas: Atlas,
  progress: Progress,
  source: SpellingSource,
  startLevel: number,
): string[] {
  const candidates =
    source === "learned"
      ? Object.entries(progress.cards)
          .sort((a, b) => (b[1].last ?? b[1].seen) - (a[1].last ?? a[1].seen))
          .map(([id]) => id)
      : source === "mistakes"
        ? [...progress.spellLog.map((miss) => miss.id), ...progress.mistakes]
        : source === "bookmarks"
          ? progress.bookmarks
          : atlas.words
              .filter((word) => word.cefr >= startLevel)
              .slice(0, 200)
              .map((word) => word.id);
  return [...new Set(candidates)].filter((id) => atlas.byId.has(id));
}

/** Hide every occurrence, including the inflections already recognised by the review card. */
export function spellingContext(sentence: string, word: string): string | null {
  const pattern = headwordPattern(word);
  if (!pattern.test(sentence)) return null;
  return sentence.replace(new RegExp(pattern.source, "gi"), "______");
}

/** A separate practice may add spelling mistakes, never overwrite a review or reschedule cards. */
export function recordSpellingMiss(
  progress: Progress,
  id: string,
  typed: string,
  word: string,
  now = Date.now(),
): Progress {
  const tags = diagnose(typed, word);
  const spell = { ...progress.spell };
  for (const tag of tags) spell[tag] = (spell[tag] ?? 0) + 1;
  return {
    ...progress,
    spell,
    spellLog: [
      { id, typed: typed.slice(0, 60), at: now, tags },
      ...progress.spellLog,
    ].slice(0, 200),
    mistakes: [
      id,
      ...progress.mistakes.filter((existing) => existing !== id),
    ].slice(0, 300),
  };
}
