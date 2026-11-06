import type { Atlas, WordRef } from "../atlas/types";
import type { Progress } from "../store/store";
import { baseForms, lookupIndex } from "./textimport";

// Explicit review entries distinguish a new request from old, already-consumed import IDs.
const REVIEW = "review:";
export const priorityKey = (id: string, learned: boolean) =>
  learned ? REVIEW + id : id;
export const priorityId = (key: string) =>
  key.startsWith(REVIEW) ? key.slice(REVIEW.length) : key;

export function priorityWords(
  atlas: { byId: ReadonlyMap<string, unknown> },
  p: Pick<Progress, "queue" | "cards">,
): string[] {
  return [
    ...new Set(
      p.queue
        .filter((key) => {
          const id = priorityId(key);
          return atlas.byId.has(id) && (key.startsWith(REVIEW) || !p.cards[id]);
        })
        .map(priorityId),
    ),
  ];
}

export function addPriorityWord(
  atlas: Pick<Atlas, "id" | "byId">,
  p: Progress,
  id: string,
): Progress {
  if (
    p.datasetId !== atlas.id ||
    !atlas.byId.has(id) ||
    priorityWords(atlas, p).includes(id)
  )
    return p;
  const key = priorityKey(id, !!p.cards[id]);
  return {
    ...p,
    queue: [key, ...p.queue.filter((value) => priorityId(value) !== id)].slice(
      0,
      2000,
    ),
  };
}

export function removePriorityWord(p: Progress, id: string): Progress {
  const queue = p.queue.filter((key) => priorityId(key) !== id);
  return queue.length === p.queue.length ? p : { ...p, queue };
}

/** Every match is shown to the learner; ambiguous forms are never silently bound. */
export function sentenceWordCandidates(
  surface: string,
  index: ReturnType<typeof lookupIndex>,
): string[] {
  const token =
    surface
      .replace(/[’‘]/g, "'")
      .match(/[A-Za-z]+(?:['-][A-Za-z]+)*/)?.[0]
      ?.toLowerCase() ?? "";
  const forms = baseForms(token);
  if (token.endsWith("'s")) forms.push(...baseForms(token.slice(0, -2)));
  return [
    ...new Set(
      forms
        .map((form) => index.get(form)?.id)
        .filter((id): id is string => !!id),
    ),
  ];
}

export function priorityLookup(words: WordRef[]) {
  return lookupIndex(words);
}
