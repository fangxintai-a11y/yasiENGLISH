import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { answer, buildSession, gradeFor, rateIntro, type IntroRating } from "./session";
import { Rating } from "./srs";
import { defaultSettings, emptyProgress, store, type ActiveSession, type QuizKind, type Step } from "./store";

const words: WordRef[] = Array.from({ length: 40 }, (_, i) => ({
  id: `w${i}`, word: `word${i}`, zh: `n. 词${i}`, ipa: "", cefr: 2, topic: 0, media: 31, order: i,
}));
const atlas = { words, byId: new Map(words.map((w) => [w.id, w])) } as unknown as Atlas;

/** Run against the real store with an in-memory localStorage, like store.test.ts. */
function withStore(check: () => void) {
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"), storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { clearTimeout() {}, setTimeout() { return 0; } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  try {
    store.useDataset("intro-rating-fixture");
    store.settings({ ...defaultSettings, trackL: true });
    check();
  } finally {
    store.useDataset("word-atlas-open");
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else delete (globalThis as { window?: unknown }).window;
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

/** A fresh session that meets five new words, then quizzes them. */
function startSession(): ActiveSession {
  const session = buildSession(atlas, emptyProgress("intro-rating-fixture"), { ...defaultSettings }, { ids: ["w1", "w2", "w3", "w4", "w5"] });
  store.progress((p) => ({ ...p, cards: {}, skills: {}, mistakes: [], session }));
  return session;
}
const current = () => store.get().progress.session!;
/** Rate every intro of the first group, in order. */
function rateGroup(ratings: Record<string, IntroRating>) {
  while (current().steps[current().index].kind === "intro") {
    const id = current().steps[current().index].id;
    rateIntro(id, ratings[id] ?? "known", 4);
  }
}
/** Answer the current step correctly and quickly (what happens right after reading a meaning). */
function answerRight() {
  const step = current().steps[current().index] as Step & { kind: QuizKind };
  answer(atlas, step, true, gradeFor(step.kind, true, 800, false), step.id, 800);
  store.progress((p) => ({ ...p, session: { ...p.session!, index: p.session!.index + 1, pending: undefined } }));
}

test("known keeps the old path: the recognition quiz decides the memory", () => {
  withStore(() => {
    startSession();
    rateGroup({});
    const step = current().steps[current().index];
    assert.equal(step.kind === "intro", false);
    assert.equal(store.get().progress.cards[step.id], undefined, "no memory before the quiz");
    answerRight();
    assert.equal(current().graded[step.id], Rating.Good);
    assert.equal(store.get().progress.skills[`l:${step.id}`], undefined, "no forced dictation for a known word");
    assert.equal(current().steps.filter((s) => s.kind === "dictation").length, 0);
  });
});

test("unsure and unknown are kept as learning words, with a dictation in this session", () => {
  withStore(() => {
    startSession();
    rateGroup({ w2: "unsure", w4: "unknown" });
    const p = store.get().progress, s = current();
    assert.equal(s.intro?.w2, "unsure");
    assert.equal(s.graded.w2, Rating.Hard);
    assert.equal(s.graded.w4, Rating.Again);
    for (const id of ["w2", "w4"]) {
      const card = p.cards[id];
      assert.ok(card && (card.st === 1 || card.st === 3), `${id} is in the learning state`);
      assert.ok(card.due - Date.now() < 15 * 60000, `${id} comes back within minutes`);
      assert.ok(p.skills[`l:${id}`], `${id} gets a listen-and-spell card`);
      assert.ok(p.mistakes.includes(id));
      assert.ok(s.skillKeys?.includes(`l:${id}`));
    }
    // The dictations come after this group's recognition quizzes, before anything else.
    const quizzes = s.steps.slice(s.index).map((x) => `${x.kind}:${x.id}`);
    const lastRecognition = Math.max(...["w1", "w2", "w3", "w4", "w5"].map((id) => quizzes.findIndex((k) => k.endsWith(`:${id}`) && !k.startsWith("dictation"))));
    for (const id of ["w2", "w4"]) assert.ok(quizzes.indexOf(`dictation:${id}`) > lastRecognition, quizzes.join(" "));
    assert.equal(quizzes.filter((k) => k.startsWith("dictation")).length, 2);
  });
});

test("an easy quiz right after reading the meaning does not upgrade an unsure word", () => {
  withStore(() => {
    startSession();
    rateGroup({ w1: "unsure", w2: "unsure", w3: "unknown", w4: "unknown", w5: "unsure" });
    const before = structuredClone(store.get().progress.cards);
    for (let i = 0; i < 5; i++) answerRight();
    const after = store.get().progress.cards;
    for (const id of ["w1", "w2", "w3", "w4", "w5"]) {
      assert.deepEqual(after[id], before[id], `${id} memory keeps the self-rating`);
      assert.notEqual(current().graded[id], Rating.Good);
    }
  });
});

test("a missed dictation of an unsure word is retried until spelled right three times", () => {
  withStore(() => {
    startSession();
    rateGroup({ w3: "unsure" });
    while (current().steps[current().index].kind !== "dictation") answerRight();
    const step = current().steps[current().index] as Step & { kind: QuizKind };
    assert.equal(step.id, "w3");
    answer(atlas, step, false, gradeFor("dictation", false, 5000, false), "wrd3", 5000);
    const retries = current().steps.slice(current().index + 1).filter((x) => x.kind === "dictation" && x.id === "w3" && "retry" in x && x.retry);
    assert.equal(retries.length, 1, "a missed dictation is asked again later in the session");
    assert.equal(store.get().progress.skills["l:w3"].st === 1 || store.get().progress.skills["l:w3"].st === 3, true);
  });
});

test("with listening cards switched off, unsure words still return for review", () => {
  withStore(() => {
    store.settings({ trackL: false });
    startSession();
    rateGroup({ w1: "unknown" });
    assert.ok(store.get().progress.cards.w1);
    assert.equal(store.get().progress.skills["l:w1"], undefined);
    assert.equal(current().steps.filter((s) => s.kind === "dictation").length, 0);
  });
});
