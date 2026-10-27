import { review, Rating, recallAt, meanRecall, type CardState } from "../store/srs";
import type { Progress, Settings, Track } from "../store/store";
import type { IeltsTags } from "./tags";

/**
 * The exam engine: works backwards from the exam date to a daily plan, forecasts how many target
 * words will still be recalled on exam day, and keeps the daily load inside the learner's minutes.
 */

const DAY = 86400000;

export interface WordLite {
  id: string;
  cefr: number;
  order: number;
}
export interface AtlasLite {
  words: WordLite[];
  byId: Map<string, WordLite>;
}

/* ---------- card keys: r track uses the bare word id ---------- */

export const cardKey = (track: Track, id: string) => (track === "r" ? id : `${track}:${id}`);
export function parseKey(key: string): { track: Track; id: string } {
  const m = /^([lp]):(.*)$/.exec(key);
  return m ? { track: m[1] as Track, id: m[2] } : { track: "r", id: key };
}
export const getCard = (p: Progress, key: string): CardState | undefined => (key.length > 2 && key[1] === ":" ? p.skills[key] : p.cards[key]);

/** Every card of every track, as [key, card]. */
export function allCards(p: Progress): [string, CardState][] {
  return [...Object.entries(p.cards), ...Object.entries(p.skills)];
}

/* ---------- target vocabulary ---------- */

/** Highest CEFR level (0 = A1 … 5 = C2) worth learning for a target band. */
export const bandLevel = (band: number) => (band <= 5.5 ? 2 : band <= 6.5 ? 3 : band <= 7.5 ? 4 : 5);

export function targetIds(atlas: AtlasLite, band: number, tags: Pick<IeltsTags, "listening" | "awl">) {
  const max = bandLevel(band);
  const out = new Set<string>();
  for (const w of atlas.words) if (w.cefr <= max || w.id in tags.listening || w.id in tags.awl) out.add(w.id);
  return out;
}

/* ---------- calendar ---------- */

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Exam morning (09:00 local) as a timestamp, or null. */
export function examTime(examDate: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9).getTime();
}

/** Whole days from today to the exam day (0 = exam is today). */
export function daysLeft(examDate: string, now: number) {
  const t = examTime(examDate);
  if (t === null) return null;
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY);
}

export type Phase = "free" | "learn" | "sprint" | "after";

/** Last week before the exam: no new words, reviews only. */
export const SPRINT_DAYS = 7;
/** Last two weeks: reviews come closer together so memory peaks on exam day. */
export const PEAK_DAYS = 14;
export const sprintLength = (days: number) => Math.min(SPRINT_DAYS, Math.max(0, days));

export function phaseOf(days: number | null): Phase {
  if (days === null) return "free";
  if (days < 0) return "after";
  return days <= SPRINT_DAYS ? "sprint" : "learn";
}

/** Scheduling retention, raised in the last two weeks before the exam. */
export function effectiveRetention(s: Pick<Settings, "retention" | "examDate">, now: number) {
  const d = daysLeft(s.examDate, now);
  return d !== null && d >= 0 && d <= PEAK_DAYS ? Math.max(s.retention, 0.95) : s.retention;
}

/* ---------- pace: seconds per item, learned from the learner's own history ---------- */

export interface Pace {
  review: number;
  fresh: number;
}

export function paceOf(p: Progress, now: number): Pace {
  let r = 0;
  let n = 0;
  let t = 0;
  for (let i = 0; i < 21; i++) {
    const d = new Date(now - i * DAY);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = p.days[k];
    if (day) {
      r += day.r;
      n += day.n;
      t += day.t;
    }
  }
  // An intro costs about twice a quiz; without enough history assume 10 s per quiz.
  const review = r >= 40 ? Math.max(5, Math.min(30, t / (r + 2 * n))) : 10;
  return { review, fresh: review * 3 };
}

/* ---------- workload model ---------- */

const offsetsCache = new Map<number, number[]>();
/** Days (after the first day) on which a typical new card comes back, answered Good each time. */
function reviewOffsets(retention: number) {
  let o = offsetsCache.get(retention);
  if (!o) {
    o = [];
    const t0 = Date.UTC(2026, 0, 1, 20);
    let c = review(undefined, Rating.Good, t0, retention);
    let t = t0;
    while (o.length < 40) {
      t = Math.max(c.due, t + DAY);
      const day = Math.round((t - t0) / DAY);
      if (day > 400) break;
      o.push(day);
      c = review(c, Rating.Good, t, retention);
    }
    offsetsCache.set(retention, o);
  }
  return o;
}

/** Average reviews per day caused by learning one new card per day for `days` days. */
export function loadPerNew(days: number, retention: number) {
  if (days <= 0) return 0;
  const offs = reviewOffsets(retention);
  let sum = 0;
  for (let t = 0; t < days; t++) sum += offs.filter((d) => d <= t).length;
  // Lapses add relearning steps and shorter intervals.
  return (sum / days) * (1 + (1 - retention) * 2);
}

/** Expected reviews per day over the next `horizon` days from cards already learned. */
export function existingLoad(cards: CardState[], now: number, horizon = 14) {
  let total = 0;
  for (const c of cards) {
    const dueIn = (c.due - now) / DAY;
    if (dueIn > horizon) continue;
    total += 1 + Math.max(0, horizon - Math.max(0, dueIn)) / (Math.max(1, c.s) * 2.5 + 1);
  }
  return total / horizon;
}

/* ---------- the plan ---------- */

export interface ExamPlan {
  phase: Phase;
  days: number | null;
  /** Days still open for new words. */
  learnDays: number;
  target: number;
  /** Target words already met. */
  met: number;
  remaining: number;
  /** New words per day the plan asks for. */
  newPerDay: number;
  /** New words per day needed to cover every remaining target word. */
  need: number;
  /** Minutes per day that `need` would take. */
  minutesNeeded: number;
  /** Expected number of target words recalled on exam day if the plan is followed. */
  forecast: number;
  /** …and if all reviewing stopped today. */
  ifStop: number;
  pace: Pace;
  retention: number;
}

export function examPlan(atlas: AtlasLite, p: Progress, s: Settings, tags: Pick<IeltsTags, "listening" | "awl">, now: number): ExamPlan {
  const days = daysLeft(s.examDate, now);
  const phase = phaseOf(days);
  const target = targetIds(atlas, s.targetBand, tags);
  const pace = paceOf(p, now);
  const retention = s.retention;
  let met = 0;
  for (const id of target) if (p.cards[id]) met++;
  const remaining = target.size - met;

  const learnDays = days === null ? 60 : phase === "learn" ? days - sprintLength(days) : 0;
  const listeningShare = s.trackL ? Object.keys(tags.listening).length / Math.max(1, target.size) : 0;
  const awlShare = s.trackP ? Object.keys(tags.awl).length / Math.max(1, target.size) : 0;
  const cardsPerWord = 1 + listeningShare + awlShare;
  const perNewSec = pace.fresh + (cardsPerWord - 1) * pace.review * 1.5 + loadPerNew(learnDays, retention) * cardsPerWord * pace.review;
  const existing = existingLoad(
    allCards(p).map(([, c]) => c),
    now,
  );
  const budget = s.dailyMinutes * 60;
  const fit = Math.max(0, Math.floor((budget - existing * pace.review) / perNewSec));
  const need = learnDays > 0 ? Math.ceil(remaining / learnDays) : 0;
  const newPerDay = days === null ? s.dailyNew : Math.min(need, fit, 80);
  const minutesNeeded = Math.ceil((existing * pace.review + need * perNewSec) / 60);

  const at = days === null ? now + 60 * DAY : examTime(s.examDate)!;
  // Following the plan means the last two weeks run at the peak retention.
  const examRet = days !== null && days >= 0 ? Math.max(retention, 0.95) : retention;
  const steady = meanRecall(examRet);
  let forecast = 0;
  let ifStop = 0;
  for (const id of target) {
    const c = p.cards[id];
    if (!c) continue;
    const left = recallAt(c, at);
    ifStop += left;
    forecast += c.due >= at ? left : steady;
  }
  const planned = Math.min(remaining, newPerDay * learnDays);
  forecast += planned * steady * 0.97;

  return {
    phase,
    days,
    learnDays,
    target: target.size,
    met,
    remaining,
    newPerDay,
    need,
    minutesNeeded,
    forecast: Math.round(forecast),
    ifStop: Math.round(ifStop),
    pace,
    retention,
  };
}

/* ---------- today: priorities instead of a growing pile ---------- */

export interface TodayPlan {
  /** Due card keys in priority order, within today's time budget. */
  due: string[];
  /** Due cards pushed to later days because the budget is full. */
  deferred: number;
  /** New words to meet today. */
  fresh: string[];
  /** Listening / production cards to unlock today, as card keys. */
  unlock: string[];
  minutes: number;
  /** True when reviews alone fill the budget: no new words until the backlog is gone. */
  backlog: boolean;
  plan: ExamPlan;
}

const TRACK_WEIGHT: Record<Track, number> = { r: 1, l: 0.9, p: 0.8 };

export function priority(key: string, c: CardState, now: number, target: Set<string>) {
  const { track, id } = parseKey(key);
  const learning = c.st === 1 || c.st === 3;
  const urgency = learning ? 1 : 1 - recallAt(c, now);
  const importance = (target.has(id) ? 1 : 0.4) * TRACK_WEIGHT[track] * (c.src ? 0.7 : 1);
  return importance * (0.2 + urgency);
}

/** Next unseen words: queued imports first, then the learning path from the start level. */
export function nextNew(atlas: AtlasLite, p: Progress, startLevel: number, count: number, target: Set<string>) {
  const out: string[] = [];
  const take = (id: string) => {
    if (out.length < count && !p.cards[id] && !out.includes(id) && atlas.byId.has(id)) out.push(id);
  };
  for (const id of p.queue) take(id);
  const pass = (from: number, onlyTarget: boolean) => {
    for (const w of atlas.words) {
      if (out.length >= count) return;
      if (w.cefr < from || (onlyTarget && !target.has(w.id))) continue;
      take(w.id);
    }
  };
  pass(startLevel, true);
  pass(0, true);
  pass(0, false);
  return out;
}

export function todayPlan(atlas: AtlasLite, p: Progress, s: Settings, tags: Pick<IeltsTags, "listening" | "awl">, now: number, newToday: number): TodayPlan {
  const plan = examPlan(atlas, p, s, tags, now);
  const target = targetIds(atlas, s.targetBand, tags);
  const budget = s.dailyMinutes * 60;
  const cost = (key: string) => (key[1] === ":" ? plan.pace.review * 1.3 : plan.pace.review);

  const dueAll = allCards(p)
    .filter(([key, c]) => c.due <= now && atlas.byId.has(parseKey(key).id))
    .map(([key, c]) => [key, priority(key, c, now, target)] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
  let used = 0;
  const due: string[] = [];
  for (const key of dueAll) {
    if (used + cost(key) > budget && due.length) break;
    due.push(key);
    used += cost(key);
  }
  const deferred = dueAll.length - due.length;
  const backlog = deferred > 0;

  let fresh: string[] = [];
  if (!backlog && plan.phase !== "sprint" && plan.phase !== "after") {
    const want = Math.max(0, plan.newPerDay - newToday);
    const room = Math.floor((budget - used) / plan.pace.fresh);
    const n = s.examDate ? Math.min(want, room) : Math.min(want, Math.max(3, room));
    fresh = nextNew(atlas, p, s.startLevel, Math.max(0, n), target);
    used += fresh.length * plan.pace.fresh;
  }

  // Unlock listening / production cards for words whose recognition is already steady.
  const unlock: string[] = [];
  if (!backlog) {
    const dayStart = startOfDay(now);
    const unlockedToday = Object.values(p.skills).filter((c) => c.seen >= dayStart).length;
    let quota = Math.min(12 - unlockedToday, Math.floor((budget - used) / (plan.pace.review * 1.5)));
    const ready = (id: string, minS: number) => {
      const c = p.cards[id];
      return !!c && c.st === 2 && c.s >= minS && !c.src;
    };
    const candidates: string[] = [];
    for (const w of atlas.words) {
      if (s.trackL && w.id in tags.listening && !p.skills[`l:${w.id}`] && ready(w.id, 3)) candidates.push(`l:${w.id}`);
      if (s.trackP && w.id in tags.awl && !p.skills[`p:${w.id}`] && ready(w.id, 7)) candidates.push(`p:${w.id}`);
    }
    for (const key of candidates) {
      if (quota <= 0) break;
      unlock.push(key);
      quota--;
    }
    used += unlock.length * plan.pace.review * 1.5;
  }

  const minutes = Math.max(due.length + fresh.length + unlock.length ? 1 : 0, Math.round(used / 60));
  return { due, deferred, fresh, unlock, minutes, backlog, plan };
}

/* ---------- read-outs for the home screen ---------- */

/** Recognition cards whose memory will fall below the target before tonight is over. */
export function fadingTonight(p: Progress, now: number) {
  const midnight = startOfDay(now) + DAY;
  return Object.entries(p.cards)
    .filter(([, c]) => c.due <= midnight)
    .map(([id]) => id);
}

/** Share of each skill set currently recalled (sum of recall probabilities / set size). */
export function skillLevels(atlas: AtlasLite, p: Progress, s: Settings, tags: Pick<IeltsTags, "listening" | "awl">, now: number) {
  const target = targetIds(atlas, s.targetBand, tags);
  const sum = (ids: Iterable<string>, prefix: string, cards: Record<string, CardState>) => {
    let t = 0;
    let n = 0;
    for (const id of ids) {
      n++;
      const c = cards[prefix + id];
      if (c) t += recallAt(c, now);
    }
    return { value: n ? t / n : 0, total: n };
  };
  return {
    reading: sum(target, "", p.cards),
    listening: sum(Object.keys(tags.listening), "l:", p.skills),
    writing: sum(Object.keys(tags.awl), "p:", p.skills),
  };
}

/** Words first met yesterday evening (after 18:00) that have not been tested since waking up. */
export function lastNightWords(p: Progress, now: number) {
  const today = startOfDay(now);
  const from = today - 6 * 3600000;
  const to = today + 4 * 3600000;
  return Object.entries(p.cards)
    .filter(([, c]) => c.seen >= from && c.seen < to && (c.last ?? 0) < to && !c.src)
    .map(([id]) => id);
}
