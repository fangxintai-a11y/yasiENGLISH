import type { Atlas, WordRef } from "../atlas/types";
import { MEDIA } from "../atlas/types";
import { cardKey, effectiveRetention, getCard, nextNew, parseKey, targetIds, todayPlan as planToday } from "../ielts/exam";
import { diagnose } from "../ielts/spelling";
import { getTags } from "../ielts/tags";
import { hashSeed, normalize, shuffle } from "../lib/text";
import { isMastered, review, Rating, type CardState, type Grade } from "./srs";
import { bumpDay, dayKey, store, type ActiveSession, type Progress, type QuizKind, type Settings, type Step, type Track } from "./store";

export function newToday(p: Progress) {
  return p.days[dayKey()]?.n ?? 0;
}

export function todayPlan(atlas: Atlas, p: Progress, s: Settings, now = Date.now()) {
  return planToday(atlas, p, s, getTags(), now, newToday(p));
}

export const TRACK_OF: Record<QuizKind, Track> = {
  meaning: "r",
  picture: "r",
  listen: "r",
  paraphrase: "r",
  spell: "p",
  dictation: "l",
  produce: "p",
};

export const trackOf = (step: Step): Track => (step.kind === "intro" ? "r" : (step.track ?? TRACK_OF[step.kind]));
export const stepKey = (step: Step) => cardKey(trackOf(step), step.id);

/** Synonyms of a word that are themselves in the atlas. */
export const atlasSynonyms = (atlas: Atlas, id: string) => (getTags().syn[id] ?? []).filter((x) => atlas.byId.has(x));

function recognitionKind(ref: WordRef, c: CardState | undefined, atlas: Atlas, salt: number): QuizKind {
  const hasImg = !!(ref.media & MEDIA.img);
  const roll = hashSeed(ref.id + salt) % 100;
  if (!c || c.s < 2) {
    if (hasImg && roll < 45) return "picture";
    return roll < 80 ? "meaning" : "listen";
  }
  // Steady words are tested the way IELTS reading tests them: through a paraphrase.
  if (c.s >= 4 && roll < 35 && atlasSynonyms(atlas, ref.id).length) return "paraphrase";
  if (roll < 60) return "meaning";
  return roll < 80 ? "listen" : hasImg ? "picture" : "meaning";
}

/** Distractors that look plausible: same level, similar spelling or length, different meaning. */
export function distractors(atlas: Atlas, ref: WordRef, kind: QuizKind, seed: number, exclude: string[] = []) {
  const target = normalize(ref.word);
  const zhCore = ref.zh.replace(/^[a-z.]+\s*/, "").split(/[；;，,]/)[0];
  const scored: [number, WordRef][] = [];
  const pool = atlas.words;
  const skip = new Set(exclude);
  const start = Math.max(0, ref.order - 400);
  for (let i = start; i < Math.min(pool.length, ref.order + 400); i++) {
    const w = pool[i];
    if (w.id === ref.id || skip.has(w.id) || normalize(w.word) === target) continue;
    if (zhCore && w.zh.includes(zhCore)) continue;
    let score = hashSeed(w.id + seed) % 100;
    if (kind === "listen" || kind === "picture") {
      if (w.word[0]?.toLowerCase() === target[0]) score += 120;
      score += Math.max(0, 60 - Math.abs(w.word.length - target.length) * 20);
    } else {
      if (w.cefr === ref.cefr) score += 40;
      if (w.zh.split(" ")[0] === ref.zh.split(" ")[0]) score += 60; // same part of speech
    }
    scored.push([score, w]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const [, w] of scored) {
    const key = kind === "meaning" ? w.zh : normalize(w.word);
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(w.id);
    if (picks.length === 3) break;
  }
  return shuffle([ref.id, ...picks], seed);
}

/** A paraphrase question: one synonym that could replace the word, three that could not. */
export function paraphraseStep(atlas: Atlas, ref: WordRef, seed: number): Step | null {
  const syns = atlasSynonyms(atlas, ref.id);
  if (!syns.length) return null;
  const answer = syns[hashSeed(ref.id + seed) % syns.length];
  const ans = atlas.byId.get(answer)!;
  const opts = distractors(atlas, ans, "meaning", seed, [ref.id, ...syns]);
  return { id: ref.id, kind: "paraphrase", track: "r", options: opts, answer };
}

export function quizStep(atlas: Atlas, p: Progress, key: string, salt: number, retry = false): Step {
  const { track, id } = parseKey(key);
  const ref = atlas.byId.get(id)!;
  if (track === "l") return { id, kind: "dictation", track, retry };
  if (track === "p") return { id, kind: "produce", track, retry };
  const kind = retry ? (ref.media & MEDIA.img ? "picture" : "listen") : recognitionKind(ref, p.cards[id], atlas, salt);
  if (kind === "paraphrase") {
    const st = paraphraseStep(atlas, ref, salt);
    if (st) return st;
  }
  const k = kind === "paraphrase" ? "meaning" : kind;
  return { id, kind: k, track: "r", retry, options: distractors(atlas, ref, k, salt) };
}

export interface SessionOptions {
  /** Explicit words (recognition track); unseen ones are introduced first. */
  ids?: string[];
  /** Explicit cards of any track, e.g. a spelling drill. */
  keys?: string[];
  reviewOnly?: boolean;
  /** Learn this many extra new words now, beyond today's plan. */
  extraNew?: number;
  /** Practice rounds never change memory or stats (spelling stats still count). */
  practice?: boolean;
  label?: string;
}

export function buildSession(atlas: Atlas, p: Progress, s: Settings, opts?: SessionOptions): ActiveSession {
  const seed = Date.now();
  const steps: Step[] = [];
  let reviewKeys: string[];
  let newIds: string[];
  let unlock: string[] = [];
  if (opts?.keys) {
    reviewKeys = opts.keys.filter((k) => atlas.byId.has(parseKey(k).id));
    newIds = [];
  } else if (opts?.ids) {
    const ids = opts.ids.filter((id) => atlas.byId.has(id));
    reviewKeys = ids.filter((id) => p.cards[id]);
    newIds = ids.filter((id) => !p.cards[id]);
  } else if (opts?.extraNew) {
    reviewKeys = [];
    newIds = nextNew(atlas, p, s.startLevel, opts.extraNew, targetIds(atlas, s.targetBand, getTags()));
  } else {
    const plan = todayPlan(atlas, p, s);
    reviewKeys = plan.due.slice(0, 150);
    newIds = opts?.reviewOnly ? [] : plan.fresh;
    unlock = opts?.reviewOnly ? [] : plan.unlock;
  }
  // Reviews first while attention is fresh, then the new skills, then new words in small
  // groups: meet five, then recall those five in a different order.
  reviewKeys.forEach((k, i) => steps.push(quizStep(atlas, p, k, seed + i)));
  unlock.forEach((k, i) => steps.push(quizStep(atlas, p, k, seed + 500 + i)));
  for (let g = 0; g < newIds.length; g += 5) {
    const group = newIds.slice(g, g + 5);
    group.forEach((id) => steps.push({ id, kind: "intro" }));
    shuffle(group, seed + g).forEach((id, i) => steps.push(quizStep(atlas, p, id, seed + 1000 + g + i)));
  }
  const reviewIds = [...new Set(reviewKeys.filter((k) => parseKey(k).track === "r"))];
  const skillKeys = [...reviewKeys.filter((k) => parseKey(k).track !== "r"), ...unlock];
  return {
    id: `s${seed}`,
    started: seed,
    steps,
    index: 0,
    graded: {},
    newIds,
    reviewIds,
    skillKeys,
    ms: {},
    label: opts?.label,
    practice: opts?.practice || undefined,
  };
}

/** Thresholds behind the automatic grade; shown to the learner so the grade is never a mystery. */
export const SPEED_LIMIT: Record<QuizKind, number> = {
  meaning: 3000,
  listen: 4500,
  picture: 6000,
  paraphrase: 7000,
  spell: 14000,
  dictation: 12000,
  produce: 14000,
};

/** Grade from the answer itself: correctness, speed and hints. No self-rating. */
export function gradeFor(kind: QuizKind, correct: boolean, ms: number, hinted: boolean): Grade {
  if (!correct) return Rating.Again;
  if (hinted) return Rating.Hard;
  if (ms > SPEED_LIMIT[kind]) return Rating.Hard;
  return Rating.Good;
}

export const isPractice = (s: ActiveSession | null | undefined) => !!s?.practice;

/** Apply an answer. Only the first attempt for a card in a session updates memory and stats. */
export function answer(atlas: Atlas, step: Step & { kind: QuizKind }, correct: boolean, grade: Grade, value: string, ms = 0) {
  const { settings } = store.get();
  const now = Date.now();
  const track = trackOf(step);
  const key = cardKey(track, step.id);
  store.progress((p) => {
    const sess = p.session;
    if (!sess) return p;
    let next: Progress = { ...p, session: { ...sess, pending: { correct, value } } };
    const first = !(key in sess.graded) && !step.retry;
    if (first) {
      const practice = isPractice(sess);
      if (!practice) {
        const card = review(getCard(p, key), grade, now, effectiveRetention(settings, now));
        next = track === "r" ? { ...next, cards: { ...next.cards, [step.id]: card } } : { ...next, skills: { ...next.skills, [key]: card } };
        next = bumpDay(next, { r: 1, c: correct ? 1 : 0, n: track === "r" && sess.newIds.includes(step.id) ? 1 : 0 });
      }
      next = {
        ...next,
        session: { ...next.session!, graded: { ...sess.graded, [key]: grade }, ms: { ...(sess.ms ?? {}), [key]: Math.round(ms) } },
        mistakes: correct ? next.mistakes : [step.id, ...next.mistakes.filter((x) => x !== step.id)].slice(0, 300),
      };
    }
    // Only the first attempt counts towards the spelling diagnosis; retries would double count.
    if (first && !correct && (step.kind === "dictation" || step.kind === "produce") && value.trim()) {
      const ref = atlas.byId.get(step.id);
      const tags = ref ? diagnose(value, ref.word) : [];
      if (tags.length) {
        const spell = { ...next.spell };
        tags.forEach((t) => (spell[t] = (spell[t] ?? 0) + 1));
        next = { ...next, spell, spellLog: [{ id: step.id, typed: value.slice(0, 60), at: now, tags }, ...next.spellLog].slice(0, 200) };
      }
    }
    if (!correct) {
      // Practise it again a few steps later; never re-graded.
      const steps = [...next.session!.steps];
      const retries = steps.filter((x) => x.id === step.id && x.kind !== "intro" && x.retry && trackOf(x) === track).length;
      if (retries < 2) {
        const at = Math.min(steps.length, sess.index + 4);
        steps.splice(at, 0, quizStep(atlas, next, key, now, true));
        next = { ...next, session: { ...next.session!, steps } };
      }
    }
    return next;
  });
}

/** Move to the next step; `seconds` is time spent on this step, capped so idle tabs don't inflate stats. */
export function advance(seconds: number) {
  store.progress((p) => {
    const s = p.session;
    if (!s) return p;
    const index = s.index + 1;
    const finished = index >= s.steps.length ? Date.now() : undefined;
    const next = isPractice(s) ? p : bumpDay(p, { t: Math.max(0, Math.min(90, Math.round(seconds))) });
    return { ...next, session: { ...s, index, pending: undefined, finished } };
  });
}

export function sessionStats(s: ActiveSession) {
  const graded = Object.values(s.graded);
  const correct = graded.filter((g) => g !== Rating.Again).length;
  return { total: graded.length, correct, accuracy: graded.length ? Math.round((correct / graded.length) * 100) : 0 };
}

export const masteredCount = (p: Progress) => Object.values(p.cards).filter(isMastered).length;
