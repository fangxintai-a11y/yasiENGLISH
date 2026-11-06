import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyProgress, defaultSettings, type Progress } from "../store/store";
import { meanRecall, recallAt, review, Rating } from "../store/srs";
import { bandLevel, cardKey, daysLeft, effectiveRetention, examPlan, loadPerNew, parseKey, phaseOf, sprintLength, todayPlan } from "./exam";

const DAY = 86400000;
const words = Array.from({ length: 3000 }, (_, i) => ({ id: `w${i}`, cefr: Math.floor(i / 500), order: i }));
const atlas = { words, byId: new Map(words.map((w) => [w.id, w])) };
const tags = { listening: { w10: "3.1", w20: "3.2" }, awl: { w30: 1 } };
const now = new Date(2026, 9, 27, 20).getTime();
const date = (days: number) => {
  const d = new Date(now + days * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("card keys round-trip", () => {
  assert.equal(cardKey("r", "abandon"), "abandon");
  assert.deepEqual(parseKey(cardKey("l", "abandon")), { track: "l", id: "abandon" });
  assert.deepEqual(parseKey("p:on-line"), { track: "p", id: "on-line" });
});

test("phases follow the calendar", () => {
  assert.equal(daysLeft(date(30), now), 30);
  assert.equal(phaseOf(null), "free");
  assert.equal(phaseOf(60), "learn");
  assert.equal(phaseOf(sprintLength(60)), "sprint");
  assert.equal(phaseOf(-1), "after");
  assert.equal(effectiveRetention({ retention: 0.9, examDate: date(3) }, now), 0.95);
  assert.equal(effectiveRetention({ retention: 0.9, examDate: date(60) }, now), 0.9);
  assert.equal(bandLevel(6.5), 3);
});

test("average recall between reviews sits between the target and 100%", () => {
  const m = meanRecall(0.9);
  assert.ok(m > 0.9 && m < 1, `${m}`);
  assert.ok(meanRecall(0.95) > m);
});

test("each new word per day costs a few reviews per day", () => {
  const l = loadPerNew(60, 0.9);
  assert.ok(l > 2 && l < 12, `${l}`);
  assert.equal(loadPerNew(0, 0.9), 0);
});

test("the plan spreads the remaining target words over the days before the sprint", () => {
  const p = emptyProgress("t");
  const s = { ...defaultSettings, examDate: date(60), targetBand: 6.5, dailyMinutes: 300 };
  const plan = examPlan(atlas, p, s, tags, now);
  // Band 6.5 → up to B2 (levels 0–3) = 2000 words, plus the listening / AWL tags inside them.
  assert.equal(plan.target, 2000);
  assert.equal(plan.need, Math.ceil(2000 / (60 - sprintLength(60))));
  assert.equal(plan.newPerDay, plan.need);
  assert.ok(plan.forecast > 1700 && plan.forecast <= 2000, `${plan.forecast}`);
  assert.equal(plan.ifStop, 0);
});

test("a small time budget caps new words and says how many minutes the full plan needs", () => {
  const s = { ...defaultSettings, examDate: date(60), dailyMinutes: 15 };
  const plan = examPlan(atlas, emptyProgress("t"), s, tags, now);
  assert.ok(plan.newPerDay < plan.need);
  assert.ok(plan.minutesNeeded > 15);
  assert.ok(plan.forecast < plan.target);
});

function withCards(n: number, dueOffsetDays: number): Progress {
  const p = emptyProgress("t");
  for (let i = 0; i < n; i++) {
    let c = review(undefined, Rating.Good, now - 30 * DAY);
    c = review(c, Rating.Good, now - 20 * DAY);
    p.cards[`w${i}`] = { ...c, due: now + dueOffsetDays * DAY };
  }
  return p;
}

test("a backlog never grows the day: reviews are capped by minutes and new words pause", () => {
  const p = withCards(800, -2);
  const s = { ...defaultSettings, dailyMinutes: 20 };
  const t = todayPlan(atlas, p, s, tags, now, 0);
  assert.ok(t.backlog);
  assert.equal(t.fresh.length, 0);
  assert.ok(t.due.length < 800 && t.due.length > 50, `${t.due.length}`);
  assert.equal(t.deferred, 800 - t.due.length);
  assert.ok(t.minutes <= 21, `${t.minutes}`);
});

test("most urgent and most important cards come first", () => {
  const p = emptyProgress("t");
  const base = review(undefined, Rating.Good, now - 40 * DAY);
  // Same card shape, different time since review: the one reviewed longer ago is more forgotten.
  p.cards.w1 = { ...base, s: 10, st: 2, last: now - 30 * DAY, due: now - 20 * DAY };
  p.cards.w2 = { ...base, s: 10, st: 2, last: now - 11 * DAY, due: now - DAY };
  p.cards.w2999 = { ...base, s: 10, st: 2, last: now - 30 * DAY, due: now - 20 * DAY };
  const t = todayPlan(atlas, p, { ...defaultSettings, targetBand: 6.5 }, tags, now, 0);
  // w2999 is outside the band 6.5 target, so it waits even though it is more forgotten than w2.
  assert.deepEqual(t.due, ["w1", "w2", "w2999"]);
  assert.ok(recallAt(p.cards.w1, now) < recallAt(p.cards.w2, now));
});

test("steady recognition unlocks listening and production cards", () => {
  const p = emptyProgress("t");
  const steady = { ...review(undefined, Rating.Good, now - 30 * DAY), st: 2 as const, s: 12, due: now + 5 * DAY, last: now - DAY };
  p.cards.w10 = steady;
  p.cards.w30 = steady;
  const t = todayPlan(atlas, p, defaultSettings, tags, now, 0);
  assert.deepEqual(t.unlock.sort(), ["l:w10", "p:w30"]);
  const off = todayPlan(atlas, p, { ...defaultSettings, trackL: false, trackP: false }, tags, now, 0);
  assert.deepEqual(off.unlock, []);
});

test("imported words are learned before the regular path", () => {
  const p = { ...emptyProgress("t"), queue: ["w2500", "w2400"] };
  const t = todayPlan(atlas, p, { ...defaultSettings, dailyNew: 5 }, tags, now, 0);
  assert.deepEqual(t.fresh.slice(0, 2), ["w2500", "w2400"]);
});
