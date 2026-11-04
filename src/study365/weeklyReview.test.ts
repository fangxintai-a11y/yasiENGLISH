import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { LocalMaterial, LocalQuestion } from "./localBankSchema";
import type { CorrectionItem } from "./correctionModel";
import {
  ADJUSTMENT_ACTIONS,
  SECTION_TARGETS,
  canonical,
  validatePayload,
  type LearningPayload,
  type Revision,
} from "./protocol";
import {
  ADJUSTMENT_RULES,
  calibrationNeedsReview,
  causeNeedsFocus,
  questionTypeNeedsFocus,
} from "./adjustmentRules";
import {
  acceptedMaterialPreferences,
  adjustmentRecordId,
  buildAdjustmentPayload,
  buildWeeklyReview,
  originalReviewCorrection,
  prioritizeCorrections,
  prioritizeMaterials,
  type AdjustmentSuggestion,
} from "./weeklyReview";
import { buildDayPlan } from "./planEngine";
import { bundledRules } from "./planData";
import { dayDate } from "./calendar";
let serial = 0;
function revision(
  kind: Revision["kind"],
  payload: LearningPayload,
  id?: string,
): Revision {
  const index = ++serial,
    text =
      kind === "essay"
        ? String(payload.text ?? "")
        : kind === "speaking"
          ? String(payload.transcript ?? "")
          : canonical(payload);
  return {
    id: id ?? `record-${index}`,
    kind,
    datasetId: null,
    planId: String(payload.planId ?? "p"),
    revisionId: `a5000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    baseRevision: null,
    seq: index,
    createdAt: index,
    payload,
    contentHash: createHash("sha256").update(text).digest("hex"),
    conflict: false,
    deleted: false,
    payloadVersion: 2,
  };
}
const plan = revision(
  "plan",
  {
    planId: "p",
    startDate: "2026-11-09",
    timeZone: "Asia/Shanghai",
    studyBudgetMinutes: 120,
    targetBand: 8,
    sectionTargets: SECTION_TARGETS,
  },
  "p",
);
function material(
  id: string,
  skill: "reading" | "listening" = "reading",
  type: LocalQuestion["type"] = "multiple-choice",
  total = 10,
  official = false,
): LocalMaterial {
  const questions = Array.from({ length: total }, (_, i) => ({
    id: `${id}-q${i + 1}`,
    type,
    number: i + 1,
    prompt: `Self-authored question ${i + 1}`,
    answer: { accepted: ["A"], maxWords: 1 },
    evidence: { quote: "Self-authored evidence." },
    answerVerified: true,
  }));
  const base = {
    id,
    version: "1",
    contentHash: "a".repeat(64),
    title: id,
    deliveryMode: "local-import" as const,
    source: {
      materialSource: official
        ? ("official" as const)
        : ("unofficial" as const),
      sourceRef: `synthetic:${id}`,
      rights: "Self-authored test fixture",
      answerVerified: true,
    },
    scope: official ? ("type-drill" as const) : ("section" as const),
    pool: "practice" as const,
    questions,
  };
  return skill === "reading"
    ? {
        ...base,
        skill,
        passage: "Self-authored evidence.",
        paragraphs: [{ id: "p1", text: "Self-authored evidence." }],
        passageNumber: 1,
      }
    : {
        ...base,
        skill,
        transcript: "Self-authored evidence.",
        section: 1,
        audio: {
          path: "audio/synthetic.mp3",
          durationSeconds: 10,
          sha256: "b".repeat(64),
        },
      };
}
function attempt(
  bank: LocalMaterial,
  correct: number,
  date = "2026-11-20",
  cause = "vocab-unknown",
  extra: LearningPayload = {},
): Revision {
  const results = bank.questions.map((q, i) => ({
    questionId: q.id,
    correct: i < correct,
    reviewCorrect: true,
    confidence: "sure",
    errorCause: i < correct ? null : cause,
  }));
  return revision("attempt", {
    planId: "p",
    date,
    contentId: bank.id,
    contentVersion: bank.version,
    contentHash: bank.contentHash,
    skill: bank.skill,
    materialSource: bank.source.materialSource,
    sourceRef: bank.source.sourceRef,
    scope: bank.scope,
    firstAttempt: true,
    answers: bank.questions.map((_, i) => (i < correct ? "A" : "B")),
    reviewAnswers: bank.questions.map(() => "A"),
    score: correct,
    correct,
    total: bank.questions.length,
    questionResults: results,
    ...extra,
  });
}
const input = (
  records: Revision[],
  bank: LocalMaterial[] = [],
  date = "2026-11-22",
) => ({ plan, records, bank, date });
function pair(
  week: number,
  source: "self" | "ai" | "rules" = "self",
  delta = 0.5,
  taskType: "task1" | "task2" | "speaking" = "task2",
) {
  const date = dayDate(
      String(plan.payload.startDate),
      "Asia/Shanghai",
      1 + (week - 1) * 7,
    ),
    writing = taskType !== "speaking";
  const work = revision(writing ? "essay" : "speaking", {
    planId: "p",
    date,
    contentId: `work-${serial}`,
    contentVersion: "1",
    prompt: "Self-authored prompt",
    ...(writing
      ? {
          text: "Self-authored original.",
          taskType,
          scope: "full",
          stage: "submitted",
        }
      : { transcript: "Self-authored spoken original.", part: 1 }),
  });
  const bands = writing
    ? {
        [taskType === "task1" ? "taskAchievement" : "taskResponse"]: 6,
        coherence: 6,
        lexical: 6,
        grammar: 6,
      }
    : { fluency: 6, lexical: 6, grammar: 6, pronunciation: 6 };
  const common = {
    planId: "p",
    date,
    kind: "weekly-calibration",
    weekIndex: week,
    workId: work.id,
    workRevisionId: work.revisionId,
    inputHash: work.contentHash,
    ...(writing ? { taskType } : {}),
  };
  return [
    work,
    revision("assessment", { ...common, source: "human", bands }),
    revision("assessment", {
      ...common,
      source,
      bands: { ...bands, grammar: 6 + delta },
    }),
  ];
}
function correction(
  original: Revision,
  statuses: ("retested-fail" | "retested-pass")[],
  date: string,
  cause = "vocab-unknown",
) {
  return revision("correction", {
    planId: "p",
    date,
    day: 2,
    skill: original.payload.skill,
    sourceKind: "attempt",
    sourceId: original.id,
    sourceRevisionId: original.revisionId,
    items: statuses.map((status, i) => ({
      questionId: (
        original.payload.questionResults as { questionId: string }[]
      )[i].questionId,
      errorCause: cause,
      action: "vocab-review",
      status,
    })),
  });
}
function chain(states: ("retested-fail" | "retested-pass")[]) {
  const bank = states.map((_, i) => material(`chain-${serial}-${i}`));
  bank.push(material(`chain-${serial}-last`));
  let original = attempt(bank[0], 0, "2026-11-10");
  const records = [original];
  for (const [i, status] of states.entries()) {
    const c = correction(
      original,
      [status],
      dayDate("2026-11-09", "Asia/Shanghai", i + 2),
    );
    const retest = attempt(
      bank[i + 1],
      status === "retested-pass" ? 10 : 0,
      dayDate("2026-11-09", "Asia/Shanghai", i + 3),
      "vocab-unknown",
      { correctionId: c.id, retestOf: original.revisionId },
    );
    records.push(c, retest);
    original = retest;
  }
  return { records, bank };
}
const proposal: AdjustmentSuggestion = {
  id: "focus-reading-choice",
  skill: "reading",
  questionType: "multiple-choice",
  reason: "Self-authored measured weakness.",
  evidence: {
    recordIds: ["evidence"],
    metric: "type-accuracy-percent",
    value: 70,
    threshold: 80,
  },
  action: "prefer-question-type",
};
const evidence = revision(
  "attempt",
  {
    planId: "p",
    date: "2026-11-15",
    skill: "reading",
    contentId: "source",
    answers: [],
  },
  "evidence",
);
const decision = (
  state: "accepted" | "rejected" | "pending",
  week = 1,
  suggestion = proposal,
  id = "choice",
) =>
  revision(
    "adjustment",
    buildAdjustmentPayload(
      "p",
      week,
      "2026-11-15",
      suggestion,
      state,
      state === "pending" ? undefined : 1,
    ),
    id,
  );

test("T5: rule boundaries are 79.9/80 percent, 9/10 samples, 4/5 errors and 0.49/0.5 delta", () => {
  assert.equal(questionTypeNeedsFocus(0.799, 1000), true);
  assert.equal(questionTypeNeedsFocus(0.8, 1000), false);
  assert.equal(questionTypeNeedsFocus(0.7, 9), false);
  assert.equal(questionTypeNeedsFocus(0.7, 10), true);
  assert.equal(causeNeedsFocus(4), false);
  assert.equal(causeNeedsFocus(5), true);
  assert.equal(calibrationNeedsReview(0.49), false);
  assert.equal(calibrationNeedsReview(0.5), true);
  assert.equal(calibrationNeedsReview(-0.5), true);
  assert.equal(questionTypeNeedsFocus(NaN, 10), false);
  assert.equal(ADJUSTMENT_RULES.questionType.minimumQuestions, 10);
});
test("T5: reading and listening retain separate same-type denominators and evidence", () => {
  const r = material("read"),
    l = material("listen", "listening"),
    rr = attempt(r, 5),
    ll = attempt(l, 9);
  const value = buildWeeklyReview(input([rr, ll], [r, l]));
  assert.deepEqual(
    value.summaries
      .find((row) => row.skill === "reading")!
      .types.map((row) => [row.correct, row.total, row.recordIds]),
    [[5, 10, [rr.id]]],
  );
  assert.deepEqual(
    value.summaries
      .find((row) => row.skill === "listening")!
      .types.map((row) => [row.correct, row.total, row.recordIds]),
    [[9, 10, [ll.id]]],
  );
  assert.ok(
    value.suggestions.some(
      (row) => row.action === "prefer-question-type" && row.skill === "reading",
    ),
  );
  assert.equal(
    value.suggestions.some(
      (row) =>
        row.action === "prefer-question-type" && row.skill === "listening",
    ),
    false,
  );
});
test("T5: exactly ten questions and five errors trigger evidence-bound advice; nine and four do not", () => {
  const small = material("nine", "reading", "multiple-choice", 9),
    full = material("ten");
  const below = buildWeeklyReview(input([attempt(small, 5)], [small]));
  assert.equal(below.suggestions.length, 0);
  const measured = buildWeeklyReview(input([attempt(full, 5)], [full]));
  assert.deepEqual(
    new Set(measured.suggestions.map((row) => row.action)),
    new Set(["prefer-question-type", "prioritize-error-cause"]),
  );
  for (const suggestion of measured.suggestions) {
    assert.ok(suggestion.evidence.recordIds.length);
    assert.ok(Number.isFinite(suggestion.evidence.value));
    assert.ok(Number.isFinite(suggestion.evidence.threshold));
    assert.ok(ADJUSTMENT_ACTIONS.includes(suggestion.action));
    assert.doesNotMatch(
      JSON.stringify(suggestion),
      /"(?:minutes|plannedMinutes|budgetMinutes)"/,
    );
  }
});
test("T5: twenty-eight civil days are inclusive, future and previous-window attempts are excluded", () => {
  const r = material("bounds");
  const first = attempt(r, 0, "2026-10-26"),
    old = attempt(r, 0, "2026-10-25"),
    future = attempt(r, 0, "2026-11-23");
  const value = buildWeeklyReview(input([first, old, future], [r]));
  assert.equal(value.since, "2026-10-26");
  assert.equal(
    value.summaries.find((row) => row.skill === "reading")!.types[0].total,
    10,
  );
});
test("T5: official first-answer calibration is reused; derived answer-review statistics cannot alter original score gaps", () => {
  const r = material("official", "reading", "multiple-choice", 1, true),
    raw = attempt(r, 0),
    projected = {
      ...raw,
      payload: {
        ...raw.payload,
        questionResults: [
          {
            questionId: r.questions[0].id,
            correct: true,
            reviewCorrect: true,
            confidence: "sure",
            errorCause: null,
          },
        ],
      },
    };
  const before = canonical(raw),
    value = buildWeeklyReview({
      ...input([raw], [r]),
      statisticsRecords: [projected],
      officialCalibration: [
        {
          skill: "reading",
          questionType: "multiple-choice",
          correct: 1,
          total: 1,
          accuracy: 1,
          attemptIds: [raw.id],
        },
      ],
    });
  assert.equal(value.officialCalibration[0].correct, 1);
  assert.equal(
    value.summaries.find((row) => row.skill === "reading")!.types[0].correct,
    1,
  );
  assert.equal(value.scores.reading, null);
  assert.equal(canonical(raw), before);
  assert.equal(
    buildWeeklyReview(input([raw], [r])).officialCalibration[0].correct,
    0,
  );
});
test("T5: missing post-review error causes are not invented or counted as five confirmed errors", () => {
  const r = material("unknown-cause"),
    work = attempt(r, 0);
  work.payload.questionResults = (
    work.payload.questionResults as Record<string, unknown>[]
  ).map((row) => ({ ...row, errorCause: null }));
  const value = buildWeeklyReview(input([work], [r]));
  assert.deepEqual(
    value.summaries.find((row) => row.skill === "reading")!.causes,
    [],
  );
  assert.equal(
    value.suggestions.some((row) => row.action === "prioritize-error-cause"),
    false,
  );
});
test("T5: writing and speaking count exact-current-work feedback, not duplicate AI/self reviews of one work", () => {
  const records: Revision[] = [];
  for (const kind of ["essay", "speaking"] as const)
    for (let i = 0; i < 5; i++) {
      const work = revision(kind, {
        planId: "p",
        date: "2026-11-20",
        ...(kind === "essay"
          ? { text: "Original.", taskType: "task2", stage: "submitted" }
          : { transcript: "Original.", part: 1 }),
      });
      records.push(work);
      for (const source of ["self", "ai"])
        records.push(
          revision("feedback", {
            planId: "p",
            workId: work.id,
            workRevisionId: work.revisionId,
            inputHash: work.contentHash,
            text: "Synthetic feedback",
            source,
            taskType: kind === "essay" ? "task2" : "speaking",
            errorCauses: ["grammar"],
          }),
        );
    }
  const result = buildWeeklyReview(input(records));
  for (const skill of ["writing", "speaking"]) {
    assert.equal(
      result.summaries.find((row) => row.skill === skill)!.causes[0].count,
      5,
    );
    assert.ok(
      result.suggestions.some(
        (row) => row.skill === skill && row.action === "prioritize-error-cause",
      ),
    );
  }
  const stale = records.find((row) => row.kind === "feedback")!;
  stale.payload.inputHash = "0".repeat(64);
  stale.payload.errorCauses = ["pronunciation"];
  assert.equal(
    buildWeeklyReview(input(records))
      .summaries.find((row) => row.skill === "writing")!
      .causes.some((row) => row.errorCause === "pronunciation"),
    false,
  );
});
test("T5: two consecutive weeks of the same task, dimension and estimate source flag the same bias direction", () => {
  for (const delta of [0.5, -0.5]) {
    const result = buildWeeklyReview(
      input([...pair(1, "self", delta), ...pair(2, "self", delta)]),
    );
    assert.equal(result.systematicBias.length, 1);
    assert.deepEqual(result.systematicBias[0].weeks, [1, 2]);
    assert.equal(
      result.systematicBias[0].direction,
      delta > 0 ? "high" : "low",
    );
  }
});
test("T5: bias does not combine opposite directions, estimate sources, Task1/Task2 or nonconsecutive weeks", () => {
  for (const records of [
    [...pair(1, "self", 0.5), ...pair(2, "self", -0.5)],
    [...pair(1, "self"), ...pair(2, "ai")],
    [...pair(1, "self", 0.5, "task1"), ...pair(2)],
    [...pair(1), ...pair(3)],
  ])
    assert.equal(
      buildWeeklyReview(input(records, [], "2026-11-29")).systematicBias.length,
      0,
    );
  assert.equal(
    buildWeeklyReview(input([...pair(1), ...pair(2), ...pair(2, "self", -0.5)]))
      .systematicBias.length,
    0,
  );
});
test("T5: same-problem retest chains require two distinct failed rounds; a later pass breaks the streak", () => {
  const failed = chain(["retested-fail", "retested-fail"]),
    passed = chain(["retested-fail", "retested-fail", "retested-pass"]);
  const result = buildWeeklyReview(input(failed.records, failed.bank));
  assert.equal(result.persistentProblems.length, 1);
  assert.ok(
    result.suggestions.some(
      (row) =>
        row.action === "request-human-calibration" && row.evidence.value === 2,
    ),
  );
  assert.equal(
    buildWeeklyReview(input(passed.records, passed.bank)).persistentProblems
      .length,
    0,
  );
});
test("T5: two wrong items in one round, unrelated roots and a missing ancestor cannot fabricate a two-fail streak", () => {
  const one = chain(["retested-fail"]);
  const c = one.records.find((row) => row.kind === "correction")!;
  (c.payload.items as CorrectionItem[]).push({
    ...(c.payload.items as CorrectionItem[])[0],
    questionId: one.bank[0].questions[1].id,
  });
  assert.equal(
    buildWeeklyReview(input(one.records, one.bank)).persistentProblems.length,
    0,
  );
  const a = chain(["retested-fail"]),
    b = chain(["retested-fail"]);
  assert.equal(
    buildWeeklyReview(
      input([...a.records, ...b.records], [...a.bank, ...b.bank]),
    ).persistentProblems.length,
    0,
  );
  const broken = chain(["retested-fail", "retested-fail"]);
  broken.records[2].payload.retestOf = "a5000000-0000-4000-8000-999999999999";
  assert.equal(
    buildWeeklyReview(input(broken.records, broken.bank)).persistentProblems
      .length,
    0,
  );
});
test("T5: pass rates exclude dropped or untested items, and pass never creates an assessment", () => {
  const run = chain(["retested-pass"]);
  const correctionRecord = run.records.find(
    (record) => record.kind === "correction",
  )!;
  (correctionRecord.payload.items as CorrectionItem[]).push(
    {
      questionId: run.bank[0].questions[1].id,
      errorCause: "vocab-unknown",
      action: "vocab-review",
      status: "dropped",
      note: "Self-authored dropped-task rationale.",
    },
    {
      questionId: run.bank[0].questions[2].id,
      errorCause: "vocab-unknown",
      action: "vocab-review",
      status: "corrected",
    },
    {
      questionId: run.bank[0].questions[3].id,
      errorCause: "vocab-unknown",
      action: "vocab-review",
      status: "open",
    },
  );
  const before = canonical(run.records),
    value = buildWeeklyReview(input(run.records, run.bank));
  const stat = value.correctionStatistics.find(
    (row) => row.skill === "reading",
  )!;
  assert.equal(stat.total, 3);
  assert.equal(stat.completed, 2);
  assert.equal(stat.completionRate, 2 / 3);
  assert.equal(stat.retested, 1);
  assert.equal(stat.passed, 1);
  assert.equal(stat.retestPassRate, 1);
  assert.equal(value.scores.reading, null);
  assert.equal(canonical(run.records), before);
});
test("T5: only raw eligible score evidence determines the largest gap; unknown scores do not imply a weak subject", () => {
  assert.equal(buildWeeklyReview(input([])).recommendedSkill, null);
  const formal = revision("assessment", {
    planId: "p",
    date: "2026-11-20",
    kind: "official",
    source: "official",
    scores: { listening: 8.5, reading: 8.5, writing: 6.5, speaking: 7.5 },
  });
  const result = buildWeeklyReview(input([formal]));
  assert.equal(result.recommendedSkill, "writing");
  assert.equal(result.gaps.writing, 1);
});
test("T5: each accepted decision applies only in the following plan week; pending and rejected are inert", () => {
  for (const state of ["pending", "rejected"] as const)
    assert.deepEqual(
      acceptedMaterialPreferences([evidence, decision(state)], "p", 2)
        .questionTypes.reading,
      [],
    );
  const accepted = decision("accepted");
  assert.deepEqual(
    acceptedMaterialPreferences([evidence, accepted], "p", 2).questionTypes
      .reading,
    ["multiple-choice"],
  );
  for (const week of [1, 3, 53])
    assert.deepEqual(
      acceptedMaterialPreferences([evidence, accepted], "p", week).questionTypes
        .reading,
      [],
    );
  assert.equal(
    acceptedMaterialPreferences([accepted], "p", 2).recordIds.length,
    0,
  );
});
test("T5: a rejected/deleted latest adjustment cannot resurrect an older accepted revision", () => {
  const accepted = decision("accepted"),
    rejected = {
      ...decision("rejected"),
      seq: 0,
      baseRevision: accepted.revisionId,
    };
  assert.deepEqual(
    acceptedMaterialPreferences([accepted, rejected, evidence], "p", 2)
      .questionTypes.reading,
    [],
  );
  const deleted = { ...rejected, deleted: true };
  assert.deepEqual(
    acceptedMaterialPreferences([accepted, deleted, evidence], "p", 2)
      .questionTypes.reading,
    [],
  );
});
test("T5: preference helpers only reorder eligible material/corrections, preserve ties and reject holdouts", () => {
  const a = material("ordinary", "reading", "true-false-not-given"),
    b = material("preferred"),
    holdout = { ...material("reserve"), pool: "holdout" as const },
    preferences = acceptedMaterialPreferences(
      [evidence, decision("accepted")],
      "p",
      2,
    );
  assert.deepEqual(
    prioritizeMaterials([a, b, holdout], preferences, "reading").map(
      (row) => row.id,
    ),
    [b.id, a.id],
  );
  const none = acceptedMaterialPreferences([], "p", 2);
  assert.deepEqual(
    prioritizeMaterials([a, b], none, "reading").map((row) => row.id),
    [a.id, b.id],
  );
  const original = attempt(a, 0),
    c1 = correction(original, ["retested-fail"], "2026-11-20", "spelling"),
    c2 = correction(original, ["retested-fail"], "2026-11-20");
  preferences.errorCauses.reading = ["vocab-unknown"];
  assert.deepEqual(
    prioritizeCorrections([c1, c2], preferences).map((row) => row.id),
    [c2.id, c1.id],
  );
});
test("T5: original-review tasks require an accepted action and bind the exact original without rewriting it", () => {
  const records = pair(2),
    summary = buildWeeklyReview(input(records)),
    issue = summary.calibrationIssues[0],
    suggestion = summary.suggestions.find(
      (row) => row.id === issue.suggestionId,
    )!;
  const accepted = decision("accepted", 2, suggestion),
    rejected = decision("rejected", 2, suggestion),
    before = canonical(records);
  assert.throws(
    () =>
      originalReviewCorrection(issue, rejected, {
        plan,
        records,
        date: "2026-11-22",
      }),
    /先逐条采纳/,
  );
  const task = originalReviewCorrection(issue, accepted, {
    plan,
    records,
    date: "2026-11-22",
  })!;
  validatePayload("correction", task.payload);
  assert.equal(task.payload.sourceRevisionId, records[0].revisionId);
  assert.equal(task.payload.sourceKind, "essay");
  assert.equal(task.payload.items[0].status, "open");
  assert.equal(canonical(records), before);
  assert.equal(
    originalReviewCorrection(issue, accepted, {
      plan,
      records: [...records, revision("correction", task.payload, task.id)],
      date: "2026-11-22",
    }),
    null,
  );
  assert.ok(adjustmentRecordId("p", 2, suggestion.id).length <= 160);
});
test("T9: four baseline routes and accepted correction/material priorities preserve all 1460 daily budgets", () => {
  const preferred = acceptedMaterialPreferences(
      [evidence, decision("accepted")],
      "p",
      2,
    ),
    bank = [material("first"), material("second")];
  for (const band of [null, 5.5, 6, 6.5])
    for (let day = 1; day <= 365; day++) {
      const date = dayDate(
          String(plan.payload.startDate),
          "Asia/Shanghai",
          day,
        ),
        baseline =
          band === null
            ? undefined
            : {
                planId: "p",
                kind: "baseline",
                source: "human",
                date: String(plan.payload.startDate),
                scores: {
                  listening: band,
                  reading: band,
                  writing: band,
                  speaking: band,
                },
              };
      const value = buildDayPlan(bundledRules, plan.payload, date, baseline),
        before = canonical(value);
      prioritizeMaterials(bank, preferred, "reading");
      prioritizeCorrections([], preferred);
      assert.equal(value.totalMinutes, 120);
      assert.equal(
        value.blocks.reduce((sum, block) => sum + block.minutes, 0),
        120,
      );
      assert.equal(canonical(value), before);
    }
});

// SSR verifies the learner labels and decision controls; production clicks are exercised by R5 e2e.
test("T5: weekly UI shows red bias, evidence, deliberate decisions and the raw-score boundary", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { WeeklyReview } = await import("./ui/review/WeeklyReview");
  const records = [...pair(1), ...pair(2)];
  const html = renderToStaticMarkup(
    createElement(WeeklyReview, {
      plan,
      records,
      bank: [],
      date: "2026-11-22",
      userId: null,
    }),
  );
  assert.match(html, /自评系统性偏高/);
  assert.match(html, /color:#b42318/);
  assert.match(html, /查看证据/);
  assert.match(html, />采纳<\/button>/);
  assert.match(html, />不采纳<\/button>/);
  assert.match(html, /待决定/);
  assert.match(html, /不改变门槛分/);
  assert.match(html, /每天仍为120分钟/);
});

test("T5: calibration advice cites the estimate record as well as the human baseline and exact work", () => {
  const records = pair(2, "self");
  const value = buildWeeklyReview(input(records));
  const suggestion = value.suggestions.find(
    (row) => row.action === "review-original",
  )!;
  assert.ok(suggestion.evidence.recordIds.includes(records[0].id));
  assert.ok(suggestion.evidence.recordIds.includes(records[1].id));
  assert.ok(suggestion.evidence.recordIds.includes(records[2].id));
});
