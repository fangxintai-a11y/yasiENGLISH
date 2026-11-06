import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { applyRecallRating, withDueRecall, sessionStats } from "./session";
import { preview, Rating, review } from "./srs";
import { dayKey, defaultSettings, emptyProgress } from "./store";

const now = Date.UTC(2026, 10, 7, 8);
const words = ["new", "other", "old"].map((id, order) => ({
  id,
  word: id,
  zh: id,
  ipa: "",
  cefr: 2,
  topic: 0,
  media: 0,
  order,
})) satisfies WordRef[];
const atlas = {
  words,
  byId: new Map(words.map((word) => [word.id, word])),
} as Atlas;
const settings = { ...defaultSettings, examDate: "", dailyNew: 2 };
const expected = { sessionId: "recall-round", index: 0, id: "new" };
function fixture() {
  const p = emptyProgress("t");
  p.cards.old = { ...review(undefined, Rating.Good, now), due: now - 60000 };
  p.skills["l:new"] = review(undefined, Rating.Good, now);
  p.skills["p:other"] = review(undefined, Rating.Good, now);
  p.session = {
    id: expected.sessionId,
    started: now,
    steps: [
      { id: "new", kind: "intro" },
      { id: "other", kind: "intro" },
      { id: "new", kind: "meaning", options: ["new", "other", "old"] },
      { id: "new", kind: "produce" },
    ],
    index: 0,
    graded: {},
    newIds: ["new", "other"],
    reviewIds: [],
  };
  return p;
}

test("three recall choices use real FSRS steps, count a new word once and preserve unrelated data", () => {
  const intervals = [];
  for (const grade of [Rating.Again, Rating.Hard, Rating.Good] as const) {
    const p = fixture(),
      original = structuredClone(p);
    const next = applyRecallRating(
      atlas,
      p,
      settings,
      expected,
      grade,
      12,
      now,
    );
    const c = next.cards.new;
    intervals.push(c.due - now);
    assert.equal(c.due - now, preview(undefined, now)[grade]);
    assert.equal(c.reps, 1);
    assert.equal(c.seen, now);
    assert.equal(
      c.src,
      undefined,
      "self-rating never pretends to be a placement result",
    );
    assert.equal(next.session!.graded.new, grade);
    assert.deepEqual(next.days[dayKey(new Date(now))], {
      n: 1,
      r: 1,
      c: grade === Rating.Again ? 0 : 1,
      t: 12,
    });
    assert.deepEqual(next.session!.newIds, p.session!.newIds);
    assert.deepEqual(
      next.session!.steps.map((step) => [step.id, step.kind]),
      [
        ["new", "intro"],
        ["other", "intro"],
        ["new", "produce"],
      ],
    );
    assert.deepEqual(next.skills, p.skills);
    assert.deepEqual(next.cards.old, p.cards.old);
    assert.deepEqual(next.spellLog, p.spellLog);
    assert.deepEqual(p, original);
    assert.equal(
      applyRecallRating(atlas, next, settings, expected, grade, 12, now),
      next,
      "a stale/double click cannot grade the next word",
    );
  }
  assert.ok(intervals[0] < intervals[1] && intervals[1] < intervals[2]);
});

test("a forgotten word returns only when due and subsequent ratings update FSRS without recounting it as new", () => {
  const first = applyRecallRating(
    atlas,
    fixture(),
    settings,
    expected,
    Rating.Again,
    8,
    now,
  );
  assert.deepEqual(first.mistakes, ["new"]);
  assert.equal(withDueRecall(atlas, first, now + 59000), first);
  const dueAt = first.cards.new.due;
  const returned = withDueRecall(atlas, first, dueAt);
  assert.equal(returned.session!.steps[returned.session!.index].id, "new");
  assert.equal(
    returned.session!.steps[returned.session!.index].kind,
    "meaning",
  );
  assert.equal(
    returned.session!.steps.some((step) => step.id === "old"),
    false,
    "don't drag in an unrelated backlog",
  );
  const next = applyRecallRating(
    atlas,
    returned,
    settings,
    { ...expected, index: returned.session!.index },
    Rating.Good,
    6,
    dueAt,
  );
  assert.equal(next.cards.new.reps, 2);
  assert.equal(next.cards.new.last, dueAt);
  assert.ok(next.cards.new.due > dueAt);
  assert.equal(
    next.session!.graded.new,
    Rating.Again,
    "first-answer history is retained",
  );
  assert.equal(sessionStats(next.session!).correct, 0);
  assert.equal(next.days[dayKey(new Date(now))].n, 1);
  assert.equal(next.days[dayKey(new Date(now))].r, 2);
  assert.deepEqual(next.skills, first.skills);
  assert.deepEqual(next.mistakes, ["new"]);
});

test("reviews of known cards can lapse and become short-term without modifying their first-seen time", () => {
  const p = fixture();
  let c = review(undefined, Rating.Good, now - 50 * 86400000);
  for (let i = 0; i < 5; i++)
    c = review(c, Rating.Good, Math.max(c.due, c.last! + 86400000));
  p.cards.new = c;
  p.session!.steps[0] = { id: "new", kind: "meaning", options: ["new"] };
  p.session!.newIds = [];
  const at = Math.max(now, c.due);
  const next = applyRecallRating(
    atlas,
    p,
    settings,
    expected,
    Rating.Again,
    4,
    at,
  );
  assert.equal(next.cards.new.lapses, c.lapses + 1);
  assert.ok(next.cards.new.s < c.s);
  assert.ok(next.cards.new.due - at <= 10 * 60000);
  assert.equal(next.cards.new.seen, c.seen);
  assert.equal(next.days[dayKey(new Date(at))].n, 0);
});

test("a newly recalled word graduates to days after its short-term confirmation", () => {
  const first = applyRecallRating(
    atlas,
    fixture(),
    settings,
    expected,
    Rating.Good,
    5,
    now,
  );
  const returned = withDueRecall(atlas, first, first.cards.new.due);
  const next = applyRecallRating(
    atlas,
    returned,
    settings,
    { ...expected, index: returned.session!.index },
    Rating.Good,
    5,
    first.cards.new.due,
  );
  assert.equal(next.cards.new.st, 2);
  assert.ok(next.cards.new.due - first.cards.new.due >= 86400000);
});

test("practice stays isolated, pending old results survive, and an invalid grade cannot alter a card", () => {
  const p = fixture();
  p.session!.practice = true;
  const next = applyRecallRating(
    atlas,
    p,
    settings,
    expected,
    Rating.Again,
    8,
    now,
  );
  assert.equal(next.session!.index, 1);
  for (const key of [
    "cards",
    "skills",
    "days",
    "mistakes",
    "spellLog",
  ] as const)
    assert.deepEqual(next[key], p[key], key);
  assert.equal(withDueRecall(atlas, next, now + 3600000), next);
  const pending = fixture();
  pending.session!.pending = { correct: false, value: "other" };
  assert.equal(
    applyRecallRating(atlas, pending, settings, expected, Rating.Good, 8, now),
    pending,
  );
  assert.equal(
    applyRecallRating(
      atlas,
      fixture(),
      settings,
      expected,
      Rating.Easy as 3,
      8,
      now,
    ).cards.new,
    undefined,
  );
});
