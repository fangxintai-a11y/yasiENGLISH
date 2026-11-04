import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_CAUSES, type Revision } from "./protocol";
import { CORRECTION_RULES, correctionAction } from "./correctionRules";
import {
  buildCorrection,
  correctionOriginal,
  correctionItemKey,
  updateCorrectionItems,
  civilDayDistance,
} from "./correctionModel";
let sequence = 0;
const record = (
  kind: string,
  payload: Record<string, unknown>,
  id = `work-${++sequence}`,
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
const work = (kind = "essay") =>
  record(kind, {
    date: "2026-11-09",
    ...(kind === "essay"
      ? {
          taskType: "task2",
          stage: "submitted",
          scope: "full",
          text: "A saved original.",
        }
      : { part: 2, transcript: "A saved original." }),
    prompt: "Self-authored fixture question",
  });
const feedback = (original: Revision, errorCauses: string[]) =>
  record("feedback", {
    workId: original.id,
    workRevisionId: original.revisionId,
    inputHash: original.contentHash,
    taskType: original.kind === "essay" ? "task2" : "speaking",
    errorCauses,
    source: "self",
  });
const attempt = () =>
  record("attempt", {
    date: "2026-11-09",
    day: 1,
    skill: "reading",
    contentId: "paper",
    contentVersion: "1",
    contentHash: "b".repeat(64),
    scope: "section",
    materialSource: "official",
    sourceRef: "synthetic:paper",
    total: 3,
    score: 1,
    correct: 1,
    answers: ["FALSE", "A", "bad"],
    reviewAnswers: ["TRUE", "A", "word"],
    questionResults: [
      {
        questionId: "q1",
        correct: false,
        reviewCorrect: true,
        confidence: "sure",
        errorCause: "tfng-inference",
      },
      {
        questionId: "q2",
        correct: true,
        reviewCorrect: true,
        confidence: "sure",
        errorCause: null,
      },
      {
        questionId: "q3",
        correct: false,
        reviewCorrect: true,
        confidence: "unsure",
        errorCause: null,
        answerDisputed: true,
        note: "Synthetic uncertainty.",
      },
    ],
  });
const context = (records: Revision[] = []) => ({
  planId: "plan",
  date: "2026-11-10",
  day: 2,
  records,
});
test("T2: every existing cause has a data rule and speaking grammar uses a speaking action", () => {
  assert.deepEqual(
    Object.keys(CORRECTION_RULES).sort(),
    [...ERROR_CAUSES].sort(),
  );
  assert.equal(correctionAction("synonym-miss", "reading"), "rephrase-pair");
  assert.equal(correctionAction("spelling", "listening"), "vocab-review");
  assert.equal(correctionAction("grammar", "writing"), "rewrite-paragraph");
  assert.equal(correctionAction("grammar", "speaking"), "rerecord-segment");
});
test("T2: completed listening/reading errors create exact-source tasks; disputed and correct questions do not", () => {
  const source = attempt(),
    before = structuredClone(source),
    draft = buildCorrection(source, context())!;
  assert.equal(draft.payload.sourceId, source.id);
  assert.equal(draft.payload.sourceRevisionId, source.revisionId);
  assert.deepEqual(draft.payload.items, [
    {
      questionId: "q1",
      errorCause: "tfng-inference",
      action: "explain-judgment",
      status: "open",
    },
  ]);
  assert.deepEqual(source, before);
});
test("T2: unfinished A/B review cannot create a correction", () => {
  const source = attempt();
  delete (source.payload.questionResults as Record<string, unknown>[])[0]
    .reviewCorrect;
  assert.throws(() => buildCorrection(source, context()), /完成.*复盘/);
});
test("T2: idempotence uses source revision even if an existing correction has another record id", () => {
  const source = attempt(),
    draft = buildCorrection(source, context())!;
  assert.equal(
    buildCorrection(
      source,
      context([record("correction", draft.payload, "imported-correction")]),
    ),
    null,
  );
  const changed = {
    ...source,
    revisionId: "00000000-0000-4000-8000-999999999999",
  };
  assert.ok(
    buildCorrection(changed, context([record("correction", draft.payload)])),
  );
});
test("T2: writing and speaking feedback bind exact original revisions and retain estimate provenance", () => {
  for (const kind of ["essay", "speaking"]) {
    const original = work(kind),
      source = feedback(original, ["grammar"]),
      draft = buildCorrection(source, context([original]))!;
    assert.equal(draft.payload.sourceKind, "feedback");
    assert.equal(draft.payload.sourceRevisionId, source.revisionId);
    const correction = record("correction", draft.payload, draft.id);
    assert.equal(
      correctionOriginal(correction, [original, source])?.revisionId,
      original.revisionId,
    );
    assert.equal(draft.payload.items[0].dimension, "grammar");
    assert.equal(
      draft.payload.skill,
      kind === "essay" ? "writing" : "speaking",
    );
  }
});
test("T2: stale hashes, missing originals and a mismatched plan fail closed", () => {
  const original = work(),
    source = feedback(original, ["coherence"]);
  source.payload.inputHash = "b".repeat(64);
  assert.throws(
    () => buildCorrection(source, context([original])),
    /准确|绑定/,
  );
  assert.throws(() => buildCorrection(source, context()), /准确|绑定/);
  assert.throws(
    () => buildCorrection({ ...attempt(), planId: "other" }, context()),
    /计划/,
  );
});
test("T2: no declared problems creates no task, while absent cause metadata is not assumed clear", () => {
  const original = work(),
    source = feedback(original, []);
  assert.equal(buildCorrection(source, context([original])), null);
  delete source.payload.errorCauses;
  assert.throws(
    () => buildCorrection(source, context([original])),
    /明确.*错因/,
  );
});
test("T2: weekly calibration creates original-work corrections only for valid same-work warnings", () => {
  const original = work();
  const baseline = record("assessment", {
    kind: "weekly-calibration",
    date: "2026-11-15",
    weekIndex: 1,
    source: "human",
    workId: original.id,
    workRevisionId: original.revisionId,
    inputHash: original.contentHash,
    taskType: "task2",
    bands: { taskResponse: 7, coherence: 7, lexical: 7, grammar: 7 },
    selfBands: { taskResponse: 7, coherence: 7.5, lexical: 7, grammar: 7 },
  });
  const draft = buildCorrection(baseline, context([original, baseline]))!;
  assert.equal(draft.payload.sourceKind, "essay");
  assert.equal(draft.payload.sourceRevisionId, original.revisionId);
  assert.deepEqual(
    draft.payload.items.map((item) => item.dimension),
    ["coherence"],
  );
  delete baseline.payload.workId;
  delete baseline.payload.inputHash;
  assert.ok(
    buildCorrection(baseline, context([original, baseline])),
    "legacy optional sidecars may be absent when the exact work revision is still available",
  );
  baseline.payload.inputHash = "b".repeat(64);
  assert.throws(
    () => buildCorrection(baseline, context([original, baseline])),
    /准确/,
  );
});
test("T2: marking corrected is not a retest or a score update, and completion date waits for the group", () => {
  const source = attempt(),
    draft = buildCorrection(source, context())!;
  draft.payload.items.push({
    dimension: "lexical",
    errorCause: "vocab-unknown",
    action: "vocab-review",
    status: "open",
  });
  const first = updateCorrectionItems(
    draft.payload,
    { [correctionItemKey(draft.payload.items[0])]: { status: "corrected" } },
    "2026-11-11",
    3,
  );
  assert.equal(first.date, "2026-11-10");
  assert.equal(first.items[0].status, "corrected");
  const final = updateCorrectionItems(
    first,
    { [correctionItemKey(first.items[1])]: { status: "corrected" } },
    "2026-11-12",
    4,
  );
  assert.equal(final.date, "2026-11-12");
  assert.equal(final.day, 4);
  assert.equal(source.payload.score, 1);
  assert.equal(Object.hasOwn(final, "scores"), false);
});
test("T2: dropping requires explanation and resolved items cannot be completed again", () => {
  const payload = buildCorrection(attempt(), context())!.payload,
    key = correctionItemKey(payload.items[0]);
  assert.throws(
    () =>
      updateCorrectionItems(
        payload,
        { [key]: { status: "dropped" } },
        "2026-11-10",
        2,
      ),
    /说明/,
  );
  const next = updateCorrectionItems(
    payload,
    {
      [key]: { status: "dropped", note: "Teacher advised a different focus." },
    },
    "2026-11-10",
    2,
  );
  assert.equal(next.items[0].status, "dropped");
  assert.throws(
    () =>
      updateCorrectionItems(
        next,
        { [key]: { status: "corrected" } },
        "2026-11-11",
        3,
      ),
    /待订正/,
  );
});
test("T2/T3: civil dates, rather than 24 elapsed hours, define the next day", () => {
  assert.equal(civilDayDistance("2026-03-09", "2026-03-08"), 1);
  assert.equal(civilDayDistance("2026-11-02", "2026-11-01"), 1);
  assert.throws(() => civilDayDistance("2026-02-30", "2026-02-28"), /日期/);
});
