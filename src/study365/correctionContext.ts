import { withRevisionReferences } from "./revisionReferences";
import type { DayPlan } from "./planEngine";
import type { Revision } from "./protocol";
import { correctionOriginal } from "./correctionModel";
import { reviewBudget } from "./reviewBudget";
export function correctionContextBlock(
  plan: Revision,
  records: readonly Revision[],
  dayPlan: DayPlan,
  route: { correctionId?: string; work?: string; task?: string },
  skill: "writing" | "speaking",
) {
  if (!route.correctionId) return undefined;
  const correction = records.find(
    (r) =>
      r.kind === "correction" &&
      r.id === route.correctionId &&
      r.planId === plan.id &&
      !r.deleted &&
      !r.conflict,
  );
  const original =
    correction &&
    correctionOriginal(correction, withRevisionReferences(records));
  if (!correction || !original || correction.payload.skill !== skill)
    throw new Error("订正与当前计划、科目或原稿不一致。");
  const work = records.find(
    (r) =>
      r.id === route.work && r.planId === plan.id && !r.deleted && !r.conflict,
  );
  if (
    !work ||
    (work.revisionId !== original.revisionId &&
      !(
        work.payload.correctionId === correction.id &&
        work.payload.parentRevisionId === original.revisionId
      ))
  )
    throw new Error("请从订正页打开准确原稿或其订正稿。");
  const budget = reviewBudget(dayPlan, records, plan.id);
  if (!budget.canStart || !budget.block)
    throw new Error("今天没有剩余复盘预算，订正保留到下一次复盘块。");
  if (route.task && route.task !== budget.taskId)
    throw new Error("订正只能使用当天原有复盘块。");
  return budget.block;
}
