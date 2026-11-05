import {
  ERROR_CAUSES,
  isObject,
  isRevisionId,
  type CORRECTION_STATUSES,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { compareWeeklyCalibration } from "./calibration";
import {
  correctionAction,
  correctionDimension,
  type CorrectionCause,
  type CorrectionSkill,
  type CorrectionAction,
} from "./correctionRules";

export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];
export interface CorrectionItem {
  questionId?: string;
  dimension?: string;
  errorCause: CorrectionCause;
  action: CorrectionAction;
  status: CorrectionStatus;
  note?: string;
}
export interface CorrectionPayload extends LearningPayload {
  planId: string;
  date: string;
  day: number;
  skill: CorrectionSkill;
  sourceKind: "attempt" | "essay" | "speaking" | "feedback";
  sourceRevisionId: string;
  sourceId: string;
  items: CorrectionItem[];
}
export interface CorrectionDraft {
  id: string;
  kind: "correction";
  payload: CorrectionPayload;
}
export interface CorrectionContext {
  planId: string;
  date: string;
  day: number;
  records: readonly Revision[];
}
export function correctionItemKey(item: CorrectionItem): string {
  return item.questionId
    ? `question:${item.questionId}`
    : `dimension:${item.dimension}:${item.errorCause}`;
}
export function civilDayDistance(later: string, earlier: string): number {
  const time = (value: string) => {
    const date = new Date(`${value}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    )
      throw new Error("订正日期无效。");
    return date.getTime();
  };
  return (time(later) - time(earlier)) / 86400000;
}
function original(
  records: readonly Revision[],
  revisionId: unknown,
  planId: string,
): Revision | null {
  if (!isRevisionId(revisionId)) return null;
  return (
    records.find(
      (record) =>
        record.revisionId === revisionId &&
        record.planId === planId &&
        record.payload.planId === planId &&
        !record.deleted &&
        !record.conflict,
    ) ?? null
  );
}
/** Feedback revision is the issue evidence; its exact original revision is the retest origin. */
export function correctionOriginal(
  correction: Pick<Revision, "payload" | "planId">,
  records: readonly Revision[],
): Revision | null {
  const planId = String(correction.planId ?? correction.payload.planId ?? "");
  const source = original(records, correction.payload.sourceRevisionId, planId);
  if (
    !source ||
    source.id !== correction.payload.sourceId ||
    source.kind !== correction.payload.sourceKind
  )
    return null;
  if (source.kind !== "feedback")
    return ["attempt", "essay", "speaking"].includes(source.kind)
      ? source
      : null;
  const work = original(records, source.payload.workRevisionId, planId);
  return work &&
    ["essay", "speaking"].includes(work.kind) &&
    work.id === source.payload.workId &&
    source.payload.inputHash === work.contentHash
    ? work
    : null;
}
function cause(value: unknown): CorrectionCause {
  if (!ERROR_CAUSES.includes(value as CorrectionCause))
    throw new Error("订正错因不在已有编码内。");
  return value as CorrectionCause;
}
const live = (record: Revision, planId: string) =>
  record.planId === planId &&
  record.payload.planId === planId &&
  !record.deleted &&
  !record.conflict &&
  isRevisionId(record.revisionId);
export function completedListeningReadingReview(work: Revision): boolean {
  const results = work.payload.questionResults;
  return (
    work.kind === "attempt" &&
    ["reading", "listening"].includes(String(work.payload.skill)) &&
    Array.isArray(results) &&
    results.length > 0 &&
    work.payload.total === results.length &&
    new Set(results.filter(isObject).map((row) => row.questionId)).size ===
      results.length &&
    results.every(
      (row) =>
        isObject(row) &&
        typeof row.questionId === "string" &&
        typeof row.correct === "boolean" &&
        typeof row.reviewCorrect === "boolean",
    )
  );
}
function attemptItems(source: Revision): CorrectionItem[] {
  if (!completedListeningReadingReview(source))
    throw new Error("请先完成听读A-B复盘再生成订正。");
  return (source.payload.questionResults as Record<string, unknown>[])
    .filter((row) => row.correct === false && row.answerDisputed !== true)
    .map((row) => {
      const errorCause = cause(row.errorCause);
      return {
        questionId: String(row.questionId),
        errorCause,
        action: correctionAction(
          errorCause,
          source.payload.skill as CorrectionSkill,
        ),
        status: "open",
      };
    });
}
function feedbackItems(source: Revision, work: Revision): CorrectionItem[] {
  if (!Array.isArray(source.payload.errorCauses))
    throw new Error("反馈尚未明确列出错因，请先完成自查或归类。");
  const skill = work.kind === "essay" ? "writing" : "speaking";
  return [...new Set(source.payload.errorCauses)].map((value) => {
    const errorCause = cause(value);
    return {
      dimension: correctionDimension(errorCause, skill, work.payload.taskType),
      errorCause,
      action: correctionAction(errorCause, skill),
      status: "open",
    };
  });
}
/** Deterministic identity makes repeated generation for one issue revision idempotent. */
export function buildCorrection(
  source: Revision,
  context: CorrectionContext,
): CorrectionDraft | null {
  if (!live(source, context.planId))
    throw new Error("订正来源与当前计划或修订不一致。");
  civilDayDistance(context.date, context.date);
  if (!Number.isInteger(context.day) || context.day < 1 || context.day > 365)
    throw new Error("订正学习日无效。");
  let evidence = source,
    skill: CorrectionSkill,
    items: CorrectionItem[];
  if (source.kind === "attempt") {
    skill = source.payload.skill as CorrectionSkill;
    items = attemptItems(source);
  } else if (source.kind === "feedback") {
    const work = original(
      context.records,
      source.payload.workRevisionId,
      context.planId,
    );
    if (
      !work ||
      !["essay", "speaking"].includes(work.kind) ||
      work.id !== source.payload.workId ||
      work.contentHash !== source.payload.inputHash ||
      (work.kind === "essay" && work.payload.stage !== "submitted")
    )
      throw new Error("反馈未绑定这一版已保存的原稿。");
    skill = work.kind === "essay" ? "writing" : "speaking";
    items = feedbackItems(source, work);
  } else if (
    source.kind === "assessment" &&
    source.payload.kind === "weekly-calibration"
  ) {
    const work = original(
      context.records,
      source.payload.workRevisionId,
      context.planId,
    );
    if (
      !work ||
      !["essay", "speaking"].includes(work.kind) ||
      (source.payload.workId !== undefined &&
        work.id !== source.payload.workId) ||
      (source.payload.inputHash !== undefined &&
        work.contentHash !== source.payload.inputHash)
    )
      throw new Error("周校准未绑定准确原稿。");
    evidence = work;
    skill = work.kind === "essay" ? "writing" : "speaking";
    const warnings = compareWeeklyCalibration([
      ...context.records.filter((record) => record.id !== source.id),
      source,
    ])
      .filter(
        (row) =>
          row.planId === context.planId &&
          row.workRevisionId === work.revisionId &&
          row.weekIndex === source.payload.weekIndex,
      )
      .flatMap((row) =>
        row.differences
          .filter((difference) => difference.needsCalibration)
          .map((difference) => difference.dimension),
      );
    const mapping: Record<string, CorrectionCause> = {
      taskAchievement: "task-achievement",
      taskResponse: "task-response",
      coherence: "coherence",
      lexical: "lexical-misuse",
      grammar: "grammar",
      fluency: "fluency-pause",
      pronunciation: "pronunciation",
    };
    items = [...new Set(warnings)].map((dimension) => {
      const errorCause = mapping[dimension] ?? "other";
      return {
        dimension,
        errorCause,
        action: correctionAction(errorCause, skill),
        status: "open",
      };
    });
  } else throw new Error("请选择已复盘听读、写说反馈或周校准生成订正。");
  if (!items.length) return null;
  if (items.length > 50)
    throw new Error("本次订正超过50项，请先分批处理来源问题。");
  const id = `correction:${evidence.revisionId}`;
  if (
    context.records.some(
      (record) =>
        record.kind === "correction" &&
        record.planId === context.planId &&
        !record.conflict &&
        (record.id === id ||
          (record.payload.sourceKind === evidence.kind &&
            record.payload.sourceId === evidence.id &&
            record.payload.sourceRevisionId === evidence.revisionId)),
    )
  )
    return null;
  return {
    id,
    kind: "correction",
    payload: {
      planId: context.planId,
      date: context.date,
      day: context.day,
      skill,
      sourceKind: evidence.kind as CorrectionPayload["sourceKind"],
      sourceId: evidence.id,
      sourceRevisionId: evidence.revisionId,
      items,
    },
  };
}
/** The date changes once the last open item is actually resolved, not on later reads. */
export function updateCorrectionItems(
  payload: CorrectionPayload,
  updates: Readonly<
    Record<string, { status: "corrected" | "dropped"; note?: string }>
  >,
  date: string,
  day: number,
): CorrectionPayload {
  if (
    civilDayDistance(date, payload.date) < 0 ||
    !Number.isInteger(day) ||
    day < payload.day ||
    day > 365
  )
    throw new Error("订正完成日期不能早于来源任务。");
  const items = payload.items.map((item) => {
    const update = updates[correctionItemKey(item)];
    if (!update) return { ...item };
    if (!["corrected", "dropped"].includes(update.status))
      throw new Error("订正状态无效。");
    if (item.status !== "open") throw new Error("只有待订正项可完成或放弃。");
    if (update.status === "dropped" && !update.note?.trim())
      throw new Error("放弃订正必须填写说明。");
    return {
      ...item,
      status: update.status,
      ...(update.note?.trim() ? { note: update.note.trim() } : {}),
    };
  });
  if (
    Object.keys(updates).some(
      (key) => !payload.items.some((item) => correctionItemKey(item) === key),
    )
  )
    throw new Error("订正项不存在。");
  const finishedNow =
    payload.items.some((item) => item.status === "open") &&
    items.every((item) => item.status !== "open");
  return { ...payload, items, ...(finishedNow ? { date, day } : {}) };
}
