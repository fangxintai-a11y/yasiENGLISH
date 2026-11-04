import type { AdjustmentAction } from "./protocol";

/** Advice changes selection order only; daily and section minutes are not actions. */
export const ADJUSTMENT_RULES = Object.freeze({
  questionType: Object.freeze({
    minimumQuestions: 10,
    accuracyBelow: 0.8,
    action: "prefer-question-type" as const,
  }),
  errorCause: Object.freeze({
    minimumCount: 5,
    action: "prioritize-error-cause" as const,
  }),
  repeatedRetest: Object.freeze({
    minimumConsecutiveFails: 2,
    action: "request-human-calibration" as const,
  }),
  calibration: Object.freeze({
    minimumAbsoluteDelta: 0.5,
    consecutiveWeeks: 2,
    action: "review-original" as const,
  }),
});
export const ADJUSTMENT_ACTION_LABELS: Record<AdjustmentAction, string> = {
  "prefer-question-type": "下周优先该题型的新材料",
  "prioritize-error-cause": "下周优先该错因的订正",
  "request-human-calibration": "提交真人校准前复核问题",
  "review-original": "本周复核原稿",
};
export const CALIBRATION_CORRECTION_CAUSES = Object.freeze({
  taskAchievement: "task-achievement",
  taskResponse: "task-response",
  coherence: "coherence",
  lexical: "lexical-misuse",
  grammar: "grammar",
  fluency: "fluency-pause",
  pronunciation: "pronunciation",
} as const);
export const questionTypeNeedsFocus = (accuracy: number, count: number) =>
  Number.isFinite(accuracy) &&
  accuracy >= 0 &&
  accuracy <= 1 &&
  Number.isInteger(count) &&
  count >= ADJUSTMENT_RULES.questionType.minimumQuestions &&
  accuracy < ADJUSTMENT_RULES.questionType.accuracyBelow;
export const causeNeedsFocus = (count: number) =>
  Number.isInteger(count) && count >= ADJUSTMENT_RULES.errorCause.minimumCount;
export const calibrationNeedsReview = (delta: number) =>
  Number.isFinite(delta) &&
  Math.abs(delta) >= ADJUSTMENT_RULES.calibration.minimumAbsoluteDelta;
