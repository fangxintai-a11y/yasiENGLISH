export interface PracticeDraft {
  answers: string[];
  startedAt: number;
  activeSeconds?: number;
}
export function practiceDraftKey(
  userId: string | null,
  planId: string,
  materialHash: string,
  date: string,
  taskId: string,
): string {
  return `band-lr-draft:${JSON.stringify([userId, planId, materialHash, date, taskId])}`;
}
export function readPracticeDraft(
  key: string,
  questionCount: number,
  storage: Pick<Storage, "getItem"> = localStorage,
  now = Date.now(),
): PracticeDraft | null {
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 150000) return null;
    const draft: unknown = JSON.parse(raw);
    if (
      !draft ||
      typeof draft !== "object" ||
      !("answers" in draft) ||
      !("startedAt" in draft)
    )
      return null;
    if (
      !Array.isArray(draft.answers) ||
      draft.answers.length !== questionCount ||
      draft.answers.some(
        (value) => typeof value !== "string" || value.length > 500,
      ) ||
      typeof draft.startedAt !== "number" ||
      !Number.isFinite(draft.startedAt) ||
      draft.startedAt < 0 ||
      draft.startedAt > now
    )
      return null;
    const activeSeconds = "activeSeconds" in draft ? draft.activeSeconds : 0;
    if (
      typeof activeSeconds !== "number" ||
      !Number.isFinite(activeSeconds) ||
      activeSeconds < 0 ||
      activeSeconds > 86400
    )
      return null;
    return {
      answers: draft.answers,
      startedAt: draft.startedAt,
      activeSeconds,
    };
  } catch {
    return null;
  }
}
export function savePracticeDraft(
  key: string,
  draft: PracticeDraft,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(key, JSON.stringify(draft));
}
export function clearPracticeDraft(
  key: string,
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  storage.removeItem(key);
}

/** Exam elapsed time keeps running; study minutes only accrue while the page is active. */
export class PracticeClock {
  private seconds: number;
  private since: number | null;
  constructor(seconds = 0, now = Date.now()) {
    this.seconds = seconds;
    this.since = now;
  }
  value(now = Date.now()): number {
    return Math.min(
      86400,
      this.seconds +
        (this.since === null ? 0 : Math.max(0, now - this.since) / 1000),
    );
  }
  pause(now = Date.now()): void {
    this.seconds = this.value(now);
    this.since = null;
  }
  resume(now = Date.now()): void {
    if (this.since === null) this.since = now;
  }
}
