import type { LocalMaterial } from "./localBankSchema";

export interface LocalPracticeReference {
  skill?: "reading" | "listening"; date: string; taskId: string;
  id?: string; version?: string; contentHash: string; updatedAt: number;
}
/** Only started local work pins an allocation; another account's drafts never reserve materials. */
export function localPracticeReferences(userId: string | null, planId: string, bank: readonly LocalMaterial[],
  storage: Pick<Storage, "length" | "key" | "getItem"> = localStorage, now = Date.now()): LocalPracticeReference[] {
  const byHash = new Map(bank.map(material => [material.contentHash, material]));
  const result: LocalPracticeReference[] = [];
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith("band-lr-draft:") || key.length > 1000) continue;
      try {
        const tuple: unknown = JSON.parse(key.slice("band-lr-draft:".length));
        if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== userId || tuple[1] !== planId
          || typeof tuple[2] !== "string" || !/^[a-f0-9]{64}$/.test(tuple[2])
          || typeof tuple[3] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(tuple[3]) || typeof tuple[4] !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(tuple[4])) continue;
        if (new Date(`${tuple[3]}T00:00:00Z`).toISOString().slice(0, 10) !== tuple[3]) continue;
        const material = byHash.get(tuple[2]);
        const raw = JSON.parse(storage.getItem(key) ?? "null");
        const count = material?.questions.length ?? (Array.isArray(raw?.answers) ? raw.answers.length : -1);
        if (count < 1 || count > 100) continue;
        const draft = readPracticeDraft(key, count, storage, now);
        if (!draft) continue;
        const skill = material?.skill ?? (/listening/.test(tuple[4]) ? "listening" : /reading/.test(tuple[4]) ? "reading" : null);
        result.push({ ...(skill ? { skill } : {}), date: tuple[3], taskId: tuple[4], contentHash: tuple[2], updatedAt: draft.startedAt,
          ...(material ? { id: material.id, version: material.version } : {}) });
      } catch { /* An unrelated or damaged local value cannot change the course allocation. */ }
    }
  } catch { /* Existing save-error handling owns unavailable browser storage. */ }
  return result.sort((a, b) => b.updatedAt - a.updatedAt || (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));
}

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
