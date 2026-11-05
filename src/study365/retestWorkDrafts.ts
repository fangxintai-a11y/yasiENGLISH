import type { Revision } from "./protocol";
import {
  assertRetestMaterialEligible,
  type RetestPrompt,
} from "./retestSelection";
import { correctionOriginal, civilDayDistance } from "./correctionModel";
import { newWritingDraft } from "./writingModel";
import { newSpeakingDraft } from "./speakingModel";
import { withPromptOrigins } from "./promptOrigins";
export interface RetestWorkContext {
  date: string;
  day: number;
  taskId: string;
  plannedMinutes: number;
  correctionId?: string;
  retestOf?: string;
}
function origin(
  plan: Revision,
  records: readonly Revision[],
  context: RetestWorkContext,
) {
  const correction = records.find(
      (r) =>
        r.kind === "correction" &&
        r.planId === plan.id &&
        r.id === context.correctionId &&
        !r.deleted &&
        !r.conflict,
    ),
    work = correction && correctionOriginal(correction, records);
  if (
    !correction ||
    !work ||
    work.revisionId !== context.retestOf ||
    civilDayDistance(context.date, String(correction.payload.date)) < 1
  )
    throw new Error("复测须隔天并绑定准确订正和原稿。");
  return { work, correction };
}
async function eligible(
  plan: Revision,
  records: readonly Revision[],
  context: RetestWorkContext,
  prompt: RetestPrompt,
  allPrompts: readonly RetestPrompt[],
) {
  const value = origin(plan, records, context),
    prompts = await withPromptOrigins(allPrompts);
  assertRetestMaterialEligible(value.correction, prompt, {
    planId: plan.id,
    date: context.date,
    day: context.day,
    records,
    materials: [],
    prompts,
  });
  return value.work;
}
export async function writingRetestDraft(
  plan: Revision,
  context: RetestWorkContext,
  prompt: RetestPrompt,
  records: readonly Revision[],
  allPrompts: readonly RetestPrompt[],
) {
  const work = await eligible(plan, records, context, prompt, allPrompts);
  if (
    work.kind !== "essay" ||
    prompt.skill !== "writing" ||
    (prompt.taskType !== "task1" && prompt.taskType !== "task2") ||
    prompt.taskType !== work.payload.taskType ||
    prompt.ready === false
  )
    throw new Error("写作复测题型或原件不匹配。");
  const scope = work.payload.scope === "paragraph" ? "paragraph" : "full",
    minutes = scope === "paragraph" || prompt.taskType === "task1" ? 20 : 40;
  if (minutes > context.plannedMinutes)
    throw new Error("当天写作预算不足，复测留到能容纳的同科任务。");
  return newWritingDraft({
    planId: plan.id,
    date: context.date,
    day: context.day,
    taskId: context.taskId,
    taskType: prompt.taskType,
    scope,
    prompt: prompt.prompt,
    contentId: prompt.id,
    contentVersion: prompt.version,
    sourceRef: prompt.sourceRef,
    correctionId: context.correctionId,
    retestOf: context.retestOf,
    conditions: { firstAttempt: true, unseen: true },
    timer: {
      elapsedSeconds: 0,
      runningSince: null,
      limitSeconds: minutes * 60,
      timed: false,
    },
  });
}
export async function speakingRetestDraft(
  plan: Revision,
  context: RetestWorkContext,
  prompt: RetestPrompt,
  records: readonly Revision[],
  allPrompts: readonly RetestPrompt[],
) {
  const work = await eligible(plan, records, context, prompt, allPrompts);
  if (
    work.kind !== "speaking" ||
    prompt.skill !== "speaking" ||
    ![1, 2, 3].includes(Number(prompt.part)) ||
    prompt.part !== work.payload.part ||
    prompt.ready === false
  )
    throw new Error("口语复测Part或原题不匹配。");
  const minutes = prompt.part === 2 ? 3 : prompt.part === 1 ? 1 : 2;
  if (minutes > context.plannedMinutes)
    throw new Error("当天口语预算不足，复测留到后续同科任务。");
  return newSpeakingDraft({
    planId: plan.id,
    date: context.date,
    day: context.day,
    taskId: context.taskId,
    part: prompt.part!,
    prompt: prompt.prompt,
    contentId: prompt.id,
    contentVersion: prompt.version,
    sourceRef: prompt.sourceRef,
    correctionId: context.correctionId,
    retestOf: context.retestOf,
    conditions: { timed: false, firstAttempt: true, unseen: true },
  });
}
