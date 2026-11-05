import {
  exceedsLocalWordLimit,
  localEnglishTokens,
  type LocalMaterial,
  type LocalQuestion,
} from "./localBankSchema";
import {
  isObject,
  validateNewListeningReadingAttempt,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { baseForms } from "../ielts/textimport";

/** Snapshot the learner's targets against this original passage, never its synonyms. */
export function readingCoverage(
  text: string,
  words: readonly { id: string; word: string }[],
) {
  const requested = [...new Map(words.map((w) => [w.id, w])).values()].slice(
    0,
    50,
  );
  const forms = new Set(
    (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).flatMap(baseForms),
  );
  const covered = requested.filter((w) => forms.has(w.word.toLowerCase()));
  const coveredIds = new Set(covered.map((w) => w.id));
  return {
    requestedWordIds: requested.map((w) => w.id),
    coveredWordIds: covered.map((w) => w.id),
    uncoveredWordIds: requested
      .filter((w) => !coveredIds.has(w.id))
      .map((w) => w.id),
    matcherVersion: "headword-inflection-v1",
  };
}

/** Metadata remains useful on a device which has not imported this private original. */
export function readingCoverageLabel(coverage: unknown): string {
  if (
    !isObject(coverage) ||
    !Array.isArray(coverage.requestedWordIds) ||
    !Array.isArray(coverage.coveredWordIds) ||
    !Array.isArray(coverage.uncoveredWordIds)
  )
    return "未知";
  return coverage.requestedWordIds.length
    ? `原文包含 ${coverage.coveredWordIds.length} / ${coverage.requestedWordIds.length} 个目标词；${coverage.uncoveredWordIds.length} 个未覆盖（首答时保存）`
    : "首答时没有设置错词目标";
}

export const READING_WORD_COUNTER = "english-words-v1";
export function countReadingWords(text: string): number {
  return localEnglishTokens(text).length;
}
export function isLongReading(material: LocalMaterial): boolean {
  if (material.skill !== "reading") return false;
  const words = countReadingWords(material.passage);
  return (
    !["type-drill", "short"].includes(material.scope) &&
    words >= 800 &&
    words <= 900
  );
}
export function normalizedAnswer(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[‐‑–—-]/g, " ")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ");
}
const completion = (q: LocalQuestion) => /completion|short-answer/.test(q.type);
export function gradeQuestion(question: LocalQuestion, answer: string) {
  const overLimit =
    completion(question) &&
    exceedsLocalWordLimit(question.answer, answer, !!question.options);
  const correct =
    !overLimit &&
    question.answer.accepted.some(
      (value) => normalizedAnswer(value) === normalizedAnswer(answer),
    );
  return {
    questionId: question.id,
    correct,
    errorCause: correct ? null : overLimit ? "word-limit" : null,
  };
}
export function gradeMaterial(
  material: LocalMaterial,
  answers: readonly string[],
) {
  const questionResults = material.questions.map((question, index) =>
    gradeQuestion(question, answers[index] ?? ""),
  );
  const multipleGroups = new Map<string, number[]>();
  material.questions.forEach((q, i) => {
    if (q.selectionCount && q.groupId)
      multipleGroups.set(q.groupId, [
        ...(multipleGroups.get(q.groupId) ?? []),
        i,
      ]);
  });
  for (const indexes of multipleGroups.values()) {
    const selected = [
      ...new Set(
        indexes.map((i) => normalizedAnswer(answers[i] ?? "")).filter(Boolean),
      ),
    ];
    const matched = new Map<string, number>();
    const assign = (index: number, seen: Set<string>): boolean => {
      const accepted =
        material.questions[index].answer.accepted.map(normalizedAnswer);
      for (const value of [...selected].sort()) {
        if (seen.has(value) || !accepted.includes(value)) continue;
        seen.add(value);
        const previous = matched.get(value);
        if (previous === undefined || assign(previous, seen)) {
          matched.set(value, index);
          return true;
        }
      }
      return false;
    };
    for (const index of indexes) assign(index, new Set());
    const correctIndexes = new Set(matched.values());
    for (const index of indexes)
      questionResults[index] = {
        questionId: material.questions[index].id,
        correct: correctIndexes.has(index),
        errorCause: null,
      };
  }
  const correct = questionResults.filter((question) => question.correct).length;
  return {
    questionResults,
    correct,
    score: correct,
    total: material.questions.length,
  };
}
/** Only judgment groups move. Questions carry their own IDs, answers and evidence. */
export function orderedReadingQuestions(
  material: LocalMaterial,
): LocalQuestion[] {
  const paragraphs = material.skill === "reading" ? material.paragraphs : [];
  const position = (q: LocalQuestion) => {
    const paragraphId = q.evidence.paragraphId ?? q.paragraphId;
    const at = paragraphId
      ? paragraphs.findIndex((p) => p.id === paragraphId)
      : paragraphs.findIndex(
          (p) => !!q.evidence.quote && p.text.includes(q.evidence.quote),
        );
    const offset =
      at < 0
        ? 0
        : (q.evidence.offset ??
          Math.max(0, paragraphs[at].text.indexOf(q.evidence.quote ?? "")));
    return [at < 0 ? Number.MAX_SAFE_INTEGER : at, offset];
  };
  const result = [...material.questions];
  const groups = new Map<string, number[]>();
  result.forEach((q, index) => {
    if (!["true-false-not-given", "yes-no-not-given"].includes(q.type)) return;
    const key = `${q.type}:${q.groupId ?? "default"}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  for (const indexes of groups.values()) {
    const questions = indexes
      .map((i) => result[i])
      .sort((a, b) => {
        const x = position(a),
          y = position(b);
        return (
          x[0] - y[0] ||
          x[1] - y[1] ||
          (a.number ?? Number(a.id.match(/\d+$/)?.[0] ?? 0)) -
            (b.number ?? Number(b.id.match(/\d+$/)?.[0] ?? 0)) ||
          a.id.localeCompare(b.id)
        );
      });
    indexes.forEach((index, at) => {
      result[index] = questions[at];
    });
  }
  return result;
}
export function currentAttempts(
  records: readonly Revision[],
  planId: string,
): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(
    (a, b) => b.createdAt - a.createdAt || b.seq - a.seq,
  ))
    if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].filter(
    (record) =>
      record.planId === planId &&
      record.kind === "attempt" &&
      !record.deleted &&
      !record.conflict,
  );
}
export function isFirstMaterialAttempt(
  records: readonly Revision[],
  planId: string,
  material: LocalMaterial,
): boolean {
  return !currentAttempts(records, planId).some(
    (record) =>
      record.payload.contentId === material.id &&
      record.payload.contentVersion === material.version &&
      record.payload.contentHash === material.contentHash,
  );
}
export interface AttemptContext {
  planId: string;
  date: string;
  day?: number;
  taskId?: string;
}
export function attemptPayload(
  material: LocalMaterial,
  answers: string[],
  context: AttemptContext,
  records: readonly Revision[],
  elapsedSeconds: number,
  conditions: {
    timed: boolean;
    replayed: boolean;
    transcriptViewed: boolean;
    replays: number;
  },
  coverage?: ReturnType<typeof readingCoverage>,
): LearningPayload {
  const firstAttempt = isFirstMaterialAttempt(
    records,
    context.planId,
    material,
  );
  const { score, correct, total } = gradeMaterial(material, answers);
  const payload: LearningPayload = {
    ...context,
    contentId: material.id,
    contentVersion: material.version,
    contentHash: material.contentHash,
    skill: material.skill,
    materialSource: material.source.materialSource,
    sourceRef: material.source.sourceRef,
    scope: material.scope,
    answers,
    score,
    correct,
    total,
    elapsedSeconds,
    actualMinutes: elapsedSeconds / 60,
    conditions: { ...conditions, firstAttempt, unseen: firstAttempt },
    firstAttempt,
    isCheckpoint: material.pool === "holdout",
    ...(coverage ? { coverage } : {}),
  };
  validateNewListeningReadingAttempt(payload);
  return payload;
}
/** IDP indicative table (verified 2026-11-04), 40-question Listening/Academic Reading only.
 * https://ielts.idp.com/thailand/results/how-ielts-is-marked
 * Test-specific cutoffs vary; the cited table supplies no values below raw 11. */
export function estimatedReadingListeningBand(
  score: number,
  total: number,
  scope: string,
): number | null {
  if (
    total !== 40 ||
    scope !== "full" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 40
  )
    return null;
  const thresholds = [
    [39, 9],
    [37, 8.5],
    [35, 8],
    [32, 7.5],
    [30, 7],
    [26, 6.5],
    [23, 6],
    [18, 5.5],
    [16, 5],
    [13, 4.5],
    [11, 4],
  ];
  return thresholds.find(([minimum]) => score >= minimum)?.[1] ?? null;
}
