import test from "node:test";
import assert from "node:assert/strict";
import type { Atlas, WordRef } from "../atlas/types";
import type { Progress } from "../store/store";
import {
  recordSpellingMiss,
  spellingContext,
  spellingPool,
} from "./spellingPractice";

const words = ["book", "colour", "accommodation"].map(
  (word, order) => ({ id: word, word, cefr: order, order }) as WordRef,
);
const atlas = {
  words,
  byId: new Map(words.map((word) => [word.id, word])),
} as Atlas;
const progress = {
  cards: { book: { seen: 1, last: 2 }, colour: { seen: 3, last: 4 } },
  skills: { "l:book": { due: 200 } },
  session: { id: "unfinished-review", index: 3 },
  days: { "2026-11-06": { n: 1, r: 3 } },
  typing: [],
  bookmarks: ["colour", "removed"],
  mistakes: ["book", "removed"],
  spell: { double: 2 },
  spellLog: [
    { id: "accommodation", typed: "acommodation", at: 1, tags: ["double"] },
  ],
} as unknown as Progress;

test("spelling sources use real words, deduplicate misses, and honour the starting level", () => {
  assert.deepEqual(spellingPool(atlas, progress, "learned", 0), [
    "colour",
    "book",
  ]);
  assert.deepEqual(spellingPool(atlas, progress, "bookmarks", 0), ["colour"]);
  assert.deepEqual(
    spellingPool(
      atlas,
      { ...progress, mistakes: ["accommodation", "book"] },
      "mistakes",
      0,
    ),
    ["accommodation", "book"],
  );
  assert.deepEqual(spellingPool(atlas, progress, "path", 1), [
    "colour",
    "accommodation",
  ]);
});

test("a spelling miss preserves every FSRS card, day, typing record and unfinished review", () => {
  const before = JSON.stringify(progress);
  const next = recordSpellingMiss(
    progress,
    "accommodation",
    "acommodation",
    "accommodation",
    20,
  );
  for (const key of [
    "cards",
    "skills",
    "session",
    "days",
    "typing",
    "bookmarks",
  ] as const)
    assert.equal(next[key], progress[key], key);
  assert.equal(next.spell.double, 3);
  assert.deepEqual(next.spellLog[0], {
    id: "accommodation",
    typed: "acommodation",
    at: 20,
    tags: ["double"],
  });
  assert.equal(next.mistakes[0], "accommodation");
  assert.equal(
    JSON.stringify(progress),
    before,
    "original state must never be mutated",
  );
});

test("showing an unknown answer is a saved miss without fabricated spelling error tags", () => {
  const next = recordSpellingMiss(progress, "book", "", "book", 21);
  assert.deepEqual(next.spellLog[0].tags, []);
  assert.deepEqual(next.spell, progress.spell);
  assert.equal(next.mistakes.filter((id) => id === "book").length, 1);
});

test("context hides repeated, uppercase and inflected answers, and skips unrelated sentences", () => {
  assert.equal(
    spellingContext("A BOOK and two books.", "book"),
    "A ______ and two ______.",
  );
  assert.equal(spellingContext("Nothing to reveal here.", "book"), null);
});
