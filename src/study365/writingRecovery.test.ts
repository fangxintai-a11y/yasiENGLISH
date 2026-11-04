import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptCommittedWritingHead,
  recoverWritingDraft,
  unresolvedWritingConflicts,
  restoredWritingMode,
  writingDraftIsDirty,
} from "./writingRecovery";
import { newWritingDraft } from "./writingModel";
import type { Revision } from "./protocol";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const revision = (
  n: number,
  base: number | null,
  text = "Original",
): Revision => ({
  id: "work",
  kind: "essay",
  planId: "plan",
  datasetId: null,
  revisionId: uuid(n),
  baseRevision: base === null ? null : uuid(base),
  seq: n,
  createdAt: n,
  conflict: false,
  deleted: false,
  contentHash: "a".repeat(64),
  payload: {
    planId: "plan",
    taskType: "task2",
    scope: "full",
    stage: "draft",
    date: "2026-11-15",
    prompt: "Discuss transport.",
    text,
    conditions: { timed: false, firstAttempt: true, unseen: false },
  },
});
const local = () =>
  newWritingDraft({
    id: "local",
    recordId: "work",
    planId: "plan",
    taskType: "task2",
    date: "2026-11-15",
    prompt: "Discuss transport.",
    text: "Original",
    baseRevision: uuid(1),
    outline: "Keep my local plan.",
  });
test("clean checkpoint follows a newer head and retains local outline, while content edits preserve old base", () => {
  const base = revision(1, null),
    head = revision(2, 1, "Remote v2");
  const clean = recoverWritingDraft(local(), head, [base, head]);
  assert.equal(clean.text, "Remote v2");
  assert.equal(clean.baseRevision, head.revisionId);
  assert.equal(clean.outline, local().outline);
  const dirty = { ...local(), text: "Unsaved memory edit" };
  assert.equal(recoverWritingDraft(dirty, head, [base, head]), dirty);
  assert.equal(dirty.baseRevision, base.revisionId);
});
test("timer/outline alone are not content edits, but question/material/conditions changes are", () => {
  const base = revision(1, null);
  assert.equal(
    writingDraftIsDirty(
      {
        ...local(),
        outline: "New outline",
        timer: { ...local().timer, elapsedSeconds: 50 },
      },
      base,
    ),
    false,
  );
  for (const fields of [
    { text: "changed" },
    { prompt: "changed" },
    { contentId: "other" },
    { conditions: { firstAttempt: true, unseen: true } },
  ])
    assert.equal(writingDraftIsDirty({ ...local(), ...fields }, base), true);
  assert.equal(
    writingDraftIsDirty(local(), undefined),
    true,
    "unknown base must not allow overwrite",
  );
});
test("a committed checkpoint after local persistence failure adopts the new base without losing original notes", () => {
  const next = revision(2, 1);
  const recovered = adoptCommittedWritingHead(local(), next)!;
  assert.equal(recovered.baseRevision, next.revisionId);
  assert.equal(recovered.text, local().text);
  assert.equal(recovered.outline, local().outline);
  assert.equal(
    adoptCommittedWritingHead(local(), revision(2, 1, "Different remote text")),
    null,
  );
  assert.equal(adoptCommittedWritingHead(local(), revision(1, null)), null);
});
test("submitted head recovery locks the matching local original even if final local persist failed", () => {
  const head = revision(2, 1);
  head.payload.stage = "submitted";
  const recovered = adoptCommittedWritingHead(local(), head)!;
  assert.equal(recovered.stage, "submitted");
  assert.equal(recovered.submittedRevisionId, head.revisionId);
});
test("local chosen revision remains resolved before sync and after another local edit, preserving conflict history", () => {
  const checkpoint = revision(1, null),
    canonical = revision(2, 1, "A"),
    conflict = { ...revision(3, 1, "B"), conflict: true };
  assert.equal(
    unresolvedWritingConflicts(canonical, [checkpoint, canonical, conflict])
      .length,
    1,
  );
  const originalLocal = { ...revision(4, 1, "B"), seq: 0 };
  assert.equal(
    unresolvedWritingConflicts(originalLocal, [
      checkpoint,
      canonical,
      conflict,
      originalLocal,
    ]).length,
    1,
  );
  const chosen = { ...revision(5, 2, "B"), seq: 0 };
  assert.equal(
    unresolvedWritingConflicts(chosen, [
      checkpoint,
      canonical,
      conflict,
      chosen,
    ]).length,
    0,
  );
  const edited = { ...revision(6, 5, "B edited"), seq: 0 };
  assert.equal(
    unresolvedWritingConflicts(edited, [
      checkpoint,
      canonical,
      conflict,
      chosen,
      edited,
    ]).length,
    0,
  );
  assert.equal(conflict.conflict, true);
  assert.equal(
    unresolvedWritingConflicts({ ...chosen, seq: 5 }, [conflict, chosen])
      .length,
    0,
  );
});
test("Sunday full Task1+Task2 drafts restore pair; paragraph remains a separate practice", () => {
  const one = { ...local(), taskType: "task1" as const },
    two = local();
  assert.equal(restoredWritingMode([one, two], "pair"), "pair");
  assert.equal(
    restoredWritingMode([{ ...two, scope: "paragraph" }], "task1"),
    "paragraph",
  );
});

test("Task1 table description matches the actual checkpoint prompt and is not a local edit", async () => {
  const { essayPayload } = await import("./writingWorks");
  const draft = newWritingDraft({
    id: "local",
    recordId: "work",
    planId: "plan",
    taskType: "task1",
    date: "2026-11-15",
    prompt: "Describe the table.",
    text: "Overall, the figures rose.",
    tableDescription: "Year | Bus\n2005 | 40",
    baseRevision: uuid(1),
  });
  const base = { ...revision(1, null), payload: essayPayload(draft, "draft") };
  assert.equal(writingDraftIsDirty(draft, base), false);
});

test("a paragraph follows a clean remote head without changing its task budget to full Task2 time", () => {
  const draft = {
    ...local(),
    scope: "paragraph" as const,
    timer: { ...local().timer, limitSeconds: 2100 },
  };
  const base = {
    ...revision(1, null),
    payload: { ...revision(1, null).payload, scope: "paragraph" },
  };
  const head = {
    ...revision(2, 1, "Remote paragraph"),
    payload: {
      ...revision(2, 1, "Remote paragraph").payload,
      scope: "paragraph",
    },
  };
  assert.equal(
    recoverWritingDraft(draft, head, [base, head]).timer.limitSeconds,
    2100,
  );
});
