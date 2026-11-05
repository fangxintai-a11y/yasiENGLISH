import test from "node:test";
import assert from "node:assert/strict";
import type { LocalMaterial, LocalQuestion } from "./localBankSchema";
import { hashPayload, type LearningPayload, type Revision } from "./protocol";
import {
  completeReadingReview,
  materialDisputes,
  readingErrorRows,
  recentReadingStatistics,
  reviewSummary,
  withReviewAnswers,
  type QuestionReview,
} from "./readingReview";
const questions: LocalQuestion[] = ["A", "B", "C", "D"].map(
  (answer, index) => ({
    id: `q${index + 1}`,
    number: index + 1,
    type: "sentence-completion",
    prompt: `Synthetic item ${index + 1}.`,
    answer: { accepted: [answer], maxWords: 1 },
    evidence: { quote: "Synthetic context." },
    answerVerified: true,
  }),
);
const material: LocalMaterial = {
  id: "review-material",
  version: "1",
  skill: "reading",
  title: "Synthetic review passage",
  passage: "Synthetic context.",
  paragraphs: [{ id: "p1", text: "Synthetic context." }],
  deliveryMode: "local-import",
  scope: "section",
  contentHash: "a".repeat(64),
  source: {
    materialSource: "unofficial",
    sourceRef: "Self-authored test fixture",
    rights: "Self authored",
    answerVerified: true,
  },
  questions,
};
const correction = ["A", "B", "still-wrong", "D"];
const selections = (): Record<string, QuestionReview> => ({
  q1: { confidence: "sure", errorCause: null },
  q2: { confidence: "unsure", errorCause: "vocab-unknown" },
  q3: { confidence: "sure", errorCause: "locating-error" },
  q4: {
    confidence: "unsure",
    errorCause: null,
    answerDisputed: true,
    note: "Synthetic answer key is ambiguous.",
  },
});
async function work(): Promise<Revision> {
  const payload: LearningPayload = {
    planId: "plan-a",
    date: "2026-11-04",
    contentId: material.id,
    contentVersion: material.version,
    contentHash: material.contentHash,
    skill: "reading",
    materialSource: "unofficial",
    sourceRef: material.source.sourceRef,
    scope: "section",
    firstAttempt: true,
    answers: ["A", "wrong-b", "wrong-c", "wrong-d"],
    score: 1,
    correct: 1,
    total: 4,
    elapsedSeconds: 1200,
    actualMinutes: 20,
  };
  return {
    id: "review-attempt",
    kind: "attempt",
    planId: "plan-a",
    datasetId: null,
    revisionId: "12345678-1234-1234-1234-123456789012",
    baseRevision: null,
    seq: 1,
    createdAt: 1,
    contentHash: await hashPayload("attempt", payload),
    conflict: false,
    deleted: false,
    payload,
  };
}
test("A round preserves the first answer and score; saved corrections are independent of the input array", async () => {
  const original = await work(),
    before = JSON.stringify(original),
    answers = [...correction];
  const saved = withReviewAnswers(original, material, answers);
  assert.deepEqual(saved.answers, ["A", "wrong-b", "wrong-c", "wrong-d"]);
  assert.deepEqual(saved.reviewAnswers, correction);
  for (const key of [
    "score",
    "correct",
    "total",
    "elapsedSeconds",
    "actualMinutes",
    "firstAttempt",
    "contentHash",
  ])
    assert.deepEqual(saved[key], original.payload[key]);
  answers[1] = "changed after saving";
  assert.equal((saved.reviewAnswers as string[])[1], "B");
  assert.equal(JSON.stringify(original), before);
  assert.equal(
    await hashPayload("attempt", original.payload),
    original.contentHash,
  );
});
test("A round refuses another material revision or a truncated answer array", async () => {
  const original = await work();
  assert.throws(
    () =>
      withReviewAnswers(original, { ...material, version: "2" }, correction),
    /材料版本与首答不一致/,
  );
  assert.throws(
    () =>
      withReviewAnswers(
        original,
        { ...material, contentHash: "b".repeat(64) },
        correction,
      ),
    /材料版本与首答不一致/,
  );
  assert.throws(
    () => withReviewAnswers(original, material, ["A"]),
    /A轮答案与题数不一致/,
  );
});
test("B round distinguishes corrected, still wrong and disputed items without rewriting first-answer grade or hash", async () => {
  const original = await work(),
    before = JSON.stringify(original),
    payload = completeReadingReview(
      original,
      material,
      correction,
      selections(),
    );
  const results = payload.questionResults as Record<string, unknown>[];
  assert.deepEqual(
    results.map((item) => item.questionId),
    ["q1", "q2", "q3", "q4"],
  );
  assert.deepEqual(
    results.map((item) => item.correct),
    [true, false, false, false],
  );
  assert.deepEqual(
    results.map((item) => item.reviewCorrect),
    [true, true, false, true],
  );
  assert.deepEqual(
    results.map((item) => item.errorCause),
    [null, "vocab-unknown", "locating-error", null],
  );
  assert.equal(payload.score, 1);
  assert.equal(payload.correct, 1);
  assert.equal(payload.total, 4);
  assert.deepEqual(payload.answers, original.payload.answers);
  assert.equal(JSON.stringify(original), before);
  assert.equal(
    await hashPayload("attempt", original.payload),
    original.contentHash,
  );
  assert.deepEqual(reviewSummary({ ...original, payload }), {
    wrong: 2,
    corrected: 1,
    remaining: 1,
    disputed: 1,
  });
});
test("B round cannot finish a first-answer error without an allowed cause and confidence", async () => {
  const original = await work(),
    missing = selections();
  missing.q2 = { confidence: "sure", errorCause: null };
  assert.throws(
    () => completeReadingReview(original, material, correction, missing),
    /第2题请选择错因/,
  );
  const noConfidence = selections();
  delete noConfidence.q1;
  assert.throws(
    () => completeReadingReview(original, material, correction, noConfidence),
    /第1题请选择确定程度/,
  );
  const unrelated = selections();
  unrelated.q2.errorCause = "pronunciation";
  assert.throws(
    () => completeReadingReview(original, material, correction, unrelated),
    /第2题请选择错因/,
  );
});
test("disputes and other causes require a per-question explanation, even when the attempt has a note", async () => {
  const original = await work();
  original.payload.note =
    "A general attempt note is not a reason for this disputed answer.";
  const disputed = selections();
  disputed.q4.note = "   ";
  assert.throws(
    () => completeReadingReview(original, material, correction, disputed),
    /第4题答案存疑请写一句理由/,
  );
  const other = selections();
  other.q2.errorCause = "other";
  assert.throws(
    () => completeReadingReview(original, material, correction, other),
    /其他错因请填写说明/,
  );
});
test("error book retains a corrected original error and a remaining error, while excluding a dispute", async () => {
  const original = await work(),
    payload = completeReadingReview(
      original,
      material,
      correction,
      selections(),
    ),
    reviewed = { ...original, payload };
  const rows = readingErrorRows([reviewed], "plan-a", [material]);
  assert.deepEqual(
    rows.map((row) => row.result.questionId),
    ["q2", "q3"],
  );
  assert.equal(rows[0].result.reviewCorrect, true);
  assert.equal(rows[1].result.reviewCorrect, false);
  assert.deepEqual(
    rows.map((row) => row.question?.id),
    ["q2", "q3"],
  );
  assert.equal(
    readingErrorRows([reviewed], "plan-a", []).length,
    2,
    "missing local material must not silently erase saved errors",
  );
  assert.equal(
    readingErrorRows([reviewed], "other-plan", [material]).length,
    0,
  );
});
test("four-week statistics include both boundary dates, exclude older/future dates, and never treat disputes as learner errors", async () => {
  const original = await work(),
    payload = completeReadingReview(
      original,
      material,
      correction,
      selections(),
    );
  const dates = ["2026-11-03", "2026-11-04", "2026-12-01", "2026-12-02"];
  const records = dates.map((date, index) => ({
    ...original,
    id: `dated-${index}`,
    payload: { ...payload, date },
    seq: index + 1,
    createdAt: index + 1,
  }));
  const stats = recentReadingStatistics(
    records,
    "plan-a",
    [material],
    "2026-12-01",
  );
  assert.equal(stats.since, "2026-11-04");
  assert.deepEqual(stats.types, [
    { type: "sentence-completion", correct: 2, total: 6, accuracy: 1 / 3 },
  ]);
  assert.deepEqual(
    Object.fromEntries(
      stats.causes.map((item) => [item.errorCause, item.count]),
    ),
    { "vocab-unknown": 2, "locating-error": 2 },
  );
  assert.throws(
    () => recentReadingStatistics(records, "plan-a", [material], "2026-02-30"),
    /统计日期无效/,
  );
});
test("dispute totals and error statistics use latest current heads without counting a reviewed revision twice", async () => {
  const original = await work(),
    payload = completeReadingReview(
      original,
      material,
      correction,
      selections(),
    );
  const first = { ...original, payload },
    second = { ...first, seq: 2, createdAt: 2 };
  assert.deepEqual(materialDisputes([first, second], "plan-a"), {
    [material.id]: 1,
  });
  assert.equal(
    readingErrorRows([first, second], "plan-a", [material]).length,
    2,
  );
  assert.equal(
    Object.keys(
      materialDisputes([first, { ...second, deleted: true }], "plan-a"),
    ).length,
    0,
  );
});

test("a corrected key before a new first answer preserves the two-way swapped first snapshot through B", async () => {
  const raw = { ...material, questions: material.questions.slice(0, 2) },
    effective = {
      ...raw,
      questions: raw.questions.map((q, i) => ({
        ...q,
        answer: { ...q.answer, accepted: [i === 0 ? "B" : "A"] },
      })),
    };
  for (const [answers, firstCorrect] of [
    [
      ["B", "B"],
      [true, false],
    ],
    [
      ["A", "A"],
      [false, true],
    ],
  ] as [string[], boolean[]][]) {
    const original = await work();
    original.payload = {
      ...original.payload,
      answers: [...answers],
      score: 1,
      correct: 1,
      total: 2,
      questionResults: raw.questions.flatMap((q, i) =>
        firstCorrect[i]
          ? [
              {
                questionId: q.id,
                correct: true,
                confidence: "unsure",
                errorCause: null,
              },
            ]
          : [],
      ),
    };
    original.contentHash = await hashPayload("attempt", original.payload);
    const before = JSON.stringify(original),
      reviews = Object.fromEntries(
        raw.questions.map((q, i) => [
          q.id,
          {
            confidence: "sure" as const,
            errorCause: firstCorrect[i] ? null : "vocab-unknown",
          },
        ]),
      );
    const payload = completeReadingReview(
      original,
      raw,
      ["B", "A"],
      reviews,
      effective,
    );
    assert.deepEqual(
      (payload.questionResults as Record<string, unknown>[]).map(
        (q) => q.correct,
      ),
      firstCorrect,
    );
    assert.deepEqual(
      (payload.questionResults as Record<string, unknown>[]).map(
        (q) => q.reviewCorrect,
      ),
      [true, true],
    );
    assert.deepEqual(
      (payload.questionResults as Record<string, unknown>[]).map(
        (q) => q.errorCause,
      ),
      firstCorrect.map((ok) => (ok ? null : "vocab-unknown")),
    );
    assert.equal(payload.score, 1);
    assert.equal(payload.correct, 1);
    assert.deepEqual(payload.answers, answers);
    assert.equal(JSON.stringify(original), before);
    const wrong = raw.questions.find((_q, i) => !firstCorrect[i])!;
    reviews[wrong.id].errorCause = null;
    assert.throws(
      () =>
        completeReadingReview(original, raw, ["B", "A"], reviews, effective),
      new RegExp(`第${wrong.number}题请选择错因`),
    );
  }
});
test("an empty correct-only snapshot means a real all-wrong first answer and never regrades it from the old key", async () => {
  const raw = { ...material, questions: material.questions.slice(0, 2) },
    effective = {
      ...raw,
      questions: raw.questions.map((q, i) => ({
        ...q,
        answer: { ...q.answer, accepted: [i === 0 ? "B" : "A"] },
      })),
    },
    original = await work();
  original.payload = {
    ...original.payload,
    answers: ["A", "B"],
    score: 0,
    correct: 0,
    total: 2,
    questionResults: [],
  };
  original.contentHash = await hashPayload("attempt", original.payload);
  const payload = completeReadingReview(
    original,
    raw,
    ["B", "A"],
    {
      q1: { confidence: "sure", errorCause: "synonym-miss" },
      q2: { confidence: "sure", errorCause: "vocab-unknown" },
    },
    effective,
  );
  assert.equal(payload.score, 0);
  assert.equal(payload.correct, 0);
  assert.deepEqual(
    (payload.questionResults as Record<string, unknown>[]).map(
      (q) => q.correct,
    ),
    [false, false],
  );
  assert.deepEqual(
    (payload.questionResults as Record<string, unknown>[]).map(
      (q) => q.reviewCorrect,
    ),
    [true, true],
  );
});
test("completed stored first judgments survive later answer-key changes while only reviewCorrect follows the current key", async () => {
  const raw = { ...material, questions: material.questions.slice(0, 2) },
    effective = {
      ...raw,
      questions: raw.questions.map((q, i) => ({
        ...q,
        answer: { ...q.answer, accepted: [i === 0 ? "B" : "A"] },
      })),
    },
    original = await work();
  original.payload = {
    ...original.payload,
    answers: ["B", "B"],
    score: 1,
    correct: 1,
    total: 2,
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
        reviewCorrect: false,
        confidence: "sure",
        errorCause: "vocab-unknown",
      },
    ],
  };
  original.contentHash = await hashPayload("attempt", original.payload);
  const payload = completeReadingReview(
    original,
    raw,
    ["B", "B"],
    {
      q1: { confidence: "sure", errorCause: null },
      q2: { confidence: "sure", errorCause: "vocab-unknown" },
    },
    effective,
  );
  assert.deepEqual(
    (payload.questionResults as Record<string, unknown>[]).map(
      (q) => q.correct,
    ),
    [true, false],
  );
  assert.deepEqual(
    (payload.questionResults as Record<string, unknown>[]).map(
      (q) => q.reviewCorrect,
    ),
    [true, false],
  );
  assert.equal(payload.score, 1);
  assert.equal(payload.correct, 1);
});
