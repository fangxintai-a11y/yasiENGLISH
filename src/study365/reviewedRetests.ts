import type { Revision } from "./protocol";
import { latestAnswerReviews, reviewedAttempt } from "./answerReviewModel";
import {
  civilDayDistance,
  completedListeningReadingReview,
  correctionOriginal,
  type CorrectionPayload,
} from "./correctionModel";
import {
  assertRetestMaterialEligible,
  evaluateRetest,
  type RetestContext,
  type RetestEvaluation,
} from "./retestSelection";

export interface ReviewedRetestEvaluation {
  evaluation: RetestEvaluation;
  /** An applicable key review requires explicitly rechecking a previously ended item. */
  recheck: boolean;
  /** Only the correction payload may be saved; all source evidence remains immutable. */
  payloadChanged: boolean;
}

/** Re-evaluate a completed LR retest against exact-version answer reviews, never its old score. */
export function evaluateReviewedRetest(
  correction: Revision,
  retest: Revision,
  context: RetestContext,
): ReviewedRetestEvaluation {
  const initial = evaluateRetest(correction, retest, context);
  const unchanged = (): ReviewedRetestEvaluation => ({
    evaluation: initial,
    recheck: false,
    payloadChanged:
      JSON.stringify(initial.payload) !== JSON.stringify(correction.payload),
  });
  if (retest.kind !== "attempt") return unchanged();
  const material = context.materials.find(
    (item) =>
      item.id === retest.payload.contentId &&
      item.version === retest.payload.contentVersion &&
      item.contentHash === retest.payload.contentHash &&
      item.skill === retest.payload.skill,
  );
  if (!material) return unchanged();
  const reviews = latestAnswerReviews(context.records, context.planId).filter(
    (record) =>
      record.payload.materialId === material.id &&
      record.payload.contentVersion === material.version &&
      record.payload.contentHash === material.contentHash &&
      material.questions.some(
        (question) => question.id === record.payload.questionId,
      ),
  );
  if (!reviews.length) return unchanged();
  const original = correctionOriginal(correction, context.records),
    source =
      original &&
      context.materials.find(
        (item) =>
          item.id === original.payload.contentId &&
          item.version === original.payload.contentVersion &&
          item.contentHash === original.payload.contentHash &&
          item.skill === original.payload.skill,
      );
  if (
    original?.kind !== "attempt" ||
    !source ||
    retest.deleted ||
    retest.conflict ||
    retest.planId !== context.planId ||
    retest.payload.planId !== context.planId ||
    retest.payload.correctionId !== correction.id ||
    retest.payload.retestOf !== original.revisionId ||
    retest.payload.firstAttempt !== true ||
    !completedListeningReadingReview(retest)
  )
    return unchanged();
  const payload = correction.payload as CorrectionPayload;
  if (civilDayDistance(String(retest.payload.date), payload.date) < 1)
    return unchanged();
  const reviewedTypes = new Set(
    material.questions
      .filter((question) =>
        reviews.some((review) => review.payload.questionId === question.id),
      )
      .map((question) => question.type),
  );
  let recheck = false;
  const prepared: Revision = {
    ...correction,
    payload: {
      ...payload,
      items: payload.items.map((item) => {
        const type = source.questions.find(
          (question) => question.id === item.questionId,
        )?.type;
        if (
          type &&
          reviewedTypes.has(type) &&
          ["retested-pass", "retested-fail"].includes(item.status)
        ) {
          recheck = true;
          return { ...item, status: "corrected" as const };
        }
        return item;
      }),
    },
  };
  // The same unseen/holdout/date policy still applies when revisiting an ended result.
  // Exclude only this work: another real attempt at the material still makes it ineligible.
  const selectionContext = {
    ...context,
    records: context.records.filter((record) => record.id !== retest.id),
  };
  try {
    assertRetestMaterialEligible(prepared, material, selectionContext);
  } catch {
    return unchanged();
  }
  const projection = reviewedAttempt(
    retest,
    material,
    context.records,
    context.planId,
  );
  const evaluation = evaluateRetest(prepared, projection.correctionRecord, {
    ...context,
    questionResults: Object.fromEntries(
      projection.questions.map((question) => [
        question.questionId,
        { correct: question.correct, excluded: question.excluded },
      ]),
    ),
  });
  return {
    evaluation,
    recheck,
    payloadChanged:
      JSON.stringify(evaluation.payload) !== JSON.stringify(payload),
  };
}
