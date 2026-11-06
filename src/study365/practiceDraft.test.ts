import test from "node:test";
import assert from "node:assert/strict";
import {
  PracticeClock,
  localPracticeReferences,
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

test("only this account and plan's valid started drafts pin automatic materials; missing originals remain visible", () => {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const hash = "a".repeat(64), orphanHash = "b".repeat(64);
  const bank = [{ id: "original", version: "1", contentHash: hash, skill: "reading", questions: [{}] }] as import("./localBankSchema").LocalMaterial[];
  const put = (account: string | null, plan: string, contentHash: string, date: string, task: string, startedAt = 100) =>
    savePracticeDraft(practiceDraftKey(account, plan, contentHash, date, task), { answers: ["A"], startedAt }, storage);
  put("a", "p", hash, "2026-11-05", "d1-reading");
  put("b", "p", hash, "2026-11-05", "d1-reading");
  put(null, "p", hash, "2026-11-05", "d1-reading");
  put("a", "other", hash, "2026-11-05", "d1-reading");
  put("a", "p", orphanHash, "2026-11-05", "d2-weak-skill", 110);
  put("a", "p", hash, "2026-02-30", "bad-date");
  put("a", "p", "bad-hash", "2026-11-05", "d1-reading");
  put("a", "p", hash, "2026-11-05", "future", 999);
  values.set("band-lr-draft:broken", "{}");
  const refs = localPracticeReferences("a", "p", bank, storage, 200);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { date: "2026-11-05", taskId: "d2-weak-skill", contentHash: orphanHash, updatedAt: 110 });
  assert.deepEqual(refs[1], { skill: "reading", date: "2026-11-05", taskId: "d1-reading", contentHash: hash, updatedAt: 100, id: "original", version: "1" });
});
