import test from "node:test";
import assert from "node:assert/strict";
import type { Revision } from "./protocol";
import type { LocalMaterial } from "./localBankSchema";
import {
  buildCorrection,
  correctionItemKey,
  updateCorrectionItems,
} from "./correctionModel";
import {
  evaluateRetest,
  assertRetestMaterialEligible,
  selectRetest,
  unseenListeningReading,
  type RetestContext,
  type RetestPrompt,
} from "./retestSelection";
let sequence = 0;
const revision = (
  kind: string,
  payload: Record<string, unknown>,
  id = `record-${++sequence}`,
): Revision => ({
  id,
  kind: kind as Revision["kind"],
  planId: "plan",
  datasetId: null,
  payload: { planId: "plan", ...payload },
  revisionId: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  baseRevision: null,
  seq: sequence,
  createdAt: sequence,
  contentHash: "a".repeat(64),
  deleted: false,
  conflict: false,
});
const paper = (
  id: string,
  patch: Partial<LocalMaterial> = {},
): LocalMaterial => {
  const passage = `This is the self-authored original passage for ${id}. A record is kept.`;
  return {
    id,
    version: "1",
    contentHash: id.charCodeAt(0).toString(16).padStart(64, "0"),
    title: id,
    skill: "reading",
    deliveryMode: "local-import",
    scope: "section",
    source: {
      materialSource: "official",
      sourceRef: `synthetic:${id}`,
      rights: "Self-authored test fixture",
      answerVerified: true,
    },
    passage,
    paragraphs: [{ id: "p1", text: passage }],
    passageNumber: 1,
    questions: [
      {
        id: `${id}-q1`,
        type: "true-false-not-given",
        prompt: "Synthetic question one",
        answer: { accepted: ["TRUE"], maxWords: 2 },
        evidence: {},
        answerVerified: true,
      },
      {
        id: `${id}-q2`,
        type: "multiple-choice",
        prompt: "Synthetic question two",
        answer: { accepted: ["A"], maxWords: 1 },
        options: [
          { id: "A", text: "A record" },
          { id: "B", text: "No record" },
        ],
        evidence: {},
        answerVerified: true,
      },
    ],
    ...patch,
  } as LocalMaterial;
};
const listening = (
  id: string,
  section: 1 | 2 | 3 | 4,
  examId = "exam",
): LocalMaterial =>
  ({
    ...paper(id),
    skill: "listening",
    scope: "section",
    examId,
    section,
    transcript: `Self-authored listening transcript for ${id}.`,
    audio: {
      path: `audio/${id}.wav`,
      durationSeconds: 10,
      sha256: id
        .charCodeAt(id.length - 1)
        .toString(16)
        .padStart(64, "0"),
    },
    questions: paper(id).questions.map((question, index) =>
      index === 0
        ? {
            ...question,
            type: "sentence-completion",
            answer: { accepted: ["record"], maxWords: 1 },
          }
        : question,
    ),
  }) as LocalMaterial;
const workFor = (
  material: LocalMaterial,
  correct = [false, true],
  date = "2026-11-09",
) =>
  revision("attempt", {
    date,
    day: 1,
    skill: material.skill,
    contentId: material.id,
    contentVersion: material.version,
    contentHash: material.contentHash,
    materialSource: material.source.materialSource,
    sourceRef: material.source.sourceRef,
    scope: material.scope,
    firstAttempt: true,
    total: material.questions.length,
    score: correct.filter(Boolean).length,
    correct: correct.filter(Boolean).length,
    answers: material.questions.map((question, i) =>
      correct[i] ? question.answer.accepted[0] : "incorrect",
    ),
    reviewAnswers: material.questions.map(
      (question) => question.answer.accepted[0],
    ),
    questionResults: material.questions.map((question, i) => ({
      questionId: question.id,
      correct: correct[i],
      reviewCorrect: true,
      confidence: "sure",
      errorCause: correct[i]
        ? null
        : material.skill === "listening"
          ? "spelling"
          : "tfng-inference",
    })),
  });
function corrected(source: Revision, records: Revision[] = []) {
  const draft = buildCorrection(source, {
    planId: "plan",
    date: "2026-11-09",
    day: 1,
    records,
  })!;
  const updates = Object.fromEntries(
    draft.payload.items.map((item) => [
      correctionItemKey(item),
      { status: "corrected" as const },
    ]),
  );
  return revision(
    "correction",
    updateCorrectionItems(draft.payload, updates, "2026-11-10", 2),
    draft.id,
  );
}
const context = (
  records: Revision[],
  materials: LocalMaterial[],
  prompts: RetestPrompt[] = [],
  patch: Partial<RetestContext> = {},
): RetestContext => ({
  planId: "plan",
  date: "2026-11-11",
  day: 3,
  records,
  materials,
  prompts,
  ...patch,
});
const prompt = (
  id: string,
  patch: Partial<RetestPrompt> = {},
): RetestPrompt => ({
  id,
  version: "1",
  contentHash: "b".repeat(64),
  skill: "writing",
  prompt: `A self-authored opinion question about ${id}.`,
  sourceRef: `synthetic:${id}`,
  materialSource: "unofficial",
  taskType: "task2",
  questionType: "opinion",
  ...patch,
});
function speakingOrWriting(kind: "essay" | "speaking", material: RetestPrompt) {
  return revision(kind, {
    date: "2026-11-09",
    contentId: material.id,
    contentVersion: material.version,
    prompt: material.prompt,
    ...(kind === "essay"
      ? {
          taskType: material.taskType,
          scope: "full",
          stage: "submitted",
          text: "A saved original.",
        }
      : { part: material.part, transcript: "A saved original." }),
  });
}
const feedbackFor = (work: Revision, errorCauses: string[]) =>
  revision("feedback", {
    workId: work.id,
    workRevisionId: work.revisionId,
    inputHash: work.contentHash,
    source: "self",
    errorCauses,
    taskType: work.kind === "essay" ? work.payload.taskType : "speaking",
  });
test("T3: same civil day waits; the next natural day can select a new matching material", () => {
  const original = paper("original"),
    fresh = paper("fresh"),
    source = workFor(original),
    correction = corrected(source);
  const today = selectRetest(
    correction,
    context([source], [original, fresh], [], { date: "2026-11-10", day: 2 }),
  );
  assert.equal(today.material, null);
  assert.equal(today.reason, "next-day");
  assert.equal(today.missingCount, 0);
  const tomorrow = selectRetest(
    correction,
    context([source], [original, fresh]),
  );
  assert.equal(tomorrow.material?.id, fresh.id);
  assert.equal(tomorrow.retestOf, source.revisionId);
  assert.equal(tomorrow.estimatedMinutes, 20);
});
test("T3: incomplete corrections and already tested items do not start another retest", () => {
  const material = paper("old"),
    source = workFor(material),
    draft = buildCorrection(source, {
      planId: "plan",
      date: "2026-11-09",
      day: 1,
      records: [],
    })!;
  const open = revision("correction", draft.payload, draft.id);
  assert.equal(
    selectRetest(open, context([source], [material])).reason,
    "waiting-correction",
  );
  const finished = corrected(source);
  (finished.payload.items as { status: string }[])[0].status = "retested-pass";
  assert.equal(
    selectRetest(finished, context([source], [material])).reason,
    "complete",
  );
});
test("T3: exact prior materials, body-renumbering aliases and holdout aliases are excluded", () => {
  const original = paper("old"),
    source = workFor(original),
    correction = corrected(source);
  const sameBody = {
    ...original,
    id: "renumbered",
    version: "2",
    contentHash: "c".repeat(64),
    questions: original.questions.map((question) => ({
      ...question,
      id: `new-${question.id}`,
    })),
  };
  const holdout = paper("holdout", { pool: "holdout" }),
    holdoutAlias = { ...holdout, id: "alias", pool: "practice" as const };
  const selected = selectRetest(
    correction,
    context([source], [original, sameBody, holdout, holdoutAlias]),
  );
  assert.equal(selected.material, null);
  assert.equal(selected.missingCount, 1);
  assert.match(selected.notice, /还缺1/);
});
test("T3: source tier favors official/Cambridge, then the original source", () => {
  const original = paper("old"),
    source = workFor(original),
    correction = corrected(source);
  const unofficial = paper("aaa-unofficial", {
      source: { ...original.source, materialSource: "unofficial" },
    }),
    cambridge = paper("bbb-cambridge", {
      source: { ...original.source, materialSource: "cambridge" },
    }),
    official = paper("zzz-official");
  assert.equal(
    selectRetest(
      correction,
      context([source], [original, unofficial, cambridge, official]),
    ).material?.id,
    official.id,
  );
});
test("T3: doing S1 does not consume S2, but a previously done full exam consumes its sections", () => {
  const first = listening("listen1", 1),
    second = listening("listen2", 2),
    firstWork = workFor(first);
  assert.equal(
    unseenListeningReading(second, [firstWork], [first, second], "plan"),
    true,
  );
  const full = {
    ...first,
    id: "whole",
    scope: "full" as const,
    transcript: "The whole original is different from one section.",
  };
  assert.equal(
    unseenListeningReading(
      second,
      [workFor(full)],
      [first, second, full],
      "plan",
    ),
    false,
  );
  const sameAudio = {
    ...second,
    audio: first.skill === "listening" ? first.audio : undefined,
  } as LocalMaterial;
  assert.equal(
    unseenListeningReading(sameAudio, [firstWork], [first, sameAudio], "plan"),
    false,
  );
});
test("T3: wrong skill/type cannot fill a gap and another plan cannot consume this plan new material", () => {
  const original = paper("old"),
    source = workFor(original),
    correction = corrected(source),
    fresh = paper("fresh");
  const foreign = {
    ...workFor(fresh),
    planId: "other",
    payload: { ...workFor(fresh).payload, planId: "other" },
  };
  assert.equal(
    selectRetest(correction, context([source, foreign], [original, fresh]))
      .material?.id,
    fresh.id,
  );
  const otherType = paper("other-type", { questions: [fresh.questions[1]] });
  assert.equal(
    selectRetest(
      correction,
      context([source], [original, otherType, listening("listen1", 1)]),
    ).material,
    null,
  );
});
test("T3: original material version/hash must be available to establish a matching type", () => {
  const original = paper("old"),
    source = workFor(original),
    correction = corrected(source);
  assert.equal(
    selectRetest(
      correction,
      context(
        [source],
        [{ ...original, contentHash: "c".repeat(64) }, paper("fresh")],
      ),
    ).reason,
    "missing-source",
  );
});
test("T3: writing selects explicit same Task/subtype, excludes prompt aliases and never treats unknown as classified", () => {
  const old = prompt("old"),
    original = speakingOrWriting("essay", old),
    issue = feedbackFor(original, ["grammar"]),
    correction = corrected(issue, [original]);
  const wrongTask = prompt("task-one", {
      taskType: "task1",
      stimulusHash: "d".repeat(64),
    }),
    wrongType = prompt("discussion", { questionType: "discussion" }),
    alias = prompt("alias", { prompt: old.prompt }),
    fresh = prompt("fresh");
  assert.equal(
    selectRetest(
      correction,
      context([original, issue], [], [old, wrongTask, wrongType, alias, fresh]),
    ).material?.id,
    fresh.id,
  );
  assert.equal(
    selectRetest(
      correction,
      context(
        [original, issue],
        [],
        [
          { ...old, questionType: "unknown" },
          { ...fresh, questionType: "unknown" },
        ],
      ),
    ).reason,
    "missing-classification",
  );
});
test("T3: Task1 cannot select a question missing its actual chart stimulus", () => {
  const old = prompt("old-chart", {
      taskType: "task1",
      questionType: "bar-chart",
      stimulusHash: "d".repeat(64),
    }),
    original = speakingOrWriting("essay", old),
    issue = feedbackFor(original, ["task-achievement"]),
    correction = corrected(issue, [original]);
  const missing = prompt("missing-chart", {
    taskType: "task1",
    questionType: "bar-chart",
  });
  assert.equal(
    selectRetest(correction, context([original, issue], [], [old, missing]))
      .material,
    null,
  );
});
test("T3: speaking selects same Part and rejects held-out or renamed old prompts", () => {
  const old = prompt("speaking-old", { skill: "speaking", part: 2 }),
    original = speakingOrWriting("speaking", old),
    issue = feedbackFor(original, ["fluency-pause"]),
    correction = corrected(issue, [original]);
  const fresh = prompt("speaking-fresh", { skill: "speaking", part: 2 }),
    wrong = prompt("speaking-part1", { skill: "speaking", part: 1 }),
    alias = { ...fresh, id: "held-alias" },
    held = { ...fresh, pool: "holdout" as const };
  assert.equal(
    selectRetest(
      correction,
      context([original, issue], [], [old, wrong, alias, held]),
    ).material,
    null,
  );
  assert.equal(
    selectRetest(
      correction,
      context([original, issue], [], [old, wrong, fresh]),
    ).material?.id,
    fresh.id,
  );
});
test("T4: a correct new target type passes only its correction; raw scores and assessments stay unchanged", () => {
  const old = paper("old"),
    fresh = paper("fresh"),
    source = workFor(old),
    correction = corrected(source),
    retest = workFor(fresh, [true, true], "2026-11-11");
  Object.assign(retest.payload, {
    correctionId: correction.id,
    retestOf: source.revisionId,
  });
  const gate = revision("assessment", {
    date: "2026-11-09",
    kind: "official",
    source: "official",
    scores: { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 },
  });
  const records = [source, retest, gate],
    before = structuredClone(records),
    result = evaluateRetest(correction, retest, context(records, [old, fresh]));
  assert.equal(result.pending, null);
  assert.equal(result.payload.items[0].status, "retested-pass");
  assert.equal(result.nextRound, null);
  assert.deepEqual(records, before);
  assert.equal(source.payload.score, 1);
  assert.equal(retest.payload.score, 2);
});
test("T4: one incorrect target question fails and creates a new exact-source correction round", () => {
  const old = paper("old"),
    fresh = paper("fresh"),
    source = workFor(old),
    correction = corrected(source),
    retest = workFor(fresh, [false, true], "2026-11-11");
  Object.assign(retest.payload, {
    correctionId: correction.id,
    retestOf: source.revisionId,
  });
  const result = evaluateRetest(
    correction,
    retest,
    context([source, retest], [old, fresh]),
  );
  assert.equal(result.payload.items[0].status, "retested-fail");
  assert.equal(result.nextRound?.payload.sourceRevisionId, retest.revisionId);
  assert.equal(result.nextRound?.payload.items[0].status, "open");
});
test("T4: every target-type question must be correct; a different-type error does not change that result", () => {
  const old = paper("old"),
    fresh = paper("fresh"),
    source = workFor(old),
    correction = corrected(source),
    retest = workFor(fresh, [true, false], "2026-11-11");
  Object.assign(retest.payload, {
    correctionId: correction.id,
    retestOf: source.revisionId,
  });
  assert.equal(
    evaluateRetest(correction, retest, context([source, retest], [old, fresh]))
      .payload.items[0].status,
    "retested-pass",
  );
  const twoTargets = paper("two-targets");
  twoTargets.questions[1] = { ...twoTargets.questions[0], id: "second-target" };
  const failure = workFor(twoTargets, [true, false], "2026-11-11");
  Object.assign(failure.payload, {
    correctionId: correction.id,
    retestOf: source.revisionId,
  });
  assert.equal(
    evaluateRetest(
      correction,
      failure,
      context([source, failure], [old, twoTargets]),
    ).payload.items[0].status,
    "retested-fail",
  );
});
test("T4/T6: ambiguous exclusions cannot produce an empty-set pass; corrected key projection can change only the outcome", () => {
  const old = paper("old"),
    fresh = paper("fresh"),
    source = workFor(old),
    correction = corrected(source),
    retest = workFor(fresh, [false, true], "2026-11-11");
  Object.assign(retest.payload, {
    correctionId: correction.id,
    retestOf: source.revisionId,
  });
  const base = context([source, retest], [old, fresh]);
  assert.match(
    evaluateRetest(correction, retest, {
      ...base,
      questionResults: {
        [fresh.questions[0].id]: { correct: false, excluded: true },
      },
    }).pending!,
    /空集/,
  );
  assert.equal(
    evaluateRetest(correction, retest, {
      ...base,
      questionResults: { [fresh.questions[0].id]: { correct: true } },
    }).payload.items[0].status,
    "retested-pass",
  );
  assert.equal(retest.payload.score, 1);
});
test("T4: stale origin, familiar attempts and unfinished retests cannot pass", () => {
  const old = paper("old"),
    fresh = paper("fresh"),
    source = workFor(old),
    correction = corrected(source),
    retest = workFor(fresh, [true, true], "2026-11-11");
  Object.assign(retest.payload, {
    correctionId: correction.id,
    retestOf: "00000000-0000-4000-8000-999999999999",
  });
  const base = context([source, retest], [old, fresh]);
  assert.match(evaluateRetest(correction, retest, base).pending!, /绑定/);
  retest.payload.retestOf = source.revisionId;
  retest.payload.firstAttempt = false;
  assert.match(evaluateRetest(correction, retest, base).pending!, /熟题/);
  retest.payload.firstAttempt = true;
  delete (retest.payload.questionResults as Record<string, unknown>[])[0]
    .reviewCorrect;
  assert.match(evaluateRetest(correction, retest, base).pending!, /复盘/);
});
test("T4: writing/speaking require matching new-work feedback; self/AI success remains an estimate", () => {
  for (const kind of ["essay", "speaking"] as const) {
    const skill = kind === "essay" ? "writing" : "speaking";
    const old = prompt("old-question", { skill, part: 2 }),
      fresh = prompt("fresh-question", { skill, part: 2 }),
      original = speakingOrWriting(kind, old),
      issue = feedbackFor(original, ["grammar"]),
      correction = corrected(issue, [original]);
    const retest = speakingOrWriting(kind, fresh);
    Object.assign(retest.payload, {
      date: "2026-11-11",
      correctionId: correction.id,
      retestOf: original.revisionId,
    });
    const base = context([original, issue, retest], [], [old, fresh]);
    assert.match(evaluateRetest(correction, retest, base).pending!, /反馈/);
    const good = feedbackFor(retest, []);
    const result = evaluateRetest(correction, retest, {
      ...base,
      records: [...base.records, good],
    });
    assert.equal(result.payload.items[0].status, "retested-pass");
    assert.equal(result.estimate, true);
    good.payload.inputHash = "d".repeat(64);
    assert.match(
      evaluateRetest(correction, retest, {
        ...base,
        records: [...base.records, good],
      }).pending!,
      /反馈/,
    );
  }
});
test("T4: a recurring writing dimension fails and creates a feedback-bound new correction", () => {
  const old = prompt("old"),
    fresh = prompt("fresh"),
    original = speakingOrWriting("essay", old),
    issue = feedbackFor(original, ["spelling"]),
    correction = corrected(issue, [original]);
  const retest = speakingOrWriting("essay", fresh);
  Object.assign(retest.payload, {
    date: "2026-11-11",
    correctionId: correction.id,
    retestOf: original.revisionId,
  });
  const nextIssue = feedbackFor(retest, ["lexical-misuse"]),
    result = evaluateRetest(
      correction,
      retest,
      context([original, issue, retest, nextIssue], [], [old, fresh]),
    );
  assert.equal(result.payload.items[0].status, "retested-fail");
  assert.equal(
    result.nextRound?.payload.sourceRevisionId,
    nextIssue.revisionId,
  );
});
test("T4: changing a new writing ID while writing the old prompt cannot count as a new-topic retest", () => {
  const old = prompt("old"),
    fresh = prompt("fresh"),
    original = speakingOrWriting("essay", old),
    issue = feedbackFor(original, ["grammar"]),
    correction = corrected(issue, [original]);
  const retest = speakingOrWriting("essay", fresh);
  Object.assign(retest.payload, {
    date: "2026-11-11",
    prompt: old.prompt,
    correctionId: correction.id,
    retestOf: original.revisionId,
  });
  const result = evaluateRetest(
    correction,
    retest,
    context(
      [original, issue, retest, feedbackFor(retest, [])],
      [],
      [old, fresh],
    ),
  );
  assert.match(result.pending!, /题目/);
  assert.equal(result.payload.items[0].status, "corrected");
});
test("T3: paragraph retests retain paragraph scope and expose a 20-minute estimate", () => {
  const old = prompt("old"),
    fresh = prompt("fresh"),
    original = speakingOrWriting("essay", old);
  original.payload.scope = "paragraph";
  const issue = feedbackFor(original, ["grammar"]),
    correction = corrected(issue, [original]);
  assert.equal(
    selectRetest(correction, context([original, issue], [], [old, fresh]))
      .estimatedMinutes,
    20,
  );
});

test("T3: editing an original writing prompt cannot reuse its old ID/version subtype", () => {
  const old = prompt("old-opinion"),
    fresh = prompt("fresh-opinion"),
    original = speakingOrWriting("essay", old);
  original.payload.prompt = "A different synthetic topic. Discuss both views.";
  const issue = feedbackFor(original, ["grammar"]),
    correction = corrected(issue, [original]);
  const selected = selectRetest(
    correction,
    context([original, issue], [], [old, fresh]),
  );
  assert.equal(selected.material, null);
  assert.equal(selected.reason, "missing-classification");
});

test("T3: direct-entry validation accepts a non-first eligible material and rejects same-ID wrong hashes", () => {
  const old = paper("old"),
    freshA = paper("fresh-a"),
    freshB = paper("fresh-b"),
    source = workFor(old),
    correction = corrected(source);
  const ctx = context([source], [old, freshA, freshB]);
  assert.equal(selectRetest(correction, ctx).material?.id, freshA.id);
  assert.doesNotThrow(() =>
    assertRetestMaterialEligible(correction, freshB, ctx),
  );
  assert.throws(
    () =>
      assertRetestMaterialEligible(
        correction,
        { ...freshB, contentHash: "f".repeat(64) },
        ctx,
      ),
    /不符合/,
  );
});
test("T3: direct-entry validation cannot bypass prior originals, holdouts, same-day or unfinished corrections", () => {
  const old = paper("old"),
    held = paper("held", { pool: "holdout" }),
    fresh = paper("fresh"),
    source = workFor(old),
    correction = corrected(source),
    ctx = context([source], [old, held, fresh]);
  assert.throws(
    () => assertRetestMaterialEligible(correction, old, ctx),
    /不符合/,
  );
  assert.throws(
    () => assertRetestMaterialEligible(correction, held, ctx),
    /不符合/,
  );
  assert.throws(
    () =>
      assertRetestMaterialEligible(correction, fresh, {
        ...ctx,
        date: "2026-11-10",
        day: 2,
      }),
    /至少隔/,
  );
  const open = {
    ...correction,
    payload: {
      ...correction.payload,
      items: (correction.payload.items as { status: string }[]).map((item) => ({
        ...item,
        status: "open",
      })),
    },
  };
  assert.throws(
    () => assertRetestMaterialEligible(open, fresh, ctx),
    /完成本组订正/,
  );
});
test("T3: direct writing entry cannot bypass subtype or pool by editing its URL", () => {
  const old = prompt("old"),
    fresh = prompt("fresh"),
    wrong = prompt("wrong-family", { questionType: "discussion" }),
    held = prompt("held", { pool: "holdout" });
  const original = speakingOrWriting("essay", old),
    issue = feedbackFor(original, ["grammar"]),
    correction = corrected(issue, [original]);
  const ctx = context([original, issue], [], [old, fresh, wrong, held]);
  assert.doesNotThrow(() =>
    assertRetestMaterialEligible(correction, fresh, ctx),
  );
  assert.throws(
    () => assertRetestMaterialEligible(correction, wrong, ctx),
    /不符合/,
  );
  assert.throws(
    () => assertRetestMaterialEligible(correction, held, ctx),
    /不符合/,
  );
});
