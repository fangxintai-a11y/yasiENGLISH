import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import {
  defaultSettings,
  emptyProgress,
  sanitizeProgress,
} from "../store/store";
import { mergeSnapshots } from "../store/syncMerge";
import { Rating, review } from "../store/srs";
import {
  applyRecallRating,
  buildSession,
  focusAtBoundary,
  gradeFor,
  trackOf,
} from "../store/session";
import { nextNew, todayPlan } from "./exam";
import {
  assessWord,
  assessmentMarks,
  consolidated,
  spellingOrder,
  startedWeakWords,
} from "./vocabulary";
import { recordSpellingAnswer, spellingPool } from "./spellingPractice";

const now = Date.UTC(2026, 10, 8, 4);
const words: WordRef[] = Array.from({ length: 80 }, (_, order) => ({
  id: `word${order}`,
  word: `word${order}`,
  zh: `词义${order}`,
  ipa: "",
  cefr: order % 7,
  topic: 0,
  media: 0,
  order,
}));
const atlas = {
  id: "test",
  words,
  byId: new Map(words.map((word) => [word.id, word])),
} as Atlas;
const settings = { ...defaultSettings, dailyNew: 10, dailyMinutes: 30 };
const tags = { listening: {}, awl: {} };
const card = {
  ...review(undefined, Rating.Good, now - 86400000),
  st: 2 as const,
  s: 15,
  due: now + 86400000,
};

test("whole-word survey never seeds FSRS; known, unknown and untested remain separate", () => {
  const p = emptyProgress(atlas.id);
  p.cards.word0 = { ...card, src: 1 };
  p.session = {
    id: "preserve",
    started: now,
    steps: [{ id: "word0", kind: "intro" }],
    index: 0,
    newIds: [],
    reviewIds: [],
    graded: {},
  };
  const before = structuredClone(p);
  let next = assessWord(p, "word0", "unknown", now);
  next = assessWord(next, "word1", "known", now);
  next = assessWord(next, "word6", "unknown", now); // ungraded and absent from old IELTS lists
  for (const key of [
    "cards",
    "skills",
    "days",
    "session",
    "placement",
  ] as const)
    assert.equal(next[key], p[key]);
  assert.deepEqual(p, before);
  assert.deepEqual(nextNew(atlas, next, 5, 20, new Set()), ["word6"]);
  const plan = todayPlan(atlas, next, settings, tags, now, 0);
  assert.deepEqual(plan.fresh, ["word6"]);
  assert.deepEqual(plan.due, ["word0"]);
  assert.deepEqual(
    plan.unlock,
    [],
    "an unchecked seeded card is not yet spelling evidence",
  );
  assert.deepEqual(
    assessmentMarks(sanitizeProgress(next, atlas.id)),
    next.assessment!.marks,
  );
});

test("spelling covers unknown words only after learning, irrespective of corpus tags or short-term state", () => {
  let p = assessWord(emptyProgress(atlas.id), "word1", "unknown", now - 1);
  p = assessWord(p, "word2", "unknown", now - 1);
  p = assessWord(p, "word3", "known", now - 1);
  p.cards = {
    word1: { ...card, st: 1, s: 0.01 },
    word2: { ...card, src: 1 },
    word3: card,
    word4: card,
  };
  assert.deepEqual(startedWeakWords(p), ["word1"]);
  assert.deepEqual(spellingPool(atlas, p, "target", 5), ["word1"]);
  assert.deepEqual(spellingPool(atlas, p, "learned", 5), ["word1"]);
  const plan = todayPlan(atlas, p, settings, tags, now, 0);
  assert.deepEqual(plan.unlock.sort(), ["l:word1", "p:word1"]);
  const round = buildSession(atlas, p, settings, { reviewOnly: true });
  assert.ok(
    round.steps.some(
      (step) => step.id === "word1" && step.kind === "dictation",
    ),
  );
  assert.ok(
    round.steps.some((step) => step.id === "word1" && step.kind === "produce"),
  );
  assert.equal(round.newIds.length, 0);
});

test("more rounds expand spelling coverage after twelve daily cards, without a fixed corpus prefix", () => {
  let p = emptyProgress(atlas.id);
  for (let i = 0; i < 35; i++) {
    p = assessWord(p, `word${i}`, "unknown", now - 1);
    p.cards[`word${i}`] = card;
  }
  for (let i = 0; i < 12; i++)
    p.skills[`l:word${i}`] = { ...card, seen: now, last: now };
  const plan = todayPlan(atlas, p, settings, tags, now, 0);
  assert.ok(plan.unlock.length > 0 && plan.unlock.length <= 30);
  assert.ok(
    plan.unlock.includes("p:word0"),
    "the missing production track is available without AWL membership",
  );
  const ids = startedWeakWords(p);
  assert.ok(
    spellingOrder(p, ids, "audio", now)
      .slice(0, 10)
      .every((id) => !p.skills[`l:${id}`]),
  );
});

test("focused first spelling results persist both successes and misses and rotate subsequent rounds", () => {
  let p = assessWord(emptyProgress(atlas.id), "word0", "unknown", now - 1);
  p = assessWord(p, "word1", "unknown", now - 1);
  p.cards = { word0: card, word1: card };
  p.session = {
    id: "ongoing",
    started: now,
    steps: [{ id: "word0", kind: "intro" }],
    index: 0,
    newIds: [],
    reviewIds: [],
    graded: {},
  };
  const result = {
    id: "word0",
    word: "word0",
    typed: "word0",
    correct: true,
    hinted: false,
  };
  const next = recordSpellingAnswer(p, result, "meaning", true, 0.9, now);
  assert.equal(next.cards, p.cards);
  assert.equal(next.session, p.session);
  assert.ok(next.skills["p:word0"]);
  assert.equal(next.skills["l:word0"], undefined);
  assert.equal(Object.values(next.days)[0].sp, 1);
  assert.equal(Object.values(next.days)[0].sc, 1);
  assert.equal(
    spellingOrder(next, ["word0", "word1"], "meaning", now)[0],
    "word1",
  );
  const failed = recordSpellingAnswer(
    next,
    { ...result, id: "word1", word: "word1", typed: "wrong", correct: false },
    "audio",
    true,
    0.9,
    now + 1,
  );
  assert.equal(failed.spellLog[0].id, "word1");
  assert.equal(Object.values(failed.days)[0].sp, 2);
  assert.equal(Object.values(failed.days)[0].sc, 1);
  assert.equal(consolidated(failed, "word1"), false);
});

test("assessment changes focus future questions at a boundary, preserving the pending question and its history", () => {
  const p = assessWord(emptyProgress(atlas.id), "word2", "unknown", now - 1);
  p.session = {
    id: "old",
    started: now,
    steps: [
      { id: "word0", kind: "intro" },
      { id: "word1", kind: "intro" },
      { id: "word2", kind: "intro" },
    ],
    index: 0,
    pending: { correct: true, value: "word0" },
    newIds: ["word0", "word1", "word2"],
    reviewIds: [],
    graded: {},
  };
  assert.equal(focusAtBoundary(p, now), p, "never remove a pending answer");
  const next = focusAtBoundary(
    {
      ...p,
      session: {
        ...p.session,
        index: 1,
        pending: undefined,
        graded: { word0: Rating.Good },
      },
    },
    now,
  );
  assert.equal(next.session!.id, "old");
  assert.equal(next.session!.index, 1);
  assert.deepEqual(
    next.session!.steps.map((step) => step.id),
    ["word0", "word2"],
  );
  assert.equal(next.session!.graded.word0, Rating.Good);
});

test("a failed known-word spot check returns it to unknown without touching unrelated memory", () => {
  let p = assessWord(emptyProgress(atlas.id), "word0", "known", now - 2);
  p.cards.word0 = card;
  p.skills["l:word0"] = card;
  p.session = {
    id: "check",
    started: now,
    steps: [{ id: "word0", kind: "meaning", check: true }],
    index: 0,
    newIds: [],
    reviewIds: ["word0"],
    graded: {},
  };
  p = applyRecallRating(
    atlas,
    p,
    settings,
    { sessionId: "check", index: 0, id: "word0" },
    Rating.Again,
    4,
    now,
  );
  assert.equal(assessmentMarks(p).word0.state, "unknown");
  assert.equal(p.skills["l:word0"], card);
});

test("offline devices merge per-word marks, with latest reclassification winning and legacy fields preserved", () => {
  const p = emptyProgress(atlas.id);
  p.cards.word0 = card;
  const base = { progress: p, settings };
  const local = { progress: assessWord(p, "word1", "unknown", now), settings };
  const remote = {
    progress: assessWord(
      assessWord(p, "word1", "known", now - 1),
      "word2",
      "known",
      now,
    ),
    settings,
  };
  const merged = mergeSnapshots(base, local, remote);
  assert.equal(assessmentMarks(merged.progress).word1.state, "unknown");
  assert.equal(assessmentMarks(merged.progress).word2.state, "known");
  assert.deepEqual(merged.progress.cards, p.cards);
  assert.equal(merged.progress.session, null);
});

test("a seeded or newly forgotten word starts short confirmation on actual study, retaining first-seen history", () => {
  let p = assessWord(emptyProgress(atlas.id), "word0", "unknown", now - 1);
  p.cards.word0 = { ...card, src: 1, due: now + 90 * 86400000 };
  p.session = {
    id: "seed-study",
    started: now,
    steps: [{ id: "word0", kind: "meaning" }],
    index: 0,
    newIds: [],
    reviewIds: ["word0"],
    graded: {},
  };
  const next = applyRecallRating(
    atlas,
    p,
    settings,
    { sessionId: "seed-study", index: 0, id: "word0" },
    Rating.Good,
    4,
    now,
  );
  assert.equal(next.cards.word0.src, undefined);
  assert.equal(next.cards.word0.st, 1);
  assert.ok(next.cards.word0.due - now <= 10 * 60000);
  assert.equal(next.cards.word0.seen, p.cards.word0.seen);
  assert.equal(gradeFor("dictation", true, 60000, false), Rating.Good);
  assert.equal(gradeFor("produce", true, 60000, false), Rating.Good);
  assert.equal(gradeFor("dictation", true, 60000, true), Rating.Hard);
  assert.equal(gradeFor("dictation", false, 2000, false), Rating.Again);
});

test("known words without seeded cards receive a limited delayed check and never repeat on that day", () => {
  let p = assessWord(
    emptyProgress(atlas.id),
    "word0",
    "known",
    now - 2 * 86400000,
  );
  p = assessWord(p, "word1", "unknown", now - 2 * 86400000);
  const plan = todayPlan(atlas, p, settings, tags, now, 0);
  assert.deepEqual(plan.due, ["word0"]);
  assert.deepEqual(plan.fresh, ["word1"]);
  assert.equal(Object.keys(p.cards).length, 0);
  p.session = buildSession(atlas, p, settings);
  assert.ok(p.session.steps[0].check);
  const result = applyRecallRating(
    atlas,
    p,
    settings,
    { sessionId: p.session.id, index: 0, id: "word0" },
    Rating.Good,
    2,
    now,
  );
  assert.ok(
    !todayPlan(atlas, result, settings, tags, now + 20 * 60000, 0).due.includes(
      "word0",
    ),
  );
});

test("formal and independent spelling alternate due words with previously untrained words", () => {
  let p = emptyProgress(atlas.id);
  for (let i = 0; i < 8; i++) {
    p = assessWord(p, `word${i}`, "unknown", now - 1);
    p.cards[`word${i}`] = card;
  }
  p.skills["l:word0"] = { ...card, due: Date.now() - 1000 };
  p.skills["l:word1"] = { ...card, due: Date.now() - 1000 };
  const ordered = spellingOrder(p, Object.keys(p.cards), "audio", now);
  assert.ok(p.skills[`l:${ordered[0]}`]);
  assert.equal(p.skills[`l:${ordered[1]}`], undefined);
  const round = buildSession(atlas, p, settings, { reviewOnly: true });
  const spelling = round.steps.filter(
    (step) => step.kind === "dictation" || step.kind === "produce",
  );
  assert.ok(p.skills[`${trackOf(spelling[0])}:${spelling[0].id}`]);
  assert.equal(
    p.skills[`${trackOf(spelling[1])}:${spelling[1].id}`],
    undefined,
  );
});

test("resuming an old round trims queued spelling retries without removing already answered history", () => {
  const p = emptyProgress(atlas.id);
  p.session = {
    id: "legacy-loop",
    started: now,
    steps: [
      { id: "word0", kind: "dictation", track: "l" },
      ...Array.from({ length: 6 }, () => ({
        id: "word0",
        kind: "dictation" as const,
        track: "l" as const,
        retry: true,
      })),
    ],
    index: 2,
    newIds: [],
    reviewIds: [],
    graded: { "l:word0": Rating.Again },
    relearn: { "l:word0": 0 },
  };
  const limited = focusAtBoundary(p, now);
  assert.deepEqual(
    limited.session!.steps.slice(0, 2),
    p.session.steps.slice(0, 2),
  );
  assert.equal(
    limited.session!.steps.filter((step) => step.kind !== "intro" && step.retry)
      .length,
    2,
  );
  assert.equal(limited.session!.id, p.session.id);
  assert.deepEqual(limited.session!.graded, p.session.graded);
  const succeeded = focusAtBoundary(
    { ...limited, session: { ...limited.session!, relearn: { "l:word0": 1 } } },
    now,
  );
  assert.equal(succeeded.session!.steps.length, 2);
  assert.equal(succeeded.session!.finished, now);
});
