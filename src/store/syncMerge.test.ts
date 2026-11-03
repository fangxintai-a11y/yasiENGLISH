import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, emptyProgress, type Reading } from "./store";
import type { CardState } from "./srs";
import { mergeSnapshots, type SyncSnapshot } from "./syncMerge";

const snapshot = (): SyncSnapshot => ({ progress: emptyProgress("word-atlas-open"), settings: { ...defaultSettings } });
const copy = <T>(value: T): T => structuredClone(value);
const card = (last = 10, reps = 1): CardState => ({ due: last + 100, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps, lapses: 0, st: 2, last, seen: 1 });
const day = (r: number) => ({ n: 0, r, c: r, t: r * 10 });

test("independent offline reviews preserve cards, skills and add only deltas since the shared base", () => {
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  base.progress.spell.double = 2;
  base.progress.shadow = { days: { "2026-11-02": 4 }, best: 3, done: { "a:0": { n: 4, good: 2, at: 10 } } };
  const local = copy(base);
  const remote = copy(base);
  local.progress.cards.phone = card(20);
  remote.progress.cards.desktop = card(30);
  local.progress.skills["l:phone"] = card(20);
  remote.progress.skills["p:desktop"] = card(30);
  local.progress.days["2026-11-02"] = day(12);
  remote.progress.days["2026-11-02"] = day(13);
  local.progress.spell.double = 3;
  remote.progress.spell.double = 4;
  local.progress.shadow.days["2026-11-02"] = 5;
  remote.progress.shadow.days["2026-11-02"] = 6;
  local.progress.shadow.done["a:0"] = { n: 5, good: 3, at: 20 };
  remote.progress.shadow.done["a:0"] = { n: 6, good: 3, at: 30 };
  const merged = mergeSnapshots(base, local, remote);
  assert.deepEqual(Object.keys(merged.progress.cards).sort(), ["desktop", "phone"]);
  assert.deepEqual(Object.keys(merged.progress.skills).sort(), ["l:phone", "p:desktop"]);
  assert.deepEqual(merged.progress.days["2026-11-02"], day(15));
  assert.equal(merged.progress.spell.double, 5);
  assert.equal(merged.progress.shadow.days["2026-11-02"], 7);
  assert.deepEqual(merged.progress.shadow.done["a:0"], { n: 7, good: 4, at: 30 });
  assert.deepEqual(base.progress.days["2026-11-02"], day(10), "does not mutate the ancestor");
});

test("the same card keeps the complete most recently reviewed FSRS state", () => {
  const base = snapshot();
  base.progress.cards.a = card();
  const local = copy(base);
  const remote = copy(base);
  local.progress.cards.a = { ...card(20, 2), s: 9 };
  remote.progress.cards.a = { ...card(30, 3), s: 1, lapses: 1 };
  const result = mergeSnapshots(base, local, remote);
  assert.deepEqual(result.progress.cards.a, remote.progress.cards.a);
  assert.deepEqual(mergeSnapshots(base, remote, local).progress.cards.a, result.progress.cards.a);
});

test("acknowledging a merged snapshot makes repeated pulls idempotent", () => {
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  const local = copy(base);
  const remote = copy(base);
  local.progress.cards.a = card(20);
  local.progress.days["2026-11-02"] = day(11);
  remote.progress.cards.b = card(30);
  remote.progress.days["2026-11-02"] = day(12);
  const merged = mergeSnapshots(base, local, remote);
  assert.equal(merged.progress.days["2026-11-02"].r, 13);
  assert.deepEqual(mergeSnapshots(merged, merged, merged), merged);
  const newerRemote = copy(merged);
  newerRemote.progress.days["2026-11-02"] = day(14);
  assert.equal(mergeSnapshots(merged, merged, newerRemote).progress.days["2026-11-02"].r, 14);
});

test("concurrent equal-sized counter increments still add when the devices learned different words", () => {
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(3);
  const local = copy(base);
  const remote = copy(base);
  local.progress.cards.a = card(20);
  remote.progress.cards.b = card(30);
  local.progress.days["2026-11-02"] = day(4);
  remote.progress.days["2026-11-02"] = day(4);
  assert.equal(mergeSnapshots(base, local, remote).progress.days["2026-11-02"].r, 5);
});

test("the first counters of a new day add from a known zero ancestor, even for equal snapshots", () => {
  const base = snapshot();
  const local = copy(base);
  const remote = copy(base);
  local.progress.days["2026-11-02"] = day(1);
  remote.progress.days["2026-11-02"] = day(1);
  local.progress.spell.double = 1;
  remote.progress.spell.double = 1;
  local.progress.shadow.days["2026-11-02"] = 1;
  remote.progress.shadow.days["2026-11-02"] = 1;
  local.progress.shadow.done["a:0"] = { n: 1, good: 1, at: 20 };
  remote.progress.shadow.done["a:0"] = { n: 1, good: 1, at: 20 };
  const merged = mergeSnapshots(base, local, remote);
  assert.equal(merged.progress.days["2026-11-02"].r, 2);
  assert.equal(merged.progress.spell.double, 2);
  assert.equal(merged.progress.shadow.days["2026-11-02"], 2);
  assert.equal(merged.progress.shadow.done["a:0"].n, 2);
});

test("bookmark removal and consumed queue entries are not resurrected by an unchanged device", () => {
  const base = snapshot();
  base.progress.bookmarks = ["remove", "keep"];
  base.progress.queue = ["learned", "waiting"];
  const local = copy(base);
  const remote = copy(base);
  local.progress.bookmarks = ["keep", "local"];
  remote.progress.bookmarks.push("remote");
  local.progress.queue = ["waiting"];
  remote.progress.queue.push("new");
  const merged = mergeSnapshots(base, local, remote);
  assert.deepEqual(merged.progress.bookmarks, ["keep", "local", "remote"]);
  assert.deepEqual(merged.progress.queue, ["waiting", "new"]);
});

test("first connection conservatively combines historical counts without summing overlapping history", () => {
  const local = snapshot();
  const remote = snapshot();
  local.progress.cards.a = card(20);
  remote.progress.cards.b = card(30);
  local.progress.days["2026-11-02"] = day(8);
  remote.progress.days["2026-11-02"] = day(10);
  local.settings.targetBand = 6;
  remote.settings.targetBand = 7;
  const merged = mergeSnapshots(null, local, remote);
  assert.equal(merged.progress.days["2026-11-02"].r, 10);
  assert.equal(Object.keys(merged.progress.cards).length, 2);
  assert.equal(merged.settings.targetBand, 7, "a new device cannot replace the server's exam plan with defaults");
});

test("independent settings edits merge field by field", () => {
  const base = snapshot();
  const local = copy(base);
  const remote = copy(base);
  local.settings.dailyMinutes = 45;
  remote.settings.targetBand = 7;
  remote.settings.examDate = "2027-01-10";
  const merged = mergeSnapshots(base, local, remote);
  assert.equal(merged.settings.dailyMinutes, 45);
  assert.equal(merged.settings.targetBand, 7);
  assert.equal(merged.settings.examDate, "2027-01-10");
});

test("reset removes unchanged old records while preserving concurrent new study", () => {
  const base = snapshot();
  base.progress.cards.old = card();
  base.progress.days["2026-11-01"] = day(10);
  base.progress.flashBest = 20;
  const local = snapshot();
  const remote = copy(base);
  remote.progress.cards.new = card(30);
  remote.progress.days["2026-11-02"] = day(1);
  const merged = mergeSnapshots(base, local, remote);
  assert.deepEqual(Object.keys(merged.progress.cards), ["new"]);
  assert.deepEqual(Object.keys(merged.progress.days), ["2026-11-02"]);
  assert.equal(merged.progress.flashBest, 0);
});

test("typing logs deduplicate and reading answers edited on different devices are retained", () => {
  const base = snapshot();
  const reading: Reading = { id: "r1", at: 10, title: "Study", passage: "A passage", zh: "译文", words: [], questions: [], answers: [null, null] };
  base.progress.readings = [reading];
  base.progress.typing = [{ at: 10, mode: "word", items: 5, wpm: 20, accuracy: 100 }];
  const local = copy(base);
  const remote = copy(base);
  local.progress.readings[0].answers[0] = "TRUE";
  remote.progress.readings[0].answers[1] = "FALSE";
  local.progress.typing.push({ at: 20, mode: "word", items: 5, wpm: 30, accuracy: 100 });
  remote.progress.typing.push({ at: 30, mode: "sentence", items: 1, wpm: 40, accuracy: 90 });
  const merged = mergeSnapshots(base, local, remote);
  assert.deepEqual(merged.progress.readings[0].answers, ["TRUE", "FALSE"]);
  assert.deepEqual(merged.progress.typing.map((t) => t.at), [10, 20, 30]);
});

test("snapshot excludes active sessions and unrecognized top-level fields", () => {
  const local = snapshot();
  local.progress.session = { id: "quiz", started: 10, steps: [], index: 0, graded: {}, newIds: [], reviewIds: [] };
  Object.assign(local.settings, { apiKey: "must-stay-local" });
  Object.assign(local.progress, { recordings: "must-stay-local" });
  const merged = mergeSnapshots(null, local, null);
  assert.equal(merged.progress.session, null);
  assert.equal(Object.hasOwn(merged.settings, "apiKey"), false);
  assert.equal(Object.hasOwn(merged.progress, "recordings"), false);
  assert.ok(local.progress.session, "the local active session is not mutated");
});

test("different datasets never merge", () => {
  const remote = snapshot();
  remote.progress.datasetId = "another-dataset";
  assert.throws(() => mergeSnapshots(null, snapshot(), remote), /不同词库/);
});

test("feedback mode merges by the same three-way rules and obsolete model IDs are never projected", () => {
  const base = snapshot(), local = copy(base), remote = copy(base);
  local.settings.feedbackMode = "manual";
  remote.settings.dailyNew = 20;
  Object.assign(local.settings, { aiModel: "legacy-model-id" });
  Object.assign(remote.settings, { aiModel: "legacy-remote-id" });
  const merged = mergeSnapshots(base, local, remote);
  assert.equal(merged.settings.feedbackMode, "manual"); assert.equal(merged.settings.dailyNew, 20);
  assert.equal(Object.hasOwn(merged.settings, "aiModel"), false);
  assert.equal(Object.hasOwn(mergeSnapshots(null, local, null).settings, "aiModel"), false);
  assert.equal(mergeSnapshots(null, local, null).settings.feedbackMode, "manual");
});
