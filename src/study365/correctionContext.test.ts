import test from "node:test";
import assert from "node:assert/strict";
import { correctionContextBlock } from "./correctionContext";
import { replaceRevisionReferences } from "./revisionReferences";
import { buildDayPlan } from "./planEngine";
import { bundledRules } from "./planData";
import { SECTION_TARGETS, type Revision } from "./protocol";
const plan: Revision = {
  id: "p",
  kind: "plan",
  datasetId: null,
  planId: "p",
  revisionId: crypto.randomUUID(),
  baseRevision: null,
  seq: 1,
  createdAt: 1,
  conflict: false,
  deleted: false,
  contentHash: "a".repeat(64),
  payload: {
    planId: "p",
    startDate: "2026-11-09",
    timeZone: "Asia/Shanghai",
    studyBudgetMinutes: 120,
    targetBand: 8,
    sectionTargets: SECTION_TARGETS,
  },
};
const original: Revision = {
  ...plan,
  id: "original",
  kind: "essay",
  revisionId: crypto.randomUUID(),
  payload: {
    planId: "p",
    date: "2026-11-10",
    taskType: "task2",
    stage: "submitted",
    prompt: "Self-authored prompt",
    text: "Original paragraph.",
  },
};
const feedback: Revision = {
  ...plan,
  id: "feedback",
  kind: "feedback",
  revisionId: crypto.randomUUID(),
  payload: {
    planId: "p",
    workId: original.id,
    workRevisionId: original.revisionId,
    inputHash: original.contentHash,
    errorCauses: ["grammar"],
  },
};
const correction: Revision = {
  ...plan,
  id: "correction",
  kind: "correction",
  revisionId: crypto.randomUUID(),
  payload: {
    planId: "p",
    sourceId: feedback.id,
    sourceRevisionId: feedback.revisionId,
    sourceKind: "feedback",
    skill: "writing",
    items: [
      {
        dimension: "grammar",
        errorCause: "grammar",
        action: "rewrite-paragraph",
        status: "open",
      },
    ],
  },
};
test("correction opens the original review block and retains a null skill", () => {
  const day = buildDayPlan(bundledRules, plan.payload, "2026-11-14");
  const block = correctionContextBlock(
    plan,
    [plan, original, feedback, correction],
    day,
    { work: original.id, correctionId: correction.id, task: "d6-review" },
    "writing",
  );
  assert.equal(block?.id, "review");
  assert.equal(block?.minutes, 30);
  assert.equal(block?.skill, null);
  assert.equal(day.totalMinutes, 120);
});
test("ordinary days and forged skill or task links cannot borrow minutes", () => {
  const records = [plan, original, feedback, correction],
    day = buildDayPlan(bundledRules, plan.payload, "2026-11-14");
  assert.throws(
    () =>
      correctionContextBlock(
        plan,
        records,
        buildDayPlan(bundledRules, plan.payload, "2026-11-16"),
        { work: original.id, correctionId: correction.id },
        "writing",
      ),
    /复盘预算/,
  );
  assert.throws(
    () =>
      correctionContextBlock(
        plan,
        records,
        day,
        { work: original.id, correctionId: correction.id, task: "d6-reading" },
        "writing",
      ),
    /复盘块/,
  );
  assert.throws(
    () =>
      correctionContextBlock(
        plan,
        records,
        day,
        { work: original.id, correctionId: correction.id },
        "speaking",
      ),
    /不一致/,
  );
});
test("a later feedback head does not erase the exact immutable source, and account reset clears it", () => {
  const day = buildDayPlan(bundledRules, plan.payload, "2026-11-14"),
    newer = {
      ...feedback,
      revisionId: crypto.randomUUID(),
      baseRevision: feedback.revisionId,
    };
  replaceRevisionReferences([feedback]);
  try {
    assert.equal(
      correctionContextBlock(
        plan,
        [plan, original, newer, correction],
        day,
        { work: original.id, correctionId: correction.id },
        "writing",
      )?.id,
      "review",
    );
  } finally {
    replaceRevisionReferences([]);
  }
  assert.throws(
    () =>
      correctionContextBlock(
        plan,
        [plan, original, newer, correction],
        day,
        { work: original.id, correctionId: correction.id },
        "writing",
      ),
    /不一致/,
  );
});
