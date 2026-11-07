import type { Progress, WordAssessment } from "../store/store";
import type { CardState } from "../store/srs";

const EMPTY_MARKS: Record<string, WordAssessment> = Object.freeze(
  Object.create(null),
);
export const assessmentMarks = (p: Pick<Progress, "assessment">) =>
  p.assessment?.marks ?? EMPTY_MARKS;
const activeCache = new WeakMap<object, boolean>();
export const hasAssessment = (p: Pick<Progress, "assessment">) => {
  if (!p.assessment) return false;
  const marks = p.assessment.marks;
  let active = activeCache.get(marks);
  if (active === undefined) {
    active = Object.keys(marks).length > 0;
    activeCache.set(marks, active);
  }
  return active;
};
export const isWeakWord = (p: Pick<Progress, "assessment">, id: string) =>
  assessmentMarks(p)[id]?.state === "unknown";
export const inLearningScope = (p: Pick<Progress, "assessment">, id: string) =>
  !hasAssessment(p) || isWeakWord(p, id);

/** A survey is separate from memory: no seeded cards, grades or artificial mastery. */
export function assessWord(
  p: Progress,
  id: string,
  state: WordAssessment["state"],
  at = Date.now(),
): Progress {
  return {
    ...p,
    assessment: { marks: { ...assessmentMarks(p), [id]: { state, at } } },
    queue:
      state === "known"
        ? p.queue.filter((key) => key !== id && key !== `review:${id}`)
        : p.queue,
  };
}

export function flagUnknown(
  p: Progress,
  id: string,
  at = Date.now(),
): Progress {
  return !hasAssessment(p) || isWeakWord(p, id)
    ? p
    : assessWord(p, id, "unknown", at);
}

export function startedWeakWords(p: Progress): string[] {
  return Object.keys(p.cards).filter(
    (id) => isWeakWord(p, id) && !p.cards[id].src,
  );
}

export function scopeWords(p: Progress, ids: string[]): string[] {
  return hasAssessment(p) ? ids.filter((id) => isWeakWord(p, id)) : ids;
}

/** Explicitly forgotten words can return now while their original card history survives. */
export function assessmentReviews(p: Progress): string[] {
  return Object.entries(assessmentMarks(p))
    .filter(
      ([id, mark]) =>
        mark.state === "unknown" &&
        p.cards[id] &&
        (p.cards[id].src || (p.cards[id].last ?? 0) < mark.at),
    )
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id]) => id);
}

const steady = (card: CardState | undefined, days: number) =>
  !!card && !card.src && card.st === 2 && card.s >= days;
export function consolidated(p: Progress, id: string): boolean {
  const r = p.cards[id];
  return (
    steady(r, 21) &&
    (r.last ?? 0) - r.seen >= 86400000 &&
    steady(p.skills[`l:${id}`], 7) &&
    steady(p.skills[`p:${id}`], 7)
  );
}

/** Missing or least recently practised tracks rotate in; no permanently fixed first-N window. */
export function spellingOrder(
  p: Progress,
  ids: string[],
  mode: "audio" | "meaning",
  now = Date.now(),
): string[] {
  const prefix = mode === "audio" ? "l:" : "p:";
  const ordered = [...new Set(ids)].sort(
    (a, b) =>
      (p.skills[prefix + a]?.last ?? 0) - (p.skills[prefix + b]?.last ?? 0) ||
      a.localeCompare(b),
  );
  const fresh = ordered.filter((id) => !p.skills[prefix + id]);
  const due = ordered.filter((id) => p.skills[prefix + id]?.due <= now);
  const rest = ordered.filter((id) => p.skills[prefix + id]?.due > now);
  const result: string[] = [];
  for (let i = 0; i < Math.max(fresh.length, due.length); i++) {
    if (due[i]) result.push(due[i]);
    if (fresh[i]) result.push(fresh[i]);
  }
  return [...result, ...rest];
}
