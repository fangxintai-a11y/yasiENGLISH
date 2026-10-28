import assert from "node:assert/strict";
import { test } from "node:test";
import { review, Rating } from "../store/srs";
import { DAY, emptyShadow, firstLetters, heardScore, heardWords, pickSentences, sentenceKey, shadowDue, tokens, wordTimes } from "./shadow";

const now = Date.UTC(2026, 9, 28, 12);

test("first letters keep punctuation and one-letter words", () => {
  assert.equal(firstLetters("I went to the library, didn't I?"), "I w___ t_ t__ l______, d___'_ I?");
});

test("tokens normalise case, punctuation, apostrophes and small numbers", () => {
  assert.deepEqual(tokens("It’s 5 o'clock — well-known!"), ["it's", "five", "o'clock", "well", "known"]);
});

test("heardWords lines up a spoken attempt with the text", () => {
  const t = "Renewable energy is the key to a sustainable future.";
  assert.deepEqual(heardWords(t, "renewable energy is key to a sustainable future"), [true, true, true, false, true, true, true, true, true]);
  // Extra words and a swapped one cost only themselves.
  assert.deepEqual(heardWords(t, "um renewable energy is the key to a stable future"), [true, true, true, true, true, true, true, false, true]);
  assert.equal(heardScore(t, ""), 0);
  assert.equal(heardScore(t, "Renewable energy is the key to a sustainable future"), 100);
});

test("word times run in order and leave room for pauses", () => {
  const t = wordTimes("Yes, it works. Really well");
  assert.equal(t.length, 5);
  for (let i = 1; i < t.length; i++) assert.ok(t[i][0] >= t[i - 1][1]);
  // The full stop after "works." leaves a gap.
  assert.ok(t[3][0] - t[2][1] > 0.02);
  assert.ok(t[0][0] > 0 && t[4][1] <= 1);
});

test("sentences come back spaced out by how often they went well", () => {
  assert.equal(shadowDue(undefined, now), true);
  assert.equal(shadowDue({ n: 1, at: now - 2 * 3600e3, good: 0 }, now), false);
  assert.equal(shadowDue({ n: 1, at: now - DAY, good: 1 }, now), true);
  assert.equal(shadowDue({ n: 2, at: now - 2 * DAY, good: 2 }, now), false);
  assert.equal(shadowDue({ n: 2, at: now - 3 * DAY, good: 2 }, now), true);
});

test("a round starts with the words just learned, IELTS sentence first, one per word", () => {
  const words = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, media: id === "b" ? 8 : 24 }));
  const cards = {
    a: { ...review(undefined, Rating.Good, now - 3 * DAY), last: now - 3 * DAY },
    b: { ...review(undefined, Rating.Good, now - DAY), last: now - DAY },
  };
  const shadow = emptyShadow();
  const picked = pickSentences(words, cards, shadow, now, 4);
  // b was learned last but only its everyday sentence is recorded.
  assert.deepEqual(picked.slice(0, 2), [{ id: "b", i: 0 }, { id: "a", i: 1 }]);
  // Filled from the path with words not learned yet.
  assert.deepEqual(picked.slice(2), [{ id: "c", i: 1 }, { id: "d", i: 1 }]);
  assert.equal(new Set(picked.map((r) => r.id)).size, picked.length);
});

test("a sentence practised today is not picked again; a due one is", () => {
  const words = ["a", "b", "c"].map((id) => ({ id, media: 24 }));
  const cards = { a: { ...review(undefined, Rating.Good, now), last: now } };
  const shadow = emptyShadow();
  shadow.done[sentenceKey({ id: "a", i: 1 })] = { n: 1, at: now - 3600e3, good: 1 };
  shadow.done[sentenceKey({ id: "c", i: 0 })] = { n: 1, at: now - 2 * DAY, good: 1 };
  const picked = pickSentences(words, cards, shadow, now, 3);
  // a's IELTS sentence is resting, so its everyday one comes up; c's due sentence comes back.
  assert.deepEqual(picked, [{ id: "a", i: 0 }, { id: "c", i: 0 }, { id: "b", i: 1 }]);
});

test("words just studied come first when a round is started from a session", () => {
  const words = ["a", "b", "c", "d"].map((id) => ({ id, media: 24 }));
  const cards = { a: { ...review(undefined, Rating.Good, now), last: now } };
  const picked = pickSentences(words, cards, emptyShadow(), now, 3, 0, ["d", "c"]);
  assert.deepEqual(picked, [{ id: "d", i: 1 }, { id: "c", i: 1 }, { id: "a", i: 1 }]);
});
