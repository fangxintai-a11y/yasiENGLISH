import test from "node:test";
import assert from "node:assert/strict";
import type { LocalMaterial, LocalQuestion } from "./localBankSchema";
import {
  validatePayload,
  type Revision,
  type LearningPayload,
} from "./protocol";
import {
  applyAnswerReviewsToMaterial,
  answerReviewQueue,
  answerReviewTargetKey,
  buildAnswerReviewPayload,
  buildReviewedCorrection,
  exportAnswerReviews,
  hasAmbiguousAnswerReview,
  latestAnswerReviews,
  projectReviewedAttempts,
  reviewedAttempt,
  reviewedOfficialTypeCalibration,
} from "./answerReviewModel";
import { buildCorrection } from "./correctionModel";
import { completeReadingReview } from "./readingReview";
let sequence = 0;
const record = (
  kind: Revision["kind"],
  payload: LearningPayload,
  id = `record-${++sequence}`,
  at = ++sequence,
): Revision => ({
  id,
  kind,
  datasetId: null,
  planId: String(payload.planId),
  revisionId: `${at.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`,
  baseRevision: null,
  seq: at,
  createdAt: at,
  contentHash: "f".repeat(64),
  payload,
  deleted: false,
  conflict: false,
});
const q = (id: string, accepted: string, number: number): LocalQuestion => ({
  id,
  number,
  type: "sentence-completion",
  prompt: `Complete ${id}`,
  answer: { accepted: [accepted], maxWords: 1 },
  evidence: {},
  answerVerified: false,
});
const material = (patch: Partial<LocalMaterial> = {}): LocalMaterial =>
  ({
    id: "reading-a",
    version: "1",
    contentHash: "a".repeat(64),
    skill: "reading",
    scope: "section",
    deliveryMode: "local-import",
    source: {
      materialSource: "official",
      sourceRef: "synthetic:reading-a",
      rights: "Self-authored fixture",
      answerVerified: false,
    },
    title: "Synthetic survey",
    passage: "Rainfall was recorded. The gate was blue.",
    paragraphs: [
      { id: "p1", text: "Rainfall was recorded." },
      { id: "p2", text: "The gate was blue." },
    ],
    questions: [q("q1", "rainfall", 1), q("q2", "blue", 2)],
    ...patch,
  }) as LocalMaterial;
const work = (m: LocalMaterial, disputed = true): Revision =>
  record("attempt", {
    planId: "review-plan",
    date: "2026-11-09",
    day: 1,
    contentId: m.id,
    contentVersion: m.version,
    contentHash: m.contentHash,
    skill: m.skill,
    materialSource: m.source.materialSource,
    sourceRef: m.source.sourceRef,
    scope: m.scope,
    answers: ["rainfall", "red"],
    reviewAnswers: ["rainfall", "blue"],
    correct: 1,
    score: 1,
    total: 2,
    firstAttempt: true,
    questionResults: [
      {
        questionId: "q1",
        correct: true,
        reviewCorrect: true,
        confidence: "sure",
        errorCause: null,
      },
      {
        questionId: "q2",
        correct: false,
        reviewCorrect: true,
        confidence: "unsure",
        errorCause: disputed ? null : "vocab-unknown",
        answerDisputed: disputed,
        ...(disputed ? { note: "The key needs a review." } : {}),
      },
    ],
  });
const review = (
  m: LocalMaterial,
  verdict: "key-correct" | "key-wrong" | "ambiguous",
  questionId = "q2",
  correctedAnswers = verdict === "key-wrong" ? ["red"] : [],
  id?: string,
): Revision =>
  record(
    "answerReview",
    buildAnswerReviewPayload("review-plan", m, questionId, {
      verdict,
      correctedAnswers,
      note: "Checked this synthetic source.",
      reviewer: "human",
    }),
    id,
  );

test("key-wrong changes effective questions and future grading without rewriting the original score, payload or hash", () => {
  const m = material(),
    attempt = work(m),
    decision = review(m, "key-wrong");
  const raw = JSON.stringify(attempt),
    body = JSON.stringify(m);
  const projected = reviewedAttempt(
    attempt,
    m,
    [attempt, decision],
    "review-plan",
  );
  assert.equal(projected.originalScore, 1);
  assert.equal(projected.correctedScore, 2);
  assert.equal(projected.total, 2);
  assert.equal(projected.statisticsRecord.payload.score, 1);
  assert.equal(projected.statisticsRecord.payload.correct, 1);
  assert.deepEqual(projected.statisticsRecord.payload.answers, [
    "rainfall",
    "red",
  ]);
  assert.equal(projected.questions[1].correct, true);
  assert.equal(projected.questions[1].excluded, false);
  assert.equal(
    applyAnswerReviewsToMaterial(m, [decision], "review-plan").questions[1]
      .answer.accepted[0],
    "red",
  );
  assert.equal(JSON.stringify(attempt), raw);
  assert.equal(JSON.stringify(m), body);
});
test("key-correct counts a wrong answer but requires an explicit cause before generating a correction", () => {
  const m = material(),
    attempt = work(m),
    decision = review(m, "key-correct");
  const projected = reviewedAttempt(
    attempt,
    m,
    [attempt, decision],
    "review-plan",
  );
  assert.equal(projected.correctedScore, 1);
  assert.equal(projected.questions[1].needsErrorCause, true);
  assert.equal(
    (projected.statisticsRecord.payload.questionResults as any[])[1]
      .answerDisputed,
    false,
  );
  assert.equal(
    (projected.correctionRecord.payload.questionResults as any[])[1]
      .answerDisputed,
    true,
  );
  assert.equal(
    (projected.correctionRecord.payload.questionResults as any[])[1].errorCause,
    null,
  );
  const caused = work(m, false);
  assert.equal(
    reviewedAttempt(caused, m, [caused, decision], "review-plan").questions[1]
      .needsErrorCause,
    false,
  );
});
test("ambiguous excludes only the disputed question from analytics and blocks complete-source qualification", () => {
  const m = material(),
    attempt = work(m),
    decision = review(m, "ambiguous");
  const projected = reviewedAttempt(
    attempt,
    m,
    [attempt, decision],
    "review-plan",
  );
  assert.equal(projected.correctedScore, 1);
  assert.equal(projected.total, 1);
  assert.equal(projected.excluded, 1);
  assert.equal(projected.questions[1].excluded, true);
  assert.equal(
    hasAmbiguousAnswerReview(attempt.payload, [decision], "review-plan"),
    true,
  );
  assert.equal(attempt.payload.total, 2);
  assert.equal(attempt.payload.score, 1);
});
test("a new material hash invalidates the prior review and reopens its unverified queue entry", () => {
  const original = material(),
    decision = review(original, "key-wrong"),
    updated = material({ contentHash: "b".repeat(64) });
  assert.equal(
    hasAmbiguousAnswerReview(
      work(updated).payload,
      [review(original, "ambiguous")],
      "review-plan",
    ),
    false,
  );
  assert.equal(
    applyAnswerReviewsToMaterial(updated, [decision], "review-plan")
      .questions[1].answer.accepted[0],
    "blue",
  );
  const target = answerReviewQueue([decision], [updated], "review-plan").find(
    (item) => item.question.id === "q2",
  )!;
  assert.equal(target.pending, true);
  assert.equal(target.review, null);
});
test("review head selection excludes another plan, conflicts, deleted latest revisions and stale decisions", () => {
  const m = material(),
    old = review(m, "key-wrong", "q2", ["red"], "review-a"),
    newest = review(m, "ambiguous");
  assert.equal(
    latestAnswerReviews([old, newest], "review-plan")[0].payload.verdict,
    "ambiguous",
  );
  const deleted = {
    ...old,
    revisionId: "eeeeeeee-0000-4000-8000-000000000001",
    createdAt: old.createdAt + 100,
    seq: old.seq + 1,
    deleted: true,
    payload: {},
  };
  assert.deepEqual(
    latestAnswerReviews(
      [
        old,
        deleted,
        { ...newest, conflict: true },
        { ...newest, planId: "other-plan" },
      ],
      "review-plan",
    ),
    [],
  );
});
test("question IDs bind raw answer indices after reading order differs from bank order", () => {
  const m = material();
  m.questions = [
    {
      ...q("q2", "FALSE", 2),
      type: "true-false-not-given",
      answer: { accepted: ["FALSE"], maxWords: 2 },
      evidence: { paragraphId: "p2" },
    },
    {
      ...q("q1", "TRUE", 1),
      type: "true-false-not-given",
      answer: { accepted: ["TRUE"], maxWords: 2 },
      evidence: { paragraphId: "p1" },
    },
  ];
  const attempt = record("attempt", {
    ...work(m, false).payload,
    score: 2,
    correct: 2,
    answers: ["TRUE", "FALSE"],
    reviewAnswers: ["TRUE", "FALSE"],
    questionResults: [
      {
        questionId: "q1",
        correct: true,
        confidence: "sure",
        errorCause: null,
        reviewCorrect: true,
      },
      {
        questionId: "q2",
        correct: true,
        confidence: "sure",
        errorCause: null,
        reviewCorrect: true,
      },
    ],
  });
  const decision = review(m, "key-wrong", "q2", ["TRUE"]);
  const projected = reviewedAttempt(
    attempt,
    m,
    [attempt, decision],
    "review-plan",
  );
  assert.deepEqual(
    projected.questions.map((item) => [
      item.questionId,
      item.learnerAnswer,
      item.correct,
    ]),
    [
      ["q1", "TRUE", true],
      ["q2", "FALSE", false],
    ],
  );
  assert.equal(projected.correctedScore, 1);
  assert.equal(projected.questions[1].needsErrorCause, true);
});
test("official calibration validates the original record before counting a newly corrected wrong question without a fake cause", () => {
  const m = material({ scope: "type-drill" }),
    attempt = work(m, false),
    decision = review(m, "key-wrong", "q1", ["snow"]);
  validatePayload("attempt", attempt.payload);
  const projected = projectReviewedAttempts(
    [attempt, decision],
    [m],
    "review-plan",
  );
  assert.throws(() => validatePayload("attempt", projected.records[0].payload));
  const counts = reviewedOfficialTypeCalibration(
    [attempt, decision],
    [m],
    "review-plan",
  );
  assert.equal(counts.length, 1);
  assert.equal(counts[0].correct, 0);
  assert.equal(counts[0].total, 2);
  assert.deepEqual(counts[0].attemptIds, [attempt.id]);
  assert.equal(attempt.payload.score, 1);
});
test("official calibration cannot replace an earlier unfinished first claim with a later familiar result", () => {
  const m = material({ scope: "type-drill" }),
    first = work(m, false),
    later = work(m, false);
  delete first.payload.questionResults;
  delete first.payload.reviewAnswers;
  assert.deepEqual(
    reviewedOfficialTypeCalibration([first, later], [m], "review-plan"),
    [],
  );
});
test("queue includes unverified material, actual dispute reasons and learner answers without conflating repeated attempts", () => {
  const m = material(),
    a = work(m),
    b = work(m),
    queue = answerReviewQueue([a, b], [m], "review-plan");
  assert.equal(queue.length, 2);
  const target = queue.find((item) => item.question.id === "q2")!;
  assert.equal(target.disputeCount, 2);
  assert.deepEqual(
    target.learners.map((item) => item.answer),
    ["red", "red"],
  );
  assert.equal(target.reasons.length, 2);
});
test("old aggregate records without raw answers cannot gain fabricated question results or a corrected score", () => {
  const m = material(),
    attempt = work(m);
  attempt.payload.answers = [];
  delete attempt.payload.questionResults;
  const projected = reviewedAttempt(
    attempt,
    m,
    [review(m, "key-wrong")],
    "review-plan",
  );
  assert.equal(projected.correctedScore, null);
  assert.deepEqual(projected.questions, []);
  assert.equal(projected.statisticsRecord, attempt);
});
test("review builder enforces an explanation, real question, corrected option and original word limit", () => {
  const m = material(),
    valid = {
      verdict: "key-wrong" as const,
      correctedAnswers: ["red"],
      reviewer: "self" as const,
      note: "Checked original.",
    };
  assert.throws(() =>
    buildAnswerReviewPayload("review-plan", m, "missing", valid),
  );
  assert.throws(() =>
    buildAnswerReviewPayload("review-plan", m, "q2", { ...valid, note: "" }),
  );
  assert.throws(() =>
    buildAnswerReviewPayload("review-plan", m, "q2", {
      ...valid,
      correctedAnswers: [],
    }),
  );
  assert.throws(
    () =>
      buildAnswerReviewPayload("review-plan", m, "q2", {
        ...valid,
        correctedAnswers: ["too many words"],
      }),
    /字数/,
  );
});
test("export includes only current reviews in this plan and never material bodies", () => {
  const m = material(),
    decision = review(m, "key-wrong"),
    exported = exportAnswerReviews(
      [decision, { ...review(m, "ambiguous"), planId: "other-plan" }],
      "review-plan",
    );
  assert.equal(exported.exportVersion, 1);
  assert.equal(exported.answerReviews.length, 1);
  assert.deepEqual(exported.answerReviews[0].correctedAnswers, ["red"]);
  assert.equal(Object.hasOwn(exported.answerReviews[0], "passage"), false);
  assert.equal(
    answerReviewTargetKey("a:b", "c", "d", "e") ===
      answerReviewTargetKey("a", "b:c", "d", "e"),
    false,
  );
});

test("explicit reviewed causes create or append correction items while preserving completed items and the raw first answer", () => {
  const m = material(),
    attempt = work(m),
    decision = review(m, "key-correct");
  const raw = JSON.stringify(attempt);
  const saved = record(
    "correction",
    {
      planId: "review-plan",
      date: "2026-11-09",
      day: 1,
      skill: "reading",
      sourceKind: "attempt",
      sourceId: attempt.id,
      sourceRevisionId: attempt.revisionId,
      items: [
        {
          questionId: "q1",
          errorCause: "spelling",
          action: "vocab-review",
          status: "corrected",
          note: "Keep my completed action.",
        },
      ],
    },
    `correction:${attempt.revisionId}`,
  );
  const merged = buildReviewedCorrection(
    attempt,
    m,
    [attempt, decision, saved],
    "review-plan",
    "2026-11-10",
    2,
    { q2: { errorCause: "locating-error" } },
  )!;
  assert.equal(merged.id, saved.id);
  assert.equal(merged.baseRevision, saved.revisionId);
  const items = merged.payload.items as any[];
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], (saved.payload.items as any[])[0]);
  assert.equal(items[1].questionId, "q2");
  assert.equal(items[1].errorCause, "locating-error");
  assert.equal(items[1].status, "open");
  assert.equal(JSON.stringify(attempt), raw);
  const next = record(
    "correction",
    merged.payload,
    saved.id,
    saved.createdAt + 100,
  );
  assert.equal(
    buildReviewedCorrection(
      attempt,
      m,
      [attempt, decision, saved, next],
      "review-plan",
      "2026-11-10",
      2,
      { q2: { errorCause: "locating-error" } },
    ),
    null,
  );
});

test("an unresolved latest revision cannot silently restore an older review on the same record", () => {
  const m = material(),
    old = review(m, "key-correct", "q2", [], "review-conflict");
  const conflicted = {
    ...review(m, "ambiguous", "q2", [], old.id),
    conflict: true,
    createdAt: old.createdAt + 100,
  };
  assert.deepEqual(latestAnswerReviews([old, conflicted], "review-plan"), []);
});

test("correct-only first-answer snapshots keep original question outcomes when later reviews swap the wrong question", () => {
  const m = material(),
    attempt = work(m, false),
    firstDecisions = [
      review(m, "key-wrong", "q1", ["wind"]),
      review(m, "key-wrong", "q2", ["red"]),
    ];
  delete attempt.payload.reviewAnswers;
  attempt.payload.questionResults = [
    { questionId: "q2", correct: true, confidence: "unsure", errorCause: null },
  ];
  const raw = structuredClone(attempt);
  const initial = reviewedAttempt(attempt, m, firstDecisions, "review-plan");
  assert.deepEqual(
    initial.questions.map((q) => q.originalCorrect),
    [false, true],
  );
  assert.deepEqual(
    initial.questions.map((q) => q.correct),
    [false, true],
  );
  const changedDecisions = [
    ...firstDecisions,
    review(m, "key-correct", "q1", []),
    review(m, "key-correct", "q2", []),
  ];
  const changed = reviewedAttempt(attempt, m, changedDecisions, "review-plan");
  assert.deepEqual(
    changed.questions.map((q) => q.originalCorrect),
    [false, true],
  );
  assert.deepEqual(
    changed.questions.map((q) => q.correct),
    [true, false],
  );
  assert.equal(changed.originalScore, 1);
  assert.equal(changed.correctedScore, 1);
  for (const projection of [
    changed.statisticsRecord,
    changed.correctionRecord,
  ]) {
    const rows = projection.payload.questionResults as Record<
      string,
      unknown
    >[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].errorCause, null);
    assert.equal(rows[0].reviewCorrect, undefined);
    assert.throws(
      () =>
        buildCorrection(projection, {
          planId: "review-plan",
          date: "2026-11-10",
          day: 2,
          records: [],
        }),
      /A-B复盘/,
    );
  }
  assert.deepEqual(attempt, raw);
  const completed = record(
    "attempt",
    completeReadingReview(attempt, m, ["rainfall", "blue"], {
      q1: { confidence: "unsure", errorCause: "vocab-unknown" },
      q2: { confidence: "sure", errorCause: null },
    }),
  );
  const afterB = reviewedAttempt(completed, m, changedDecisions, "review-plan");
  assert.deepEqual(
    afterB.questions.map((q) => q.originalCorrect),
    [false, true],
  );
  assert.deepEqual(
    afterB.questions.map((q) => q.correct),
    [true, false],
  );
});

test("an all-wrong empty first-answer snapshot stays all-wrong even after answer reviews accept the responses", () => {
  const m = material(),
    attempt = work(m, false);
  Object.assign(attempt.payload, { score: 0, correct: 0, questionResults: [] });
  delete attempt.payload.reviewAnswers;
  const raw = structuredClone(attempt),
    initialDecisions = [
      review(m, "key-wrong", "q1", ["wind"]),
      review(m, "key-wrong", "q2", ["green"]),
    ];
  const initial = reviewedAttempt(attempt, m, initialDecisions, "review-plan");
  assert.deepEqual(
    initial.questions.map((q) => q.originalCorrect),
    [false, false],
  );
  assert.equal(initial.correctedScore, 0);
  const later = [
    ...initialDecisions,
    review(m, "key-correct", "q1", []),
    review(m, "key-wrong", "q2", ["red"]),
  ];
  const changed = reviewedAttempt(attempt, m, later, "review-plan");
  assert.deepEqual(
    changed.questions.map((q) => q.originalCorrect),
    [false, false],
  );
  assert.deepEqual(
    changed.questions.map((q) => q.correct),
    [true, true],
  );
  assert.equal(changed.originalScore, 0);
  assert.equal(changed.correctedScore, 2);
  assert.deepEqual(changed.statisticsRecord.payload.questionResults, []);
  assert.deepEqual(changed.correctionRecord.payload.questionResults, []);
  assert.throws(
    () =>
      buildCorrection(changed.correctionRecord, {
        planId: "review-plan",
        date: "2026-11-10",
        day: 2,
        records: [],
      }),
    /A-B复盘/,
  );
  assert.deepEqual(attempt, raw);
});
