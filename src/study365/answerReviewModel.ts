import {
  exceedsLocalWordLimit,
  type LocalMaterial,
  type LocalQuestion,
} from "./localBankSchema";
import {
  currentAttempts,
  gradeMaterial,
  orderedReadingQuestions,
} from "./readingModel";
import { buildCorrection, type CorrectionPayload } from "./correctionModel";
import { firstReadingGrade } from "./readingReview";
import {
  ERROR_CAUSES,
  isObject,
  validatePayload,
  type LearningPayload,
  type Revision,
} from "./protocol";

export type AnswerVerdict = "key-correct" | "key-wrong" | "ambiguous";
export interface AnswerReviewDecision {
  verdict: AnswerVerdict;
  correctedAnswers: string[];
  note: string;
  reviewer: "self" | "human";
}
export const answerReviewTargetKey = (
  materialId: string,
  contentVersion: string,
  contentHash: string,
  questionId: string,
) => JSON.stringify([materialId, contentVersion, contentHash, questionId]);
const targetOf = (payload: LearningPayload) =>
  answerReviewTargetKey(
    String(payload.materialId),
    String(payload.contentVersion),
    String(payload.contentHash),
    String(payload.questionId),
  );
const newest = (a: Revision, b: Revision) =>
  b.createdAt - a.createdAt ||
  b.seq - a.seq ||
  b.revisionId.localeCompare(a.revisionId);
/** Resolve record heads before targets, so a tombstone never resurrects its older revision. */
export function latestAnswerReviews(
  records: readonly Revision[],
  planId: string,
): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(newest)) {
    if (
      record.kind !== "answerReview" ||
      record.planId !== planId ||
      heads.has(record.id)
    )
      continue;
    heads.set(record.id, record);
  }
  const targets = new Map<string, Revision>();
  for (const record of [...heads.values()]
    .filter((record) => !record.deleted && !record.conflict)
    .sort(newest)) {
    if (record.payload.planId !== planId) continue;
    try {
      validatePayload("answerReview", record.payload);
    } catch {
      continue;
    }
    const target = targetOf(record.payload);
    if (!targets.has(target)) targets.set(target, record);
  }
  return [...targets.values()];
}
function reviewMap(records: readonly Revision[], planId: string) {
  return new Map(
    latestAnswerReviews(records, planId).map((record) => [
      targetOf(record.payload),
      record,
    ]),
  );
}
export function buildAnswerReviewPayload(
  planId: string,
  material: LocalMaterial,
  questionId: string,
  decision: AnswerReviewDecision,
): LearningPayload {
  if (!material.questions.some((question) => question.id === questionId))
    throw new Error("审校题目不在此版材料中。");
  const question = material.questions.find(
    (question) => question.id === questionId,
  )!;
  if (
    decision.verdict === "key-wrong" &&
    decision.correctedAnswers.some((value) => {
      const answer = value.trim();
      if (question.options)
        return !question.options.some((option) => option.id === answer);
      const labels =
        question.type === "true-false-not-given"
          ? ["TRUE", "FALSE", "NOT GIVEN"]
          : question.type === "yes-no-not-given"
            ? ["YES", "NO", "NOT GIVEN"]
            : null;
      return labels
        ? !labels.includes(answer)
        : exceedsLocalWordLimit(question.answer, answer);
    })
  )
    throw new Error("更正答案须遵守原题字数限制，并使用原选项或判断标签。");
  const payload: LearningPayload = {
    planId,
    materialId: material.id,
    contentVersion: material.version,
    contentHash: material.contentHash,
    questionId,
    verdict: decision.verdict,
    correctedAnswers: [
      ...new Set(
        decision.correctedAnswers.map((value) => value.trim()).filter(Boolean),
      ),
    ],
    note: decision.note.trim(),
    reviewer: decision.reviewer,
  };
  validatePayload("answerReview", payload);
  return payload;
}
/** A transient grading view, not a replacement original and never written to the local bank. */
export function applyAnswerReviewsToMaterial(
  material: LocalMaterial,
  records: readonly Revision[],
  planId: string,
  decisions = reviewMap(records, planId),
): LocalMaterial {
  return {
    ...material,
    questions: material.questions.map((question) => {
      const review = decisions.get(
        answerReviewTargetKey(
          material.id,
          material.version,
          material.contentHash,
          question.id,
        ),
      );
      return review?.payload.verdict === "key-wrong"
        ? {
            ...question,
            answer: {
              ...question.answer,
              accepted: [...(review.payload.correctedAnswers as string[])],
            },
          }
        : question;
    }),
  } as LocalMaterial;
}
export function hasAmbiguousAnswerReview(
  payload: LearningPayload,
  records: readonly Revision[],
  planId = String(payload.planId ?? ""),
): boolean {
  return latestAnswerReviews(records, planId).some(
    (record) =>
      record.payload.verdict === "ambiguous" &&
      record.payload.materialId === payload.contentId &&
      record.payload.contentVersion === payload.contentVersion &&
      record.payload.contentHash === payload.contentHash,
  );
}
export interface ReviewedQuestion {
  questionId: string;
  originalCorrect: boolean;
  correct: boolean;
  excluded: boolean;
  verdict: AnswerVerdict | null;
  needsErrorCause: boolean;
  learnerAnswer: string;
  reviewCorrect?: boolean;
}
export interface ReviewedAttempt {
  work: Revision;
  material: LocalMaterial;
  originalScore: number | null;
  originalTotal: number;
  correctedScore: number | null;
  total: number;
  excluded: number;
  questions: ReviewedQuestion[];
  statisticsRecord: Revision;
  correctionRecord: Revision;
}
function actualOrder(work: Revision, material: LocalMaterial): LocalMaterial {
  const results = Array.isArray(work.payload.questionResults)
    ? work.payload.questionResults.filter(isObject)
    : [];
  const ids = results.map((result) => String(result.questionId));
  const completeIds =
    ids.length === material.questions.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) =>
      material.questions.some((question) => question.id === id),
    );
  const questions = completeIds
    ? ids.map((id) =>
        material.questions.find((question) => question.id === id)!,
      )
    : material.skill === "reading"
      ? orderedReadingQuestions(material)
      : material.questions;
  return { ...material, questions } as LocalMaterial;
}
/** Score metadata is immutable; only derived question outcomes change for analytics. */
export function reviewedAttempt(
  work: Revision,
  material: LocalMaterial,
  records: readonly Revision[],
  planId: string,
  decisions = reviewMap(records, planId),
): ReviewedAttempt {
  if (
    work.kind !== "attempt" ||
    work.planId !== planId ||
    work.payload.contentId !== material.id ||
    work.payload.contentVersion !== material.version ||
    work.payload.contentHash !== material.contentHash
  )
    throw new Error("审校投影与作答材料版本不一致。");
  const originalScore =
    typeof work.payload.score === "number"
      ? work.payload.score
      : typeof work.payload.correct === "number"
        ? work.payload.correct
        : null;
  const originalTotal =
    typeof work.payload.total === "number"
      ? work.payload.total
      : material.questions.length;
  const answers = work.payload.answers;
  const empty: ReviewedAttempt = {
    work,
    material,
    originalScore,
    originalTotal,
    correctedScore: null,
    total: originalTotal,
    excluded: 0,
    questions: [],
    statisticsRecord: work,
    correctionRecord: work,
  };
  if (
    !Array.isArray(answers) ||
    answers.length !== material.questions.length ||
    answers.some(
      (value) =>
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number",
    )
  )
    return empty;
  const ordered = actualOrder(work, material),
    effective = applyAnswerReviewsToMaterial(
      ordered,
      records,
      planId,
      decisions,
    ),
    firstAnswers = answers.map((value) => String(value ?? ""));
  const first = firstReadingGrade(work, ordered),
    corrected = gradeMaterial(effective, firstAnswers);
  const originalResults = (
    Array.isArray(work.payload.questionResults)
      ? work.payload.questionResults
      : []
  ).filter(isObject);
  const firstOnlySnapshot =
    Array.isArray(work.payload.questionResults) &&
    originalResults.length === work.payload.questionResults.length &&
    Number.isInteger(work.payload.score) &&
    work.payload.total === material.questions.length &&
    originalResults.length === work.payload.score &&
    new Set(originalResults.map((result) => result.questionId)).size ===
      originalResults.length &&
    originalResults.every(
      (result) =>
        result.correct === true &&
        result.reviewCorrect === undefined &&
        material.questions.some(
          (question) => question.id === result.questionId,
        ),
    );
  const previous = new Map(
    originalResults.map((result) => [String(result.questionId), result]),
  );
  const reviewed =
    Array.isArray(work.payload.reviewAnswers) &&
    work.payload.reviewAnswers.length === answers.length
      ? gradeMaterial(
          effective,
          work.payload.reviewAnswers.map((value) => String(value ?? "")),
        )
      : null;
  const questions = ordered.questions.map(
    (question, index): ReviewedQuestion => {
      const result = previous.get(question.id),
        decision = decisions.get(
          answerReviewTargetKey(
            material.id,
            material.version,
            material.contentHash,
            question.id,
          ),
        );
      const verdict = decision
        ? (decision.payload.verdict as AnswerVerdict)
        : null;
      const excluded =
        verdict === "ambiguous" ||
        (!decision && result?.answerDisputed === true);
      const originalCorrect = first.questionResults[index].correct;
      const correct =
        decision && verdict !== "ambiguous"
          ? corrected.questionResults[index].correct
          : originalCorrect;
      const cause = result?.errorCause;
      return {
        questionId: question.id,
        originalCorrect,
        correct,
        excluded,
        verdict,
        learnerAnswer: firstAnswers[index],
        needsErrorCause:
          !!decision &&
          !excluded &&
          !correct &&
          !(
            typeof cause === "string" &&
            ERROR_CAUSES.includes(cause as (typeof ERROR_CAUSES)[number])
          ),
        ...(reviewed
          ? { reviewCorrect: reviewed.questionResults[index].correct }
          : {}),
      };
    },
  );
  const outcomes = new Map(
    questions.map((question) => [question.questionId, question]),
  );
  const project = (forCorrection: boolean): Revision =>
    !forCorrection && firstOnlySnapshot
      ? { ...work, payload: { ...work.payload, questionResults: [] } }
      : !originalResults.length
        ? work
        : {
            ...work,
            payload: {
              ...work.payload,
              questionResults: originalResults.map((result) => {
                const outcome = outcomes.get(String(result.questionId));
                return outcome
                  ? {
                      ...result,
                      correct: outcome.correct,
                      answerDisputed:
                        outcome.excluded ||
                        (forCorrection && outcome.needsErrorCause),
                      ...(outcome.reviewCorrect === undefined
                        ? {}
                        : { reviewCorrect: outcome.reviewCorrect }),
                    }
                  : result;
              }),
            },
          };
  const counted = questions.filter((question) => !question.excluded);
  return {
    work,
    material,
    originalScore,
    originalTotal,
    correctedScore: counted.filter((question) => question.correct).length,
    total: counted.length,
    excluded: questions.length - counted.length,
    questions,
    statisticsRecord: project(false),
    correctionRecord: project(true),
  };
}
export function projectReviewedAttempts(
  records: readonly Revision[],
  bank: readonly LocalMaterial[],
  planId: string,
) {
  const attempts: ReviewedAttempt[] = [],
    decisions = reviewMap(records, planId),
    workHeads = currentAttempts(records, planId);
  // Use the same latest decisions as grading, once per report rather than sorting
  // the entire history again for every attempt. Raw keys preserve strict equality.
  const ambiguousMaterials = new Map<unknown, Map<unknown, Set<unknown>>>();
  for (const decision of decisions.values()) {
    if (decision.payload.verdict !== "ambiguous") continue;
    const payload = decision.payload;
    const versions =
      ambiguousMaterials.get(payload.materialId) ??
      new Map<unknown, Set<unknown>>();
    const hashes = versions.get(payload.contentVersion) ?? new Set<unknown>();
    hashes.add(payload.contentHash);
    versions.set(payload.contentVersion, hashes);
    ambiguousMaterials.set(payload.materialId, versions);
  }
  for (const work of workHeads) {
    const material = bank.find(
      (item) =>
        item.id === work.payload.contentId &&
        item.version === work.payload.contentVersion &&
        item.contentHash === work.payload.contentHash,
    );
    if (material)
      attempts.push(
        reviewedAttempt(work, material, records, planId, decisions),
      );
  }
  const byRevision = new Map(
    attempts.map((attempt) => [attempt.work.revisionId, attempt]),
  );
  return {
    records: records.map(
      (record) => byRevision.get(record.revisionId)?.statisticsRecord ?? record,
    ),
    correctionRecords: records.map(
      (record) => byRevision.get(record.revisionId)?.correctionRecord ?? record,
    ),
    attempts,
    blockedAttemptIds: workHeads
      .filter(
        (work) =>
          ambiguousMaterials
            .get(work.payload.contentId)
            ?.get(work.payload.contentVersion)
            ?.has(work.payload.contentHash) === true,
      )
      .map((work) => work.id),
  };
}
/** Validate original source evidence, then count the effective questions without inventing causes. */
export function reviewedOfficialTypeCalibration(
  records: readonly Revision[],
  bank: readonly LocalMaterial[],
  planId: string,
) {
  const groups = new Map<
      string,
      {
        skill: "reading" | "listening";
        questionType: string;
        correct: number;
        total: number;
        attemptIds: string[];
      }
    >(),
    seen = new Set<string>();
  const decisions = reviewMap(records, planId);
  const claims = currentAttempts(records, planId).sort(
    (a, b) =>
      String(a.payload.date ?? "").localeCompare(
        String(b.payload.date ?? ""),
      ) ||
      a.createdAt - b.createdAt ||
      a.seq - b.seq,
  );
  for (const work of claims) {
    if (
      work.payload.scope !== "type-drill" ||
      work.payload.materialSource !== "official" ||
      work.payload.firstAttempt !== true
    )
      continue;
    const material = bank.find(
      (item) =>
        item.id === work.payload.contentId &&
        item.version === work.payload.contentVersion &&
        item.contentHash === work.payload.contentHash,
    );
    if (
      !material ||
      material.pool === "holdout" ||
      material.scope !== "type-drill" ||
      material.source.materialSource !== "official" ||
      !material.questions.length ||
      (material.skill === "listening" && !material.audio)
    )
      continue;
    try {
      validatePayload("attempt", work.payload);
    } catch {
      continue;
    }
    const identity = JSON.stringify([
      material.id,
      material.version,
      material.contentHash,
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const results = Array.isArray(work.payload.questionResults)
      ? work.payload.questionResults.filter(isObject)
      : [];
    if (
      results.length !== material.questions.length ||
      new Set(results.map((result) => result.questionId)).size !==
        material.questions.length ||
      results.some(
        (result) =>
          !material.questions.some(
            (question) => question.id === result.questionId,
          ),
      )
    )
      continue;
    const projection = reviewedAttempt(
      work,
      material,
      records,
      planId,
      decisions,
    );
    for (const outcome of projection.questions) {
      if (outcome.excluded) continue;
      const question = material.questions.find(
        (item) => item.id === outcome.questionId,
      )!;
      const key = `${material.skill}:${question.type}`,
        group = groups.get(key) ?? {
          skill: material.skill,
          questionType: question.type,
          correct: 0,
          total: 0,
          attemptIds: [],
        };
      group.total++;
      if (outcome.correct) group.correct++;
      if (!group.attemptIds.includes(work.id)) group.attemptIds.push(work.id);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        a.skill.localeCompare(b.skill) ||
        a.questionType.localeCompare(b.questionType),
    )
    .map((group) => ({
      ...group,
      accuracy: group.total ? group.correct / group.total : null,
    }));
}

export interface ReviewedCauseChoice {
  errorCause: string;
  note?: string;
}
/** Save the learner's explicit cause on a correction, never on the immutable first answer. */
export function buildReviewedCorrection(
  work: Revision,
  material: LocalMaterial,
  records: readonly Revision[],
  planId: string,
  date: string,
  day: number,
  choices: Readonly<Record<string, ReviewedCauseChoice>>,
) {
  const projected = reviewedAttempt(work, material, records, planId),
    needsCause = new Set(
      projected.questions
        .filter((question) => question.needsErrorCause)
        .map((question) => question.questionId),
    );
  for (const [questionId, choice] of Object.entries(choices)) {
    if (
      !needsCause.has(questionId) ||
      !ERROR_CAUSES.includes(choice.errorCause as (typeof ERROR_CAUSES)[number])
    )
      throw new Error("请选择该题当前需要补充的有效错因。");
    if (choice.errorCause === "other" && !choice.note?.trim())
      throw new Error("其他错因须填写具体说明。");
  }
  const source: Revision = {
    ...projected.correctionRecord,
    payload: {
      ...projected.correctionRecord.payload,
      questionResults: (
        projected.correctionRecord.payload.questionResults as Record<
          string,
          unknown
        >[]
      ).map((result) => {
        const choice = choices[String(result.questionId)];
        return choice
          ? { ...result, errorCause: choice.errorCause, answerDisputed: false }
          : result;
      }),
    },
  };
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(newest))
    if (!heads.has(record.id)) heads.set(record.id, record);
  const existing = [...heads.values()].find(
    (record) =>
      record.kind === "correction" &&
      record.planId === planId &&
      !record.deleted &&
      !record.conflict &&
      record.payload.sourceRevisionId === work.revisionId &&
      record.payload.sourceId === work.id,
  );
  const draft = buildCorrection(source, {
    planId,
    date,
    day,
    records: records.filter(
      (record) =>
        !(
          record.kind === "correction" &&
          record.planId === planId &&
          (record.id === existing?.id ||
            record.payload.sourceRevisionId === work.revisionId)
        ),
    ),
  });
  if (!draft) return null;
  const key = (item: {
    questionId?: string;
    dimension?: string;
    errorCause: string;
  }) => JSON.stringify([item.questionId ?? item.dimension, item.errorCause]);
  const originalItems = existing
    ? (existing.payload as CorrectionPayload).items
    : [];
  const known = new Set(originalItems.map(key));
  const additions = draft.payload.items
    .filter((item) => !known.has(key(item)))
    .map((item) => ({
      ...item,
      ...(item.questionId && choices[item.questionId]?.note?.trim()
        ? { note: choices[item.questionId].note!.trim() }
        : {}),
    }));
  if (!additions.length) return null;
  const payload = existing
    ? { ...existing.payload, items: [...originalItems, ...additions] }
    : { ...draft.payload, items: additions };
  validatePayload("correction", payload);
  return {
    id: existing?.id ?? draft.id,
    kind: "correction" as const,
    payload,
    baseRevision: existing?.revisionId ?? null,
  };
}
export interface AnswerReviewTarget {
  key: string;
  material: LocalMaterial;
  question: LocalQuestion;
  review: Revision | null;
  pending: boolean;
  disputeCount: number;
  reasons: string[];
  learners: { work: Revision; answer: string; needsErrorCause: boolean }[];
}
export function answerReviewQueue(
  records: readonly Revision[],
  bank: readonly LocalMaterial[],
  planId: string,
): AnswerReviewTarget[] {
  const decisions = reviewMap(records, planId),
    attempts = currentAttempts(records, planId),
    targets: AnswerReviewTarget[] = [];
  const learnersByTarget = new Map<string, AnswerReviewTarget["learners"]>();
  for (const work of attempts) {
    const material = bank.find(
      (item) =>
        item.id === work.payload.contentId &&
        item.version === work.payload.contentVersion &&
        item.contentHash === work.payload.contentHash,
    );
    if (!material) continue;
    const projection = reviewedAttempt(
      work,
      material,
      records,
      planId,
      decisions,
    );
    for (const outcome of projection.questions) {
      const key = answerReviewTargetKey(
        material.id,
        material.version,
        material.contentHash,
        outcome.questionId,
      );
      const learners = learnersByTarget.get(key) ?? [];
      learners.push({
        work,
        answer: outcome.learnerAnswer,
        needsErrorCause: outcome.needsErrorCause,
      });
      learnersByTarget.set(key, learners);
    }
  }
  for (const material of bank) {
    for (const question of material.questions) {
      const key = answerReviewTargetKey(
          material.id,
          material.version,
          material.contentHash,
          question.id,
        ),
        review = decisions.get(key) ?? null;
      const learners = learnersByTarget.get(key) ?? [];
      const disputed = learners.flatMap(({ work }) =>
        (Array.isArray(work.payload.questionResults)
          ? work.payload.questionResults
          : []
        )
          .filter(isObject)
          .filter(
            (result) =>
              result.questionId === question.id &&
              result.answerDisputed === true,
          ),
      );
      if (question.answerVerified && !disputed.length && !review) continue;
      targets.push({
        key,
        material,
        question,
        review,
        pending: !review,
        disputeCount: disputed.length,
        reasons: disputed.flatMap((result) =>
          typeof result.note === "string" && result.note ? [result.note] : [],
        ),
        learners,
      });
    }
  }
  return [
    ...new Map(targets.map((target) => [target.key, target])).values(),
  ].sort(
    (a, b) =>
      Number(b.pending) - Number(a.pending) ||
      b.disputeCount - a.disputeCount ||
      a.material.id.localeCompare(b.material.id) ||
      (a.question.number ?? 0) - (b.question.number ?? 0) ||
      a.question.id.localeCompare(b.question.id),
  );
}
export function exportAnswerReviews(
  records: readonly Revision[],
  planId: string,
) {
  return {
    exportVersion: 1,
    planId,
    answerReviews: latestAnswerReviews(records, planId).map((record) => ({
      ...record.payload,
      correctedAnswers: [...(record.payload.correctedAnswers as string[])],
    })),
  };
}
