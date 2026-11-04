import test from "node:test";
import assert from "node:assert/strict";
import type { Revision } from "./protocol";
import type { LocalMaterial } from "./localBankSchema";
import { buildCorrection, type CorrectionPayload } from "./correctionModel";
import {
  buildAnswerReviewPayload,
  type AnswerVerdict,
} from "./answerReviewModel";
import { evaluateRetest, type RetestContext } from "./retestSelection";
import { evaluateReviewedRetest } from "./reviewedRetests";

let seq = 0;
function revision(
  kind: Revision["kind"],
  payload: Revision["payload"],
  id = `r${++seq}`,
): Revision {
  return {
    id,
    kind,
    planId: "plan",
    datasetId: null,
    payload: { planId: "plan", ...payload },
    revisionId: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    baseRevision: null,
    seq,
    createdAt: seq,
    contentHash: "e".repeat(64),
    deleted: false,
    conflict: false,
  };
}
function paper(id: string): LocalMaterial {
  const passage = `Self-authored ${id} report: rainfall was recorded and the gate was blue.`;
  return {
    id,
    version: "1",
    contentHash: (id === "original" ? "a" : "b").repeat(64),
    skill: "reading",
    scope: "section",
    title: id,
    deliveryMode: "local-import",
    source: {
      materialSource: "official",
      sourceRef: `synthetic:${id}`,
      rights: "Self-authored fixture",
      answerVerified: false,
    },
    passage,
    paragraphs: [{ id: "p1", text: passage }],
    questions: ["rainfall", "blue"].map((answer, index) => ({
      id: `${id}-q${index + 1}`,
      type: "sentence-completion" as const,
      prompt: `Complete self-authored sentence ${index + 1}`,
      answer: { accepted: [answer], maxWords: 1 },
      evidence: {},
      answerVerified: false,
    })),
  };
}
function work(material: LocalMaterial, correct: boolean, date: string) {
  return revision("attempt", {
    date,
    day: date.endsWith("09") ? 1 : 3,
    skill: "reading",
    scope: "section",
    contentId: material.id,
    contentVersion: material.version,
    contentHash: material.contentHash,
    materialSource: "official",
    sourceRef: material.source.sourceRef,
    firstAttempt: true,
    score: correct ? 2 : 1,
    correct: correct ? 2 : 1,
    total: 2,
    answers: [correct ? "rainfall" : "wind", "blue"],
    reviewAnswers: ["rainfall", "blue"],
    questionResults: material.questions.map((question, index) => ({
      questionId: question.id,
      correct: index > 0 || correct,
      reviewCorrect: true,
      confidence: "sure",
      errorCause: index === 0 && !correct ? "vocab-unknown" : null,
    })),
  });
}
function fixture(
  status: "retested-pass" | "retested-fail" = "retested-pass",
  correct = true,
) {
  const old = paper("original"),
    fresh = paper("fresh"),
    source = work(old, false, "2026-11-09"),
    draft = buildCorrection(source, {
      planId: "plan",
      date: "2026-11-10",
      day: 2,
      records: [source],
    })!;
  const correction = revision(
    "correction",
    {
      ...draft.payload,
      items: draft.payload.items.map((item) => ({
        ...item,
        status,
        note: "Actual correction completed on day 2",
      })),
    },
    draft.id,
  );
  const retest = work(fresh, correct, "2026-11-11");
  Object.assign(retest.payload, {
    correctionId: correction.id,
    retestOf: source.revisionId,
  });
  const assessment = revision("assessment", {
    kind: "official",
    date: "2026-11-09",
    scores: { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 },
  });
  const context: RetestContext = {
    planId: "plan",
    date: "2026-11-12",
    day: 4,
    records: [source, retest, correction, assessment],
    materials: [old, fresh],
    prompts: [],
  };
  return { old, fresh, source, retest, correction, assessment, context };
}
function review(
  material: LocalMaterial,
  verdict: AnswerVerdict,
  questionId = material.questions[0].id,
  answers = ["wind"],
) {
  return revision(
    "answerReview",
    buildAnswerReviewPayload("plan", material, questionId, {
      verdict,
      correctedAnswers: verdict === "key-wrong" ? answers : [],
      note: "Checked against the original evidence",
      reviewer: "self",
    }),
  );
}
const status = (payload: CorrectionPayload) => payload.items[0].status;

test("R5: without an exact applicable review, ended retests keep the existing complete behavior", () => {
  const f = fixture(),
    before = structuredClone(f);
  assert.match(
    evaluateRetest(f.correction, f.retest, f.context).pending!,
    /没有待复测/,
  );
  const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
  assert.equal(result.recheck, false);
  assert.equal(result.payloadChanged, false);
  assert.equal(status(result.evaluation.payload), "retested-pass");
  assert.deepEqual(f, before);
});

test("R5: a later key-wrong review overturns an old pass without changing the original score or inventing a cause", () => {
  const f = fixture();
  f.context.records = [...f.context.records, review(f.fresh, "key-wrong")];
  const before = structuredClone(f);
  const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
  assert.equal(result.recheck, true);
  assert.equal(result.payloadChanged, true);
  assert.equal(status(result.evaluation.payload), "retested-fail");
  assert.equal(result.evaluation.nextRound, null); // The raw correct answer has no learner-selected wrong cause.
  assert.equal(result.evaluation.payload.date, "2026-11-10");
  assert.equal(
    result.evaluation.payload.items[0].note,
    before.correction.payload.items instanceof Array
      ? before.correction.payload.items[0].note
      : "",
  );
  assert.equal(f.retest.payload.score, 2);
  assert.deepEqual(f, before);
});

test("R5: a later corrected key can turn an old fail into a pass; its old failed child remains intact", () => {
  const f = fixture("retested-fail", false),
    childDraft = buildCorrection(f.retest, { ...f.context, records: [] })!,
    child = revision("correction", childDraft.payload, childDraft.id);
  f.context.records = [
    ...f.context.records,
    child,
    review(f.fresh, "key-wrong"),
  ];
  const before = structuredClone(f.context.records),
    result = evaluateReviewedRetest(f.correction, f.retest, f.context);
  assert.equal(status(result.evaluation.payload), "retested-pass");
  assert.equal(result.recheck, true);
  assert.equal(result.evaluation.nextRound, null);
  assert.equal(f.retest.payload.score, 1);
  assert.deepEqual(f.context.records, before);
  assert.equal((child.payload.items as { status: string }[])[0].status, "open");
});

test("R5: latest key-correct verdict reverses an older correction and uses only the learner's real error cause", () => {
  const f = fixture("retested-pass", false),
    older = review(f.fresh, "key-wrong"),
    newer = review(f.fresh, "key-correct");
  f.context.records = [...f.context.records, newer, older];
  const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
  assert.equal(status(result.evaluation.payload), "retested-fail");
  assert.equal(
    result.evaluation.nextRound?.payload.sourceRevisionId,
    f.retest.revisionId,
  );
  assert.equal(
    result.evaluation.nextRound?.payload.items[0].errorCause,
    "vocab-unknown",
  );
});

test("R5: an all-ambiguous target type removes an old pass and stays corrected, pending fresh evidence", () => {
  const f = fixture();
  f.context.records = [
    ...f.context.records,
    ...f.fresh.questions.map((question) =>
      review(f.fresh, "ambiguous", question.id),
    ),
  ];
  const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
  assert.equal(result.recheck, true);
  assert.equal(result.payloadChanged, true);
  assert.equal(status(result.evaluation.payload), "corrected");
  assert.match(result.evaluation.pending!, /不能空集通过/);
  assert.deepEqual(result.evaluation.outcomes, []);
  assert.equal(result.evaluation.nextRound, null);
});

test("R5: a single ambiguous question is excluded, and the other target question still determines the result", () => {
  const f = fixture("retested-fail", false);
  f.context.records = [...f.context.records, review(f.fresh, "ambiguous")];
  const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
  assert.equal(status(result.evaluation.payload), "retested-pass");
  assert.equal(result.evaluation.pending, null);
});

test("R5: changed hash, version, or unknown question invalidates a previous answer review", () => {
  for (const field of [
    "contentHash",
    "contentVersion",
    "questionId",
  ] as const) {
    const f = fixture(),
      audit = review(f.fresh, "key-wrong");
    audit.payload[field] =
      field === "contentHash" ? "c".repeat(64) : "different";
    f.context.records = [...f.context.records, audit];
    const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
    assert.equal(result.recheck, false);
    assert.equal(result.payloadChanged, false);
    assert.equal(status(result.evaluation.payload), "retested-pass");
  }
});

test("R5: a review cannot bypass the exact retest origin, first-answer boundary, or holdout policy", () => {
  for (const boundary of ["origin", "first", "holdout"] as const) {
    const f = fixture();
    if (boundary === "origin")
      f.retest.payload.retestOf = "00000000-0000-4000-8000-999999999999";
    if (boundary === "first") f.retest.payload.firstAttempt = false;
    if (boundary === "holdout") f.fresh.pool = "holdout";
    f.context.records = [...f.context.records, review(f.fresh, "key-wrong")];
    const result = evaluateReviewedRetest(f.correction, f.retest, f.context);
    assert.equal(result.recheck, false);
    assert.equal(status(result.evaluation.payload), "retested-pass");
  }
});
