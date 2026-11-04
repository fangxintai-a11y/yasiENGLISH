import test from "node:test";
import assert from "node:assert/strict";
import {
  PracticeClock,
  practiceDraftKey,
  readPracticeDraft,
  savePracticeDraft,
  clearPracticeDraft,
} from "./practiceDraft";
test("T7: pending answers and initial timer survive reload, isolated by account and material hash", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const a = practiceDraftKey(
      "a",
      "p",
      "a".repeat(64),
      "2026-11-04",
      "d1-listening",
    ),
    b = practiceDraftKey(
      "b",
      "p",
      "a".repeat(64),
      "2026-11-04",
      "d1-listening",
    );
  savePracticeDraft(a, { answers: ["A", "word"], startedAt: 100 }, storage);
  assert.deepEqual(readPracticeDraft(a, 2, storage, 200), {
    answers: ["A", "word"],
    startedAt: 100,
    activeSeconds: 0,
  });
  assert.equal(readPracticeDraft(b, 2, storage, 200), null);
  assert.equal(readPracticeDraft(a, 3, storage, 200), null);
  assert.equal(readPracticeDraft(a, 2, storage, 50), null);
  clearPracticeDraft(a, storage);
  assert.equal(readPracticeDraft(a, 2, storage, 200), null);
});

test("T7: leaving the page does not count the interval away as study time", () => {
  const clock = new PracticeClock(2, 1000);
  assert.equal(clock.value(2000), 3);
  clock.pause(2000);
  assert.equal(clock.value(999000), 3);
  clock.resume(999000);
  assert.equal(clock.value(1000000), 4);
});
