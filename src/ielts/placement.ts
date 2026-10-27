import { hashSeed, shuffle } from "../lib/text";
import { seedKnown, type CardState } from "../store/srs";
import type { AtlasLite } from "./exam";

/**
 * Three-minute placement: 6 words per CEFR level, starting at B1 and walking up or down.
 * Levels the learner clearly knows are not taught again; their words get one spot check each,
 * spread over the coming weeks, so a forgotten word still comes back into the plan.
 */

export const PER_LEVEL = 6;
const LEVELS = 6;

export interface PlacementState {
  /** Level being asked now, or null when finished. */
  level: number | null;
  asked: Record<number, string[]>;
  known: Record<number, number>;
  /** Words the learner answered correctly (seeded individually as verified). */
  right: string[];
}

export const startPlacement = (): PlacementState => ({ level: 2, asked: {}, known: {}, right: [] });

/** Words for one level: a spread sample, not just the first rows of the path. */
export function sampleLevel(atlas: AtlasLite, level: number, seed: number) {
  const pool = atlas.words.filter((w) => w.cefr === level).map((w) => w.id);
  return shuffle(pool, seed + level * 7919).slice(0, PER_LEVEL);
}

/** Record a finished level and decide where to go next. */
export function nextLevel(st: PlacementState, level: number, words: string[], right: string[]): PlacementState {
  const asked = { ...st.asked, [level]: words };
  const known = { ...st.known, [level]: right.length };
  const allRight = [...st.right, ...right];
  const done = (l: number) => l in asked;
  const k = right.length;
  const strong = PER_LEVEL - 1;
  let next: number | null = null;
  // Walk up from B1 while at least 4 of 6 are known; then walk down if B1 itself was shaky.
  if (level >= 2 && k >= 4 && level + 1 < LEVELS && !done(level + 1)) next = level + 1;
  else if (known[2] < strong && !done(1)) next = 1;
  else if (level === 1 && k < strong && !done(0)) next = 0;
  return { level: next, asked, known, right: allRight };
}

/** Estimated share of known words per level, filling the levels that were not asked. */
export function levelShares(st: PlacementState) {
  const out: number[] = new Array(LEVELS).fill(0);
  const askedLevels = Object.keys(st.asked)
    .map(Number)
    .sort((a, b) => a - b);
  if (!askedLevels.length) return out;
  for (const l of askedLevels) out[l] = (st.known[l] + 0.5) / (PER_LEVEL + 1);
  const lo = askedLevels[0];
  const hi = askedLevels[askedLevels.length - 1];
  for (let l = 0; l < lo; l++) out[l] = Math.max(out[lo], 0.93);
  for (let l = hi + 1; l < LEVELS; l++) out[l] = Math.min(out[hi], 0.12) * (1 - (l - hi) * 0.25);
  return out.map((x) => Math.max(0, Math.min(1, x)));
}

export function estimateKnown(atlas: AtlasLite, shares: number[]) {
  const counts = new Array(LEVELS).fill(0);
  for (const w of atlas.words) counts[w.cefr]++;
  return Math.round(counts.reduce((s, n, l) => s + n * shares[l], 0));
}

/** First level the learner does not yet know well: the learning path starts there. */
export const startLevelFrom = (shares: number[]) => {
  const i = shares.findIndex((x) => x < 0.85);
  return i === -1 ? LEVELS - 1 : i;
};

const DAY = 86400000;

/**
 * Cards for known words. Levels at ≥85% are seeded whole; verified answers are seeded with a
 * longer first interval. Spot checks are spread over `spreadDays` so they never arrive at once.
 */
export function seedCards(atlas: AtlasLite, shares: number[], right: string[], existing: Record<string, CardState>, now: number, spreadDays: number) {
  const out: Record<string, CardState> = {};
  const spread = Math.max(14, Math.min(90, spreadDays));
  const picks: [string, number][] = [];
  for (const w of atlas.words) {
    if (existing[w.id]) continue;
    const share = shares[w.cefr];
    if (share >= 0.85) picks.push([w.id, 20 + (share - 0.85) * 200]);
  }
  for (const id of right) if (!existing[id] && atlas.byId.has(id) && !picks.some(([x]) => x === id)) picks.push([id, 30]);
  // Even spacing in a shuffled order: every day gets the same small share of spot checks.
  const order = shuffle(picks, hashSeed(String(now)));
  order.forEach(([id, s], i) => {
    const day = 3 + ((i + 0.5) / order.length) * (spread - 3);
    out[id] = seedKnown(now, now + Math.round(day * DAY), s);
  });
  return out;
}
