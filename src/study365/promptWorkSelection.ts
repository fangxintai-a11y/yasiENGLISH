import type { LocalPrompt } from "./promptBankSchema";
import type { WritingDraft } from "./writingModel";
import type { SpeakingDraft } from "./speakingModel";
import type { Revision } from "./protocol";
export const promptKey = (prompt: LocalPrompt) =>
  `${prompt.id}@${prompt.version}@${prompt.contentHash}`;
function practiceIdentity(prompt: LocalPrompt): string {
  const original = prompt.prompt
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return JSON.stringify([
    prompt.skill,
    prompt.skill === "writing" ? prompt.taskType : prompt.part,
    original,
    prompt.skill === "writing" && prompt.taskType === "task1"
      ? (prompt.stimulusHash ?? "?")
      : "",
  ]);
}
export function practicePrompts(prompts: readonly LocalPrompt[]) {
  const reserved = new Set(
    prompts.filter((prompt) => prompt.pool === "holdout").map(practiceIdentity),
  );
  return prompts.filter(
    (prompt) =>
      prompt.ready !== false &&
      prompt.pool !== "holdout" &&
      !reserved.has(practiceIdentity(prompt)),
  );
}
export function canChooseWritingPrompt(draft: WritingDraft): boolean {
  return (
    draft.stage === "draft" &&
    !draft.baseRevision &&
    !draft.parentRevisionId &&
    !draft.retestOf &&
    !draft.text.trim() &&
    !draft.outline.trim() &&
    draft.timer.elapsedSeconds === 0 &&
    draft.timer.runningSince === null
  );
}
export function writingWithPrompt(
  draft: WritingDraft,
  prompt: LocalPrompt,
): WritingDraft {
  if (
    prompt.skill !== "writing" ||
    prompt.taskType !== draft.taskType ||
    !practicePrompts([prompt]).length ||
    !canChooseWritingPrompt(draft)
  )
    return draft;
  return {
    ...draft,
    prompt: prompt.prompt,
    contentId: prompt.id,
    contentVersion: prompt.version,
    sourceRef: prompt.sourceRef,
    tableDescription: undefined,
    materialSelfCheck: [],
  };
}
export function speakingWithPrompt(
  draft: SpeakingDraft,
  prompt: LocalPrompt,
): SpeakingDraft {
  if (
    prompt.skill !== "speaking" ||
    prompt.part !== draft.part ||
    !practicePrompts([prompt]).length ||
    draft.baseRevision ||
    draft.retestOf ||
    draft.transcript.trim() ||
    draft.recordingId ||
    draft.durationSeconds ||
    draft.prepSeconds
  )
    return draft;
  const id = crypto.randomUUID();
  return {
    ...draft,
    id,
    recordId: id,
    prompt: prompt.prompt,
    contentId: prompt.id,
    contentVersion: prompt.version,
    sourceRef: prompt.sourceRef,
  };
}
export interface PromptRetestContext {
  date: string;
  taskId: string;
  correctionId?: string;
  retestOf?: string;
}
/** This identifies one local work, not a revision. Including the exact material hash prevents draft reuse after question changes. */
export async function retestWorkId(
  scope: string,
  planId: string,
  context: PromptRetestContext,
  materialKey: string,
): Promise<string> {
  if (!context.correctionId || !context.retestOf || !materialKey)
    throw new Error("复测链接缺少准确订正、原稿或题目。请从订正页重新进入。");
  const input = JSON.stringify([
    scope,
    planId,
    context.date,
    context.taskId,
    context.correctionId,
    context.retestOf,
    materialKey,
  ]);
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes.slice(0, 16)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function matchesRetestWork(
  work: Revision,
  id: string,
  planId: string,
  context: PromptRetestContext,
  prompt: LocalPrompt,
): boolean {
  return (
    !work.deleted &&
    !work.conflict &&
    work.id === id &&
    work.planId === planId &&
    work.kind === (prompt.skill === "writing" ? "essay" : "speaking") &&
    work.payload.date === context.date &&
    work.payload.taskId === context.taskId &&
    work.payload.correctionId === context.correctionId &&
    work.payload.retestOf === context.retestOf &&
    work.payload.contentId === prompt.id &&
    work.payload.contentVersion === prompt.version &&
    (prompt.skill === "writing"
      ? work.payload.taskType === prompt.taskType
      : work.payload.part === prompt.part)
  );
}
