import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { setConfusables } from "../ielts/confusables";
import { distractors, quizStep, relearnGap } from "./session";
import { review, Rating } from "./srs";
import { emptyProgress } from "./store";

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

test("a missed word comes back, later each time, until it is right three times in a row", () => {
  assert.equal(relearnGap(0, 0), 3);
  assert.equal(relearnGap(1, 1), 6);
  assert.equal(relearnGap(2, 2), 10);
  assert.equal(relearnGap(3, 3), null);
  // A miss on a retry starts the run again; the cap keeps a hopeless word from taking over.
  assert.equal(relearnGap(0, 4), 3);
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
