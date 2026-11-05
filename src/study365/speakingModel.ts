import {
  isIdentifier,
  isRevisionId,
  type LearningPayload,
  type Revision,
} from "./protocol";
export type SpeakingPart = 1 | 2 | 3;
export interface PracticeTimer {
  elapsedSeconds: number;
  runningSince: number | null;
}
export interface SpeakingTiming {
  prep: PracticeTimer;
  answer: PracticeTimer;
}
export interface SpeakingDraft {
  id: string;
  recordId: string;
  baseRevision: string | null;
  parentRevisionId?: string;
  correctionId?: string;
  retestOf?: string;
  planId: string;
  date: string;
  day?: number;
  taskId?: string;
  contentId?: string;
  contentVersion?: string;
  part: SpeakingPart;
  prompt: string;
  sourceRef?: string;
  transcript: string;
  prepSeconds: number;
  durationSeconds: number;
  conditions: { timed: boolean; firstAttempt: boolean; unseen: boolean };
  recordingId: string | null;
  recordingStatus: "local" | "none";
  recordingDevice: string | null;
}
export function newPracticeTimer(): PracticeTimer {
  return { elapsedSeconds: 0, runningSince: null };
}
export function timerElapsed(timer: PracticeTimer, now = Date.now()): number {
  return Math.max(
    0,
    timer.elapsedSeconds +
      (timer.runningSince === null
        ? 0
        : Math.max(0, now - timer.runningSince) / 1000),
  );
}
export function startPracticeTimer(
  timer: PracticeTimer,
  now = Date.now(),
): PracticeTimer {
  return timer.runningSince === null ? { ...timer, runningSince: now } : timer;
}
export function stopPracticeTimer(
  timer: PracticeTimer,
  now = Date.now(),
): PracticeTimer {
  return { elapsedSeconds: timerElapsed(timer, now), runningSince: null };
}
export function newSpeakingTiming(): SpeakingTiming {
  return { prep: newPracticeTimer(), answer: newPracticeTimer() };
}
export function measuredPreparation(
  part: SpeakingPart,
  timing: SpeakingTiming,
  now = Date.now(),
): number {
  return part === 2
    ? Math.min(60, Math.floor(timerElapsed(timing.prep, now)))
    : 0;
}
export function speakingTimingStatus(
  part: SpeakingPart,
  timing: SpeakingTiming,
  now = Date.now(),
) {
  const prep = measuredPreparation(part, timing, now),
    answer = timerElapsed(timing.answer, now);
  return {
    prepSeconds: prep,
    answerSeconds: answer,
    actualSeconds: (part === 2 ? timerElapsed(timing.prep, now) : 0) + answer,
    prepRemaining: part === 2 ? Math.max(0, 60 - prep) : 0,
    answerTarget: part === 2 ? 120 : part === 1 ? 30 : null,
    answerTargetReached: part === 2 && answer >= 120,
    part2Full: part === 2 ? answer >= 120 : null,
  };
}
export function part2Full(durationSeconds: number): boolean {
  return Number.isFinite(durationSeconds) && durationSeconds >= 120;
}
export function speakingPart(value: unknown): SpeakingPart | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}
export function newSpeakingDraft(
  input: Pick<SpeakingDraft, "planId" | "date" | "part" | "prompt"> &
    Partial<SpeakingDraft>,
): SpeakingDraft {
  const id = input.id ?? crypto.randomUUID();
  const { planId, date, part, prompt, ...rest } = input;
  return {
    id,
    recordId: id,
    baseRevision: null,
    planId,
    date,
    part,
    prompt,
    transcript: "",
    prepSeconds: 0,
    durationSeconds: 0,
    conditions: { timed: false, firstAttempt: true, unseen: false },
    recordingId: null,
    recordingStatus: "none",
    recordingDevice: null,
    ...rest,
  };
}
export function speakingPayload(draft: SpeakingDraft): LearningPayload {
  if (
    !isIdentifier(draft.recordId) ||
    !isIdentifier(draft.planId) ||
    !speakingPart(draft.part) ||
    !draft.prompt.trim()
  )
    throw new Error("请填写题目并选择Part 1、2或3。");
  if (draft.baseRevision !== null && !isRevisionId(draft.baseRevision))
    throw new Error("口语作答修订引用无效。");
  const payload: LearningPayload = {
    planId: draft.planId,
    date: draft.date,
    part: draft.part,
    prompt: draft.prompt,
    transcript: draft.transcript,
    prepSeconds: draft.prepSeconds,
    durationSeconds: draft.durationSeconds,
    conditions: { ...draft.conditions },
    recordingId: draft.recordingId,
    recordingStatus: draft.recordingStatus,
    recordingDevice: draft.recordingDevice,
  };
  for (const key of [
    "day",
    "taskId",
    "contentId",
    "contentVersion",
    "sourceRef",
    "parentRevisionId",
    "correctionId",
    "retestOf",
  ] as const)
    if (draft[key] !== undefined && draft[key] !== "")
      payload[key] = draft[key];
  return payload;
}
export function speakingDraftFromRevision(work: Revision): SpeakingDraft {
  const part = speakingPart(work.payload.part);
  if (work.kind !== "speaking" || work.deleted || work.conflict || !part)
    throw new Error("旧作答的Part未知，请保留原记录并新建练习。");
  const p = work.payload;
  return newSpeakingDraft({
    id: work.id,
    recordId: work.id,
    baseRevision: work.revisionId,
    planId: work.planId!,
    date: String(p.date),
    part,
    prompt: String(p.prompt ?? ""),
    transcript: String(p.transcript ?? ""),
    prepSeconds: Number(p.prepSeconds ?? 0),
    durationSeconds: Number(p.durationSeconds ?? 0),
    recordingId: typeof p.recordingId === "string" ? p.recordingId : null,
    recordingStatus:
      p.recordingStatus === "none"
        ? "none"
        : p.recordingStatus === "local" || typeof p.recordingId === "string"
          ? "local"
          : "none",
    recordingDevice:
      typeof p.recordingDevice === "string" ? p.recordingDevice : null,
    conditions: {
      timed: !!(p.conditions as Record<string, unknown> | undefined)?.timed,
      firstAttempt: !!(p.conditions as Record<string, unknown> | undefined)
        ?.firstAttempt,
      unseen: !!(p.conditions as Record<string, unknown> | undefined)?.unseen,
    },
    ...Object.fromEntries(
      [
        "day",
        "taskId",
        "contentId",
        "contentVersion",
        "sourceRef",
        "parentRevisionId",
    "correctionId",
    "retestOf",
      ]
        .filter((key) => p[key] !== undefined && p[key] !== null)
        .map((key) => [key, p[key]]),
    ),
  });
}
export function rerecordSpeaking(work: Revision): SpeakingDraft {
  const old = speakingDraftFromRevision(work),
    id = crypto.randomUUID();
  return newSpeakingDraft({
    ...old,
    id,
    recordId: id,
    baseRevision: null,
    parentRevisionId: work.revisionId,
    transcript: "",
    prepSeconds: 0,
    durationSeconds: 0,
    recordingId: null,
    recordingStatus: "none",
    recordingDevice: null,
    conditions: { ...old.conditions, firstAttempt: false, unseen: false },
  });
}
