import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelfReviewPayload,
  emptySelfReview,
  feedbackForWork,
  runWritingRules,
  spellingTokens,
  toggleSpelling,
  checkedSpelling,
} from "./writingReview";
import { writingRubric } from "./writingRubric";
import {
  hashPayload,
  validateWritingFeedbackReference,
  type Revision,
} from "./protocol";
async function work(
  taskType: "task1" | "task2" = "task2",
  scope = "full",
): Promise<Revision> {
  const text =
    "I believe trains matter.\n\nOverall, trains are higher than buses at 20%.";
  return {
    id: "work",
    kind: "essay",
    datasetId: null,
    planId: "plan",
    revisionId: "00000000-0000-4000-8000-000000000001",
    baseRevision: null,
    seq: 1,
    createdAt: 1,
    deleted: false,
    conflict: false,
    contentHash: await hashPayload("essay", { text }),
    payload: {
      planId: "plan",
      taskType,
      scope,
      stage: "submitted",
      text,
      prompt: "Describe transport.",
    },
  };
}
test("spelling unchecked null differs from checked zero, and cancelling a marker retains the original span", () => {
  const state = emptySelfReview("task2");
  assert.equal(state.spellingCheck.status, "unchecked");
  assert.equal(state.spellingCheck.count, null);
  const token = spellingTokens("😀 Bad speling.")[1];
  assert.equal(token.start, 7);
  assert.equal(token.text, "speling");
  const marked = toggleSpelling(state.spellingCheck, token);
  assert.equal(marked.count, null);
  assert.equal(checkedSpelling(marked).count, 1);
  const cancelled = toggleSpelling(checkedSpelling(marked), token);
  assert.equal(cancelled.count, 0);
  assert.equal(cancelled.items[0].confirmed, false);
});
test("Task1 has its three exclusive checks and all four dimensions have at least three prompts", () => {
  const one = writingRubric("task1"),
    two = writingRubric("task2");
  assert.equal(one.filter((item) => item.id.startsWith("task1-")).length, 3);
  assert.ok(!two.some((item) => item.id === "task1-no-opinion"));
  for (const [type, items] of [
    ["task1", one],
    ["task2", two],
  ] as const)
    for (const dimension of [
      type === "task1" ? "taskAchievement" : "taskResponse",
      "coherence",
      "lexical",
      "grammar",
    ])
      assert.ok(
        items.filter((item) => item.dimension === dimension).length >= 3,
      );
});
test("self review binds exact draft/hash, saves confirmed spelling/checklist/causes/nullable bands without becoming a skill score", async () => {
  const original = await work("task1"),
    state = emptySelfReview("task1", ["word-limit"]);
  state.spellingCheck = checkedSpelling(state.spellingCheck);
  state.checklist["task1-overview"] = true;
  state.bands.taskAchievement = 7.5;
  const payload = await buildSelfReviewPayload(original, state, 123);
  assert.equal(payload.workRevisionId, original.revisionId);
  assert.equal(payload.inputHash, original.contentHash);
  assert.equal(payload.source, "self");
  assert.equal(payload.scores, undefined);
  assert.deepEqual(payload.spellingCheck, {
    status: "checked",
    count: 0,
    items: [],
  });
  validateWritingFeedbackReference(payload, original.payload);
});
test("wrong task causes, other without explanation, invalid bands and forged spelling offsets are rejected", async () => {
  const original = await work("task1");
  const wrong = emptySelfReview("task1");
  wrong.errorCauses = ["task-response"];
  await assert.rejects(
    () => buildSelfReviewPayload(original, wrong),
    /错因|任务/,
  );
  const other = emptySelfReview("task1");
  other.errorCauses = ["other"];
  await assert.rejects(() => buildSelfReviewPayload(original, other), /说明/);
  const forged = emptySelfReview("task1");
  forged.spellingCheck = checkedSpelling({
    status: "unchecked",
    count: null,
    items: [{ start: 0, end: 2, text: "XX", confirmed: true }],
  });
  await assert.rejects(() => buildSelfReviewPayload(original, forged), /原稿/);
  const band = emptySelfReview("task1");
  band.bands.taskAchievement = 7.25;
  await assert.rejects(() => buildSelfReviewPayload(original, band), /分数/);
});
test("rules retain null bands and task-specific evidence, while paragraph practice does not inherit full essay word limits", async () => {
  for (const type of ["task1", "task2"] as const) {
    const { result, payload } = await runWritingRules(await work(type));
    assert.equal(payload.source, "rules");
    assert.ok(
      Object.values(payload.bands as object).every((value) => value === null),
    );
    assert.ok(
      Object.values(result.criteria)
        .flatMap((c) => c.evidence)
        .some((e) =>
          e.ruleId?.includes(type === "task1" ? "overview" : "position"),
        ),
    );
  }
  const { result, payload } = await runWritingRules(
    await work("task2", "paragraph"),
  );
  assert.ok(!result.causes.includes("word-limit"));
  assert.doesNotMatch(String(payload.text), /250/);
});
test("feedback selection never mixes another revision, another hash, another plan, deleted or conflict feedback", async () => {
  const original = await work();
  const payload = await buildSelfReviewPayload(
    original,
    emptySelfReview("task2"),
  );
  const base: Revision = {
    ...original,
    id: "feedback",
    kind: "feedback",
    payload,
  };
  const records = [
    base,
    ...[
      { workRevisionId: "00000000-0000-4000-8000-000000000002" },
      { inputHash: "b".repeat(64) },
      { planId: "other" },
    ].map((fields, i) => ({
      ...base,
      id: `bad${i}`,
      payload: { ...payload, ...fields },
    })),
    { ...base, id: "deleted", deleted: true },
    { ...base, id: "conflict", conflict: true },
  ];
  assert.deepEqual(
    feedbackForWork(records, original).map((r) => r.id),
    ["feedback"],
  );
});
