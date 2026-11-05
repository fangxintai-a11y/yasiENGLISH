import type { ShadowDone } from "../ielts/shadow";
import type { CardState } from "./srs";
import type { DayStat, Progress, Reading, Settings } from "./store";

/** Only this projection is synced. Recordings, API keys and the active quiz stay on the device. */
export type SyncSnapshot = { progress: Progress; settings: Settings };

const SETTINGS_FIELDS = [
  "accent", "autoplay", "dailyNew", "retention", "theme", "sfx", "spell", "startLevel", "onboarded", "dataset",
  "ambience", "ambienceVolume", "splash", "guessFirst", "sentenceFirst", "examDate", "dailyMinutes", "targetBand",
  "trackL", "trackP", "feedbackMode", "shadowAsr",
] as const satisfies readonly (keyof Settings)[];

// Canonical comparison also handles maps whose insertion order differs between devices.
function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

const equal = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);

/** Unchanged values defer to the other device; concurrent scalar edits prefer this device. */
function scalar<T>(base: T | undefined, local: T, remote: T): T {
  return base !== undefined && equal(local, base) ? remote : local;
}

/** Keep a whole FSRS card together: mixing fields would produce an invalid scheduler state. */
function latest<T>(local: T, remote: T, at: (value: T) => number): T {
  const delta = at(local) - at(remote);
  if (delta) return delta > 0 ? local : remote;
  // Stable tie breaking makes both devices converge even for identical timestamps.
  return canonical(local) >= canonical(remote) ? local : remote;
}

/**
 * A deletion wins against an unchanged base value, but a concurrent edit survives a deletion.
 * This lets reset/import remove old records without resurrecting them on the next pull, while
 * preserving words newly studied on another offline device.
 */
function mapMerge<T>(
  base: Record<string, T> | undefined,
  local: Record<string, T>,
  remote: Record<string, T>,
  conflict: (base: T | undefined, local: T, remote: T) => T,
): Record<string, T> {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)]);
  const entries: [string, T][] = [];
  for (const key of keys) {
    const b = base && Object.hasOwn(base, key) ? base[key] : undefined;
    const l = Object.hasOwn(local, key) ? local[key] : undefined;
    const r = Object.hasOwn(remote, key) ? remote[key] : undefined;
    let value: T | undefined;
    if (base && equal(l, b)) value = r;
    else if (base && equal(r, b)) value = l;
    else if (l === undefined) value = r;
    else if (r === undefined) value = l;
    else value = conflict(b, l, r);
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** Independent positive deltas add; first connection without an ancestor uses conservative max. */
function counter(base: number | undefined, local: number, remote: number): number {
  if (base === undefined) return Math.max(local, remote);
  if (local === base) return remote;
  if (remote === base) return local;
  // Imported/reduced counters cannot be interpreted as new review events.
  if (local < base || remote < base) return Math.max(local, remote);
  return base + (local - base) + (remote - base);
}

function best(base: number | undefined, local: number, remote: number): number {
  if (base !== undefined && local === base) return remote;
  if (base !== undefined && remote === base) return local;
  return Math.max(local, remote);
}

function orderedSet(base: string[] | undefined, local: string[], remote: string[]): string[] {
  if (base && equal(local, base)) return [...new Set(remote)];
  if (base && equal(remote, base)) return [...new Set(local)];
  const old = new Set(base ?? []);
  const l = new Set(local);
  const r = new Set(remote);
  return [...new Set([...local, ...remote])].filter((id) => !old.has(id) || (l.has(id) && r.has(id)));
}

function records<T>(
  base: T[] | undefined,
  local: T[],
  remote: T[],
  key: (item: T) => string,
  conflict: (base: T | undefined, local: T, remote: T) => T,
): T[] {
  const index = (list: T[]) => Object.fromEntries(list.map((item) => [key(item), item]));
  return Object.values(mapMerge(base ? index(base) : undefined, index(local), index(remote), conflict));
}

function reading(base: Reading | undefined, local: Reading, remote: Reading): Reading {
  const chosen = latest(local, remote, (item) => item.at);
  if (local.passage !== remote.passage) return chosen;
  return {
    ...chosen,
    answers: Array.from({ length: Math.max(local.answers.length, remote.answers.length) }, (_, i) => {
      const l = local.answers[i] ?? null;
      const r = remote.answers[i] ?? null;
      if (base && equal(l, base.answers[i] ?? null)) return r;
      if (base && equal(r, base.answers[i] ?? null)) return l;
      return l === null ? r : r === null ? l : l >= r ? l : r;
    }),
  };
}

/**
 * Three-way merge against the last acknowledged server snapshot. Callers must retain that
 * ancestor until a CAS upload succeeds, then use the acknowledged result as the next base.
 * With no common ancestor historical counters overlap, so their maximum is retained.
 * Active sessions are intentionally null here; restore the device's session when applying.
 */
export function mergeSnapshots(base: SyncSnapshot | null, local: SyncSnapshot, remote: SyncSnapshot | null): SyncSnapshot {
  const id = local.progress.datasetId;
  if ((base && base.progress.datasetId !== id) || (remote && remote.progress.datasetId !== id))
    throw new Error("不能合并不同词库的学习进度。");
  const lp = local.progress;
  const rp = remote?.progress;
  const bp = base?.progress;
  if (!rp) return {
    progress: {
      version: 2, datasetId: id, cards: lp.cards, skills: lp.skills, bookmarks: lp.bookmarks, days: lp.days,
      typing: lp.typing, session: null, mistakes: lp.mistakes, spell: lp.spell, spellLog: lp.spellLog,
      placement: lp.placement, queue: lp.queue, readings: lp.readings, shadow: lp.shadow, hacks: lp.hacks, flashBest: lp.flashBest,
    },
    settings: Object.fromEntries(SETTINGS_FIELDS.map((key) => [key, local.settings[key]])) as unknown as Settings,
  };
  const cards = (b: Record<string, CardState> | undefined, l: Record<string, CardState>, r: Record<string, CardState>) =>
    mapMerge(b, l, r, (_base, a, z) => latest(a, z, (c) => c.last ?? c.seen));
  // A missing key in a known ancestor is zero; without any ancestor it is unknown history.
  const count = (b: number | undefined, l: number, r: number) => counter(bp ? (b ?? 0) : undefined, l, r);
  const day = (b: DayStat | undefined, l: DayStat, r: DayStat): DayStat => ({
    n: count(b?.n, l.n, r.n), r: count(b?.r, l.r, r.r), c: count(b?.c, l.c, r.c), t: count(b?.t, l.t, r.t),
  });
  const done = (b: ShadowDone | undefined, l: ShadowDone, r: ShadowDone): ShadowDone => ({
    n: count(b?.n, l.n, r.n), good: count(b?.good, l.good, r.good), at: Math.max(l.at, r.at),
  });
  const localOrRemote = <T>(b: T | undefined, l: T, r: T) => scalar(b, l, r);
  return {
    progress: {
      version: 2,
      datasetId: id,
      cards: cards(bp?.cards, lp.cards, rp.cards),
      skills: cards(bp?.skills, lp.skills, rp.skills),
      bookmarks: orderedSet(bp?.bookmarks, lp.bookmarks, rp.bookmarks),
      days: mapMerge(bp?.days, lp.days, rp.days, day),
      typing: records(bp?.typing, lp.typing, rp.typing, canonical, localOrRemote).sort((a, b) => a.at - b.at).slice(-500),
      session: null,
      mistakes: orderedSet(bp?.mistakes, lp.mistakes, rp.mistakes).slice(0, 300),
      spell: mapMerge(bp?.spell, lp.spell, rp.spell, count),
      spellLog: records(bp?.spellLog, lp.spellLog, rp.spellLog, (m) => `${m.at}:${m.id}:${m.typed}`, localOrRemote)
        .sort((a, b) => b.at - a.at).slice(0, 200),
      placement: bp && equal(lp.placement, bp.placement) ? rp.placement
        : bp && equal(rp.placement, bp.placement) ? lp.placement
        : !lp.placement ? rp.placement : !rp.placement ? lp.placement : latest(lp.placement, rp.placement, (p) => p.at),
      queue: orderedSet(bp?.queue, lp.queue, rp.queue).slice(0, 2000),
      readings: records(bp?.readings, lp.readings, rp.readings, (r) => r.id, reading).sort((a, b) => b.at - a.at).slice(0, 30),
      shadow: {
        days: mapMerge(bp?.shadow.days, lp.shadow.days, rp.shadow.days, count),
        best: best(bp?.shadow.best, lp.shadow.best, rp.shadow.best),
        done: mapMerge(bp?.shadow.done, lp.shadow.done, rp.shadow.done, done),
      },
      hacks: mapMerge(bp?.hacks, lp.hacks, rp.hacks, (_b, l, r) => latest(l, r, (h) => h.at)),
      flashBest: best(bp?.flashBest, lp.flashBest, rp.flashBest),
    },
    settings: Object.fromEntries(SETTINGS_FIELDS.map((key) => [
      key, base ? scalar(base.settings[key], local.settings[key], remote!.settings[key]) : remote!.settings[key],
    ])) as unknown as Settings,
  };
}
