import test from "node:test";
import assert from "node:assert/strict";
import type { Progress, Settings } from "../store/store";
import { todayPlan } from "../ielts/exam";
import { addReadingVocabulary } from "./readingVocabulary";
const DAY = 86400000,
  now = Date.UTC(2026, 10, 4, 4);
function progress(): Progress {
  return {
    version: 2,
    datasetId: "fixture",
    cards: {},
    skills: {},
    bookmarks: [],
    days: {},
    typing: [],
    session: null,
    mistakes: [],
    spell: {},
    spellLog: [],
    placement: null,
    queue: [],
    readings: [],
    shadow: { days: {}, best: 0, done: {} },
    hacks: {},
    flashBest: 0,
  };
}
const settings = {
  targetBand: 8,
  retention: 0.9,
  dailyMinutes: 30,
  dailyNew: 0,
  examDate: "",
  startLevel: 0,
  trackL: false,
  trackP: false,
} as Settings;
const words = [{ id: "target-word", cefr: 3, order: 0 }],
  atlas = { words, byId: new Map(words.map((word) => [word.id, word])) };
test("a new reading error word enters mistakes and a real scheduled card is due in the next-day vocabulary plan", () => {
  const before = progress(),
    raw = JSON.stringify(before),
    next = addReadingVocabulary(before, "target-word", now);
  assert.deepEqual(next.mistakes, ["target-word"]);
  assert.ok(next.cards["target-word"]);
  assert.ok(Number.isFinite(next.cards["target-word"].due));
  assert.ok(
    next.cards["target-word"].due > now &&
      next.cards["target-word"].due <= now + DAY,
  );
  assert.equal(next.cards["target-word"].seen, now);
  assert.equal(JSON.stringify(before), raw);
  assert.ok(
    todayPlan(
      atlas,
      next,
      settings,
      { listening: {}, awl: {} },
      now + DAY,
      0,
    ).due.includes("target-word"),
  );
});
test("adding an already-known word moves it to the front once and retains unrelated progress", () => {
  const initial = progress(),
    first = addReadingVocabulary(initial, "target-word", now);
  first.mistakes = ["old-word", "target-word"];
  first.queue = ["queued-word"];
  first.bookmarks = ["bookmarked-word"];
  const raw = JSON.stringify(first),
    next = addReadingVocabulary(first, "target-word", now + DAY);
  assert.deepEqual(next.mistakes, ["target-word", "old-word"]);
  assert.equal(next.cards["target-word"].seen, now);
  assert.deepEqual(next.queue, ["queued-word"]);
  assert.deepEqual(next.bookmarks, ["bookmarked-word"]);
  assert.equal(JSON.stringify(first), raw);
});
test("rolling vocabulary mistakes retain the newest word and cap at 300 unique entries", () => {
  const initial = progress();
  initial.mistakes = Array.from({ length: 300 }, (_, index) => `word-${index}`);
  const next = addReadingVocabulary(initial, "target-word", now);
  assert.equal(next.mistakes.length, 300);
  assert.equal(next.mistakes[0], "target-word");
  assert.equal(next.mistakes.at(-1), "word-298");
  assert.equal(new Set(next.mistakes).size, 300);
  assert.equal(initial.mistakes.length, 300);
});
