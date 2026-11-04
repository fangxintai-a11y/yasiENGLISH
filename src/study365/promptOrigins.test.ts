import test from "node:test";
import assert from "node:assert/strict";
import samples from "../../public/curriculum365/v1/samples.json";
import { sourceOnlyPromptOrigins, withPromptOrigins } from "./promptOrigins";
import { hashLocalPrompt } from "./promptBankSchema";
import {
  buildCorrection,
  correctionItemKey,
  updateCorrectionItems,
} from "./correctionModel";
import {
  selectRetest,
  unseenPrompt,
  type RetestPrompt,
} from "./retestSelection";
import type { Revision } from "./protocol";
let counter = 0;
const record = (
  kind: string,
  payload: Record<string, unknown>,
  id = `source-${++counter}`,
): Revision => ({
  id,
  kind: kind as Revision["kind"],
  datasetId: null,
  planId: "plan",
  revisionId: `10000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  baseRevision: null,
  payload: { planId: "plan", ...payload },
  contentHash: "b".repeat(64),
  createdAt: counter,
  seq: counter,
  deleted: false,
  conflict: false,
});
function correctionFor(original: Revision) {
  const issue = record("feedback", {
      workId: original.id,
      workRevisionId: original.revisionId,
      inputHash: original.contentHash,
      source: "self",
      errorCauses: ["grammar"],
    }),
    draft = buildCorrection(issue, {
      planId: "plan",
      date: "2026-11-09",
      day: 1,
      records: [original],
    })!;
  const payload = updateCorrectionItems(
    draft.payload,
    Object.fromEntries(
      draft.payload.items.map((item) => [
        correctionItemKey(item),
        { status: "corrected" as const },
      ]),
    ),
    "2026-11-09",
    1,
  );
  return { issue, correction: record("correction", payload, draft.id) };
}
test("T3: built-in origins are readonly references with real hashes and can never be new retest candidates", async () => {
  const before = structuredClone(samples),
    origins = await sourceOnlyPromptOrigins();
  assert.ok(origins.length > 0);
  assert.ok(origins.every((prompt) => prompt.ready === false));
  for (const prompt of origins)
    assert.equal(prompt.contentHash, await hashLocalPrompt({ ...prompt }));
  assert.equal(
    origins.find(
      (prompt) => prompt.skill === "writing" && prompt.taskType === "task1",
    )?.questionType,
    "table",
  );
  assert.deepEqual(samples, before);
  const old = origins.find(
    (prompt) => prompt.skill === "writing" && prompt.taskType === "task1",
  )!;
  const original = record("essay", {
      date: "2026-11-09",
      taskType: "task1",
      scope: "full",
      stage: "submitted",
      prompt: old.prompt,
      text: "A saved original.",
      contentId: old.id,
      contentVersion: old.version,
    }),
    { issue, correction } = correctionFor(original);
  assert.equal(
    selectRetest(correction, {
      planId: "plan",
      date: "2026-11-10",
      day: 2,
      records: [original, issue],
      materials: [],
      prompts: origins,
    }).material,
    null,
  );
});
test("T3: the R2 table original can establish family for a genuinely new imported Task1 without admitting old defaults as new", async () => {
  const old = (await sourceOnlyPromptOrigins()).find(
    (prompt) => prompt.skill === "writing" && prompt.taskType === "task1",
  )!;
  const original = record("essay", {
      date: "2026-11-09",
      taskType: "task1",
      scope: "full",
      stage: "submitted",
      prompt: `${old.prompt}\n\n题图文字说明：原表格已随作品保留。`,
      text: "A saved original.",
      contentId: old.id,
      contentVersion: old.version,
    }),
    { issue, correction } = correctionFor(original);
  const fresh: RetestPrompt = {
    id: "new-table-fixture",
    version: "1",
    contentHash: "a".repeat(64),
    skill: "writing",
    taskType: "task1",
    questionType: "table",
    prompt: "Describe another self-authored table.",
    sourceRef: "synthetic:new-table",
    materialSource: "unofficial",
    stimulusHash: "f".repeat(64),
  };
  const selected = selectRetest(correction, {
    planId: "plan",
    date: "2026-11-10",
    day: 2,
    records: [original, issue],
    materials: [],
    prompts: await withPromptOrigins([fresh]),
  });
  assert.equal(selected.material?.id, fresh.id);
  assert.equal(selected.estimatedMinutes, 20);
});
test("T3: multiple speaking prompts sharing one old material ID bind by the actual question", async () => {
  const origins = await sourceOnlyPromptOrigins(),
    grouped = new Map<string, RetestPrompt[]>();
  for (const prompt of origins.filter(
    (prompt) => prompt.skill === "speaking",
  )) {
    const values = grouped.get(prompt.id) ?? [];
    values.push(prompt);
    grouped.set(prompt.id, values);
  }
  const group = [...grouped.values()].find((values) => values.length > 1)!;
  assert.ok(group);
  const answered = group[1],
    original = record("speaking", {
      date: "2026-11-09",
      part: answered.part,
      prompt: answered.prompt,
      transcript: "A saved original.",
      contentId: answered.id,
      contentVersion: answered.version,
    });
  const alias = { ...answered, id: "renamed-old-question", ready: true };
  assert.equal(
    unseenPrompt(alias, [original], [...origins, alias], "plan"),
    false,
  );
});
