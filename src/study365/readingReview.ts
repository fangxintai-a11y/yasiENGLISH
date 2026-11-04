import {
  ERROR_CAUSES,
  isObject,
  validateNewListeningReadingAttempt,
  type LearningPayload,
  type Revision,
} from "./protocol";
import type { LocalMaterial } from "./localBankSchema";
import { currentAttempts, gradeMaterial } from "./readingModel";
export const LISTENING_READING_CAUSES = [
  "synonym-miss",
  "locating-error",
  "spelling",
  "time-pressure",
  "word-limit",
  "vocab-unknown",
  "misread-question",
  "tfng-inference",
  "other",
] as const;
export const LR_CAUSE_LABELS: Record<string, string> = {
  "synonym-miss": "同义替换没认出",
  "locating-error": "定位错误",
  spelling: "拼写错误",
  "time-pressure": "时间不足",
  "word-limit": "超过字数",
  "vocab-unknown": "单词不认识",
  "misread-question": "读错题",
  "tfng-inference": "判断题过度推断",
  other: "其他",
};
export interface QuestionReview {
  confidence: "sure" | "unsure";
  errorCause: string | null;
  answerDisputed?: boolean;
  note?: string;
}
export function withReviewAnswers(
  work: Revision,
  material: LocalMaterial,
  answers: string[],
): LearningPayload {
  if (
    work.kind !== "attempt" ||
    work.payload.contentId !== material.id ||
    work.payload.contentVersion !== material.version ||
    work.payload.contentHash !== material.contentHash
  )
    throw new Error("材料版本与首答不一致，请重新打开原题。");
  if (
    answers.length !== material.questions.length ||
    answers.some((a) => typeof a !== "string")
  )
    throw new Error("A轮答案与题数不一致。");
  const payload = { ...work.payload, reviewAnswers: [...answers] };
  validateNewListeningReadingAttempt(payload);
  return payload;
}
export function completeReadingReview(
  work: Revision,
  material: LocalMaterial,
  answers: string[],
  reviews: Record<string, QuestionReview>,
): LearningPayload {
  const payload = withReviewAnswers(work, material, answers);
  const first = gradeMaterial(material, payload.answers as string[]),
    review = gradeMaterial(material, answers);
  const questionResults = material.questions.map((q, i) => {
    const selected = reviews[q.id];
    if (!selected || !["sure", "unsure"].includes(selected.confidence))
      throw new Error(`第${q.number ?? i + 1}题请选择确定程度。`);
    const correct = first.questionResults[i].correct;
    const disputed = selected.answerDisputed === true;
    if (disputed && !selected.note?.trim())
      throw new Error(`第${q.number ?? i + 1}题答案存疑请写一句理由。`);
    if (
      !correct &&
      !disputed &&
      (!LISTENING_READING_CAUSES.includes(
        selected.errorCause as (typeof LISTENING_READING_CAUSES)[number],
      ) ||
        !ERROR_CAUSES.includes(
          selected.errorCause as (typeof ERROR_CAUSES)[number],
        ))
    )
      throw new Error(`第${q.number ?? i + 1}题请选择错因。`);
    if (
      !correct &&
      !disputed &&
      selected.errorCause === "other" &&
      !selected.note?.trim()
    )
      throw new Error("其他错因请填写说明。");
    return {
      questionId: q.id,
      correct,
      reviewCorrect: review.questionResults[i].correct,
      confidence: selected.confidence,
      errorCause: correct || disputed ? null : selected.errorCause,
      answerDisputed: disputed,
      ...(selected.note?.trim() ? { note: selected.note.trim() } : {}),
    };
  });
  const result = { ...payload, questionResults };
  validateNewListeningReadingAttempt(result);
  return result;
}
export function reviewSummary(work: Revision) {
  const results = Array.isArray(work.payload.questionResults)
    ? work.payload.questionResults.filter(isObject)
    : [];
  const wrong = results.filter((q) => q.correct === false && !q.answerDisputed);
  return {
    wrong: wrong.length,
    corrected: wrong.filter((q) => q.reviewCorrect === true).length,
    remaining: wrong.filter((q) => q.reviewCorrect !== true).length,
    disputed: results.filter((q) => q.answerDisputed === true).length,
  };
}
export function readingErrorRows(
  records: readonly Revision[],
  planId: string,
  bank: readonly LocalMaterial[],
) {
  return currentAttempts(records, planId)
    .filter(
      (work) =>
        work.payload.skill === "listening" || work.payload.skill === "reading",
    )
    .flatMap((work) => {
      const material = bank.find(
        (m) =>
          m.id === work.payload.contentId &&
          m.version === work.payload.contentVersion &&
          m.contentHash === work.payload.contentHash,
      );
      return (
        Array.isArray(work.payload.questionResults)
          ? work.payload.questionResults
          : []
      )
        .filter(isObject)
        .filter((q) => !q.correct && !q.answerDisputed)
        .map((result) => ({
          work,
          result,
          question: material?.questions.find((q) => q.id === result.questionId),
        }));
    });
}
export function recentReadingStatistics(
  records: readonly Revision[],
  planId: string,
  bank: readonly LocalMaterial[],
  today: string,
) {
  const end = new Date(`${today}T00:00:00Z`);
  if (
    !Number.isFinite(end.getTime()) ||
    end.toISOString().slice(0, 10) !== today
  )
    throw new Error("统计日期无效。");
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const since = start.toISOString().slice(0, 10);
  const types = new Map<string, { correct: number; total: number }>(),
    causes = new Map<string, number>();
  for (const work of currentAttempts(records, planId)) {
    if (String(work.payload.date) < since || String(work.payload.date) > today)
      continue;
    const material = bank.find(
      (m) =>
        m.id === work.payload.contentId &&
        m.version === work.payload.contentVersion &&
        m.contentHash === work.payload.contentHash,
    );
    for (const q of (Array.isArray(work.payload.questionResults)
      ? work.payload.questionResults
      : []
    ).filter(isObject)) {
      if (q.answerDisputed) continue;
      const type =
        material?.questions.find((item) => item.id === q.questionId)?.type ??
        "unknown";
      const totals = types.get(type) ?? { correct: 0, total: 0 };
      totals.total++;
      if (q.correct) totals.correct++;
      types.set(type, totals);
      if (!q.correct && typeof q.errorCause === "string")
        causes.set(q.errorCause, (causes.get(q.errorCause) ?? 0) + 1);
    }
  }
  return {
    since,
    types: [...types].map(([type, totals]) => ({
      type,
      ...totals,
      accuracy: totals.correct / totals.total,
    })),
    causes: [...causes].map(([errorCause, count]) => ({ errorCause, count })),
  };
}
export function materialDisputes(records: readonly Revision[], planId: string) {
  const result: Record<string, number> = {};
  for (const work of currentAttempts(records, planId))
    for (const q of (Array.isArray(work.payload.questionResults)
      ? work.payload.questionResults
      : []
    ).filter(isObject))
      if (q.answerDisputed)
        result[String(work.payload.contentId)] =
          (result[String(work.payload.contentId)] ?? 0) + 1;
  return result;
}
