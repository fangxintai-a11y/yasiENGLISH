import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { setConfusables } from "../ielts/confusables";
import { buildSession, distractors, quizStep, relearnGap } from "./session";
import { review, Rating } from "./srs";
import { defaultSettings, emptyProgress } from "./store";

test("extra rounds honour the selected count without overwriting the daily quota or existing review", () => {
  const p = emptyProgress("t");
  p.cards.w0 = review(undefined, Rating.Good, Date.now());
  const settings = { ...defaultSettings, dailyNew: 30, examDate: "2020-01-01" };
  const before = structuredClone({ p, settings });
  const round = buildSession(atlas, p, settings, { extraNew: 17 });
  assert.equal(round.newIds.length, 17);
  assert.ok(!round.newIds.includes("w0"));
  assert.equal(round.steps.filter((step) => step.kind === "intro").length, 17);
  assert.deepEqual(round.reviewIds, []);
  assert.equal(buildSession(atlas, p, settings, { extraNew: 100 }).newIds.length, 59);
  for (const extraNew of [0, -1, 1.5, 101, NaN]) assert.equal(buildSession(atlas, p, settings, { extraNew }).steps.length, 0);
  assert.deepEqual({ p, settings }, before);
});

const words: WordRef[] = Array.from({ length: 60 }, (_, i) => ({
  id: `w${i}`,
  word: `word${i}`,
  zh: `n. 词${i}`,
  ipa: "",
  cefr: i % 6,
  topic: 0,
  media: i % 3 === 0 ? 30 : 31, // every third word has no illustration
  order: i,
}));
const atlas = { words, byId: new Map(words.map((w) => [w.id, w])) } as unknown as Atlas;

test("recognition never asks to pick a word from its sound", () => {
  const p = emptyProgress("t");
  const now = Date.UTC(2026, 9, 28);
  // Half the words are steady, so both the new-word and the review branches are exercised.
  for (const w of words.slice(0, 30)) p.cards[w.id] = { ...review(undefined, Rating.Good, now), st: 2, s: 12 };
  const kinds = new Set<string>();
  for (const w of words) for (let salt = 0; salt < 40; salt++) kinds.add(quizStep(atlas, p, w.id, salt).kind);
  for (const w of words) kinds.add(quizStep(atlas, p, w.id, 1, true).kind);
  assert.ok(!kinds.has("listen"), [...kinds].join(","));
  assert.ok(kinds.has("meaning") && kinds.has("picture"));
});

test("a word without an illustration is never asked as a picture question", () => {
  const p = emptyProgress("t");
  for (let salt = 0; salt < 60; salt++) assert.equal(quizStep(atlas, p, "w3", salt).kind, "meaning");
  assert.equal(quizStep(atlas, p, "w3", 0, true).kind, "meaning");
});

test("one successful spaced revisit ends same-round spelling retries, capped at two misses", () => {
  assert.equal(relearnGap(0, 0), 4);
  assert.equal(relearnGap(1, 1), null);
  assert.equal(relearnGap(0, 1), 4);
  assert.equal(relearnGap(0, 2), null);
  assert.equal(relearnGap(0, 6), null);
});

test("a look-alike word is usually one of the wrong options", () => {
  setConfusables({ w10: ["w11"] });
  const ref = words[10];
  let hits = 0;
  for (let seed = 0; seed < 100; seed++) {
    const opts = distractors(atlas, ref, "meaning", seed);
    assert.equal(opts.length, 4);
    assert.ok(opts.includes("w10"));
    if (opts.includes("w11")) hits++;
  }
  assert.ok(hits > 50, `look-alike offered ${hits}/100 times`);
  setConfusables({});
});
