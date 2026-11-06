import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import {
  defaultSettings,
  emptyProgress,
  type ActiveSession,
  type Progress,
} from "../store/store";
import { Rating, review } from "../store/srs";
import { applyRecallRating, buildPrioritySession } from "../store/session";
import { nextNew, todayPlan } from "./exam";
import {
  addPriorityWord,
  priorityLookup,
  priorityWords,
  removePriorityWord,
  sentenceWordCandidates,
} from "./priority";

const words = ["hut", "shelter", "go", "left", "leave", "other"].map(
  (id, order) => ({
    id,
    word: id,
    zh: id,
    ipa: "",
    cefr: 2,
    topic: 0,
    media: 0,
    order,
  }),
) satisfies WordRef[];
const atlas = {
  id: "t",
  words,
  byId: new Map(words.map((word) => [word.id, word])),
} as Atlas;
const now = Date.now();
const later = {
  ...review(undefined, Rating.Good, now),
  due: now + 90 * 86400000,
};
const tags = { listening: {}, awl: {} };

test("marking new and forgotten words only changes the priority pool, not FSRS or an unfinished round", () => {
  const p = emptyProgress("t");
  p.cards.hut = later;
  p.queue = ["hut", "other"]; // the raw learned import ID is old/consumed, not a new review request
  p.session = {
    id: "unfinished",
    started: now,
    steps: [{ id: "go", kind: "intro" }],
    index: 0,
    graded: {},
    newIds: ["go"],
    reviewIds: [],
  };
  const before = structuredClone(p);
  const next = addPriorityWord(atlas, p, "hut");
  assert.deepEqual(priorityWords(atlas, p), ["other"]);
  assert.deepEqual(next.queue, ["review:hut", "other"]);
  assert.deepEqual(priorityWords(atlas, next), ["hut", "other"]);
  assert.equal(addPriorityWord(atlas, next, "hut"), next);
  assert.deepEqual(addPriorityWord(atlas, next, "shelter").queue, [
    "shelter",
    "review:hut",
    "other",
  ]);
  for (const key of ["cards", "skills", "days", "session", "spellLog"] as const)
    assert.deepEqual(next[key], p[key]);
  assert.equal(addPriorityWord(atlas, p, "not-in-atlas"), p);
  assert.equal(addPriorityWord({ ...atlas, id: "another" }, p, "shelter"), p);
  assert.deepEqual(p, before);
  assert.deepEqual(removePriorityWord(next, "hut").queue, ["other"]);
});

test("queued new words go first and explicit forgotten words are reviewed before their distant due date", () => {
  const p = emptyProgress("t");
  p.cards.hut = later;
  const queued = addPriorityWord(
    atlas,
    addPriorityWord(atlas, p, "hut"),
    "leave",
  );
  assert.deepEqual(
    nextNew(atlas, queued, 2, 1, new Set(words.map((w) => w.id))),
    ["leave"],
  );
  const plan = todayPlan(
    atlas,
    queued,
    { ...defaultSettings, dailyNew: 1, dailyMinutes: 20 },
    tags,
    now,
    0,
  );
  assert.equal(plan.due[0], "hut");
  assert.equal(plan.fresh[0], "leave");
  assert.equal(
    todayPlan(atlas, queued, { ...defaultSettings, dailyNew: 0 }, tags, now, 0)
      .fresh.length,
    0,
  );
  assert.equal(
    buildPrioritySession(atlas, queued, defaultSettings, ["leave"])!.newIds[0],
    "leave",
    "the explicit extra-learning entry works even after daily quota is zero",
  );
});

test("sentence forms are matched without silently resolving ambiguous or unknown tokens", () => {
  const lookup = priorityLookup(words);
  assert.deepEqual(sentenceWordCandidates("“Huts,”", lookup), ["hut"]);
  assert.deepEqual(sentenceWordCandidates("sheltered.", lookup), ["shelter"]);
  assert.deepEqual(sentenceWordCandidates("went", lookup), ["go"]);
  assert.deepEqual(sentenceWordCandidates("left", lookup), ["left", "leave"]);
  assert.deepEqual(sentenceWordCandidates("Xylophonicville!", lookup), []);
});

test("selected priority words join after the current question while all previous work and other tracks survive", () => {
  const p = emptyProgress("t");
  p.cards.hut = later;
  p.queue = ["review:hut", "leave"];
  const session: ActiveSession = {
    id: "keep-me",
    started: now,
    steps: [
      { id: "go", kind: "meaning", options: ["go"] },
      { id: "other", kind: "dictation" },
      { id: "leave", kind: "intro" },
      { id: "hut", kind: "meaning", options: ["hut"] },
      { id: "hut", kind: "produce" },
    ],
    index: 1,
    pending: { correct: true, value: "other" },
    graded: { go: Rating.Good },
    newIds: ["leave"],
    reviewIds: ["go", "hut"],
  };
  p.session = session;
  const next = buildPrioritySession(atlas, p, defaultSettings, [
    "hut",
    "leave",
    "leave",
  ])!;
  assert.equal(next.id, session.id);
  assert.equal(next.index, session.index);
  assert.deepEqual(next.pending, session.pending);
  assert.deepEqual(next.graded, session.graded);
  assert.deepEqual(next.steps.slice(0, 2), session.steps.slice(0, 2));
  assert.deepEqual(
    next.steps.slice(2).map((step) => [step.id, step.kind]),
    [
      ["hut", "meaning"],
      ["leave", "intro"],
      ["hut", "produce"],
    ],
  );
  assert.deepEqual(next.newIds, ["leave"]);
  assert.deepEqual(p.session, session);
  assert.equal(
    buildPrioritySession(
      atlas,
      { ...p, session: { ...session, practice: true } },
      defaultSettings,
      ["hut"],
    ),
    null,
  );
});

test("actual learning consumes either queue form and leaves future relearning to FSRS", () => {
  const p = emptyProgress("t");
  p.queue = ["shelter"];
  p.session = buildPrioritySession(atlas, p, defaultSettings, ["shelter"]);
  const next = applyRecallRating(
    atlas,
    p,
    defaultSettings,
    { sessionId: p.session!.id, index: 0, id: "shelter" },
    Rating.Again,
    4,
    now,
  );
  assert.deepEqual(priorityWords(atlas, next), []);
  assert.ok(next.cards.shelter.due > now);
  assert.equal(next.cards.shelter.reps, 1);
  const known: Progress = {
    ...p,
    cards: { hut: later },
    queue: ["review:hut"],
    session: null,
  };
  known.session = buildPrioritySession(atlas, known, defaultSettings, ["hut"]);
  const reviewed = applyRecallRating(
    atlas,
    known,
    defaultSettings,
    { sessionId: known.session!.id, index: 0, id: "hut" },
    Rating.Again,
    4,
    now,
  );
  assert.deepEqual(reviewed.queue, []);
  assert.equal(reviewed.cards.hut.seen, later.seen);
});
