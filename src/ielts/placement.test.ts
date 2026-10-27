import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateKnown, levelShares, nextLevel, PER_LEVEL, sampleLevel, seedCards, startLevelFrom, startPlacement } from "./placement";

const words = Array.from({ length: 600 }, (_, i) => ({ id: `w${i}`, cefr: Math.floor(i / 100), order: i }));
const atlas = { words, byId: new Map(words.map((w) => [w.id, w])) };
const DAY = 86400000;

function run(scores: Record<number, number>) {
  let st = startPlacement();
  const order: number[] = [];
  while (st.level !== null) {
    const level = st.level;
    order.push(level);
    const asked = sampleLevel(atlas, level, 1);
    st = nextLevel(st, level, asked, asked.slice(0, scores[level] ?? 0));
  }
  return { st, order };
}

test("an advanced learner climbs from B1 and stops where it gets hard", () => {
  const { st, order } = run({ 2: 6, 3: 5, 4: 2, 5: 0 });
  assert.deepEqual(order, [2, 3, 4]);
  const shares = levelShares(st);
  assert.ok(shares[0] > 0.9 && shares[1] > 0.9);
  assert.equal(startLevelFrom(shares), 3);
});

test("a beginner walks down to A1", () => {
  const { order, st } = run({ 2: 1, 1: 3, 0: 5 });
  assert.deepEqual(order, [2, 1, 0]);
  assert.equal(startLevelFrom(levelShares(st)), 0);
});

test("never asks more than one round per level", () => {
  const { order } = run({ 0: 6, 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 });
  assert.deepEqual(order, [2, 3, 4, 5]);
  assert.ok(order.length * PER_LEVEL <= 36);
});

test("known levels are seeded as spot checks spread over the coming weeks", () => {
  const { st } = run({ 2: 6, 3: 3 });
  const shares = levelShares(st);
  const now = Date.UTC(2026, 9, 27);
  const seeded = seedCards(atlas, shares, st.right, {}, now, 60);
  const ids = Object.keys(seeded);
  // A1–B1 are known: 300 words, plus correct answers from B2.
  assert.ok(ids.length >= 300 && ids.length <= 310, `${ids.length}`);
  const dues = Object.values(seeded).map((c) => (c.due - now) / DAY);
  assert.ok(Math.min(...dues) >= 3 && Math.max(...dues) <= 60);
  // No single day gets more than a small slice of the checks.
  const perDay = new Map<number, number>();
  dues.forEach((d) => perDay.set(Math.floor(d), (perDay.get(Math.floor(d)) ?? 0) + 1));
  assert.ok(Math.max(...perDay.values()) < 20);
  assert.ok(estimateKnown(atlas, shares) > 300);
});
