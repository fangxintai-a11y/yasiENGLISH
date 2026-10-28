import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSyllableEnd, parseSyllables, pieceStarts, syllableTimes } from "./syllables";

test("stress marks are lifted out and separators kept", () => {
  assert.deepEqual(parseSyllables("en·ˈvi·ron·ment"), [{ text: "en" }, { text: "vi", stress: true }, { text: "ron" }, { text: "ment" }]);
  assert.deepEqual(
    parseSyllables("ˈmoth·er-in-law").map((p) => p.text),
    ["moth", "er", "-", "in", "-", "law"],
  );
  assert.equal(parseSyllables("ˈmoth·er-in-law")[2].gap, true);
});

test("syllable times cover the recording in order", () => {
  const t = syllableTimes(parseSyllables("ˈcom·fort·a·ble"));
  assert.equal(t.length, 4);
  for (let i = 1; i < t.length; i++) assert.ok(Math.abs(t[i][0] - t[i - 1][1]) < 1e-9);
  assert.ok(t[0][0] > 0 && t[3][1] < 1);
  // The stressed first syllable gets more time than the short "a".
  assert.ok(t[0][1] - t[0][0] > t[2][1] - t[2][0]);
});

test("a hint reveals the word one syllable at a time", () => {
  const p = parseSyllables("en·ˈvi·ron·ment");
  assert.deepEqual(pieceStarts(p), [0, 2, 4, 7]);
  assert.equal(nextSyllableEnd(p, 0), 2);
  assert.equal(nextSyllableEnd(p, 1), 2);
  assert.equal(nextSyllableEnd(p, 2), 4);
  assert.equal(nextSyllableEnd(p, 5), 7);
  // A hyphen comes along with the syllable before it.
  assert.equal(nextSyllableEnd(parseSyllables("ˈmoth·er-in-law"), 4), 7);
});
