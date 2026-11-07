import type { Atlas } from "../atlas/types";
import { headwordPattern } from "../lib/text";
import { bumpDay, type Progress } from "../store/store";
import { Rating, review } from "../store/srs";
import { flagUnknown, hasAssessment, spellingOrder, startedWeakWords } from "./vocabulary";
import { diagnose } from "./spelling";

export type SpellingSource = "target" | "learned" | "mistakes" | "bookmarks" | "path";

export function spellingPool(
  atlas: Atlas,
  progress: Progress,
  source: SpellingSource,
  startLevel: number,
): string[] {
  const candidates =
    source === "target" ? startedWeakWords(progress) : source === "learned"
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
  const targets = hasAssessment(progress) ? new Set(startedWeakWords(progress)) : null;
  return [...new Set(candidates)].filter((id) => atlas.byId.has(id) && (!targets || targets.has(id)));
}

export function recordSpellingAnswer(p: Progress, answer: { id: string; typed: string; word: string; correct: boolean; hinted: boolean }, mode: "audio" | "meaning", scheduled: boolean, retention: number, now = Date.now()): Progress {
  let next = answer.correct ? p : recordSpellingMiss(p, answer.id, answer.typed, answer.word, now);
  if (!hasAssessment(p)) return next;
  if (!answer.correct) next = flagUnknown(next, answer.id, now);
  next = bumpDay(next, { sp: 1, sc: answer.correct && !answer.hinted ? 1 : 0, sh: answer.hinted ? 1 : 0 }, now);
  if (!scheduled || !startedWeakWords(next).includes(answer.id)) return next;
  const key = `${mode === "audio" ? "l" : "p"}:${answer.id}`;
  const grade = answer.correct ? answer.hinted ? Rating.Hard : Rating.Good : Rating.Again;
  return { ...next, skills: { ...next.skills, [key]: review(next.skills[key], grade, now, retention) } };
}

export { spellingOrder };

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
