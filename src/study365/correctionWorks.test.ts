import test from "node:test";
import assert from "node:assert/strict";
import { newWritingDraft } from "./writingModel";
import { essayPayload } from "./writingWorks";
import { draftFromRevision } from "./writingDrafts";
import {
  newSpeakingDraft,
  speakingPayload,
  speakingDraftFromRevision,
} from "./speakingModel";
import { hashPayload, type Revision } from "./protocol";
const parent = "10000000-0000-4000-8000-000000000001",
  correctionId = "correction-original";
const record = async (
  kind: Revision["kind"],
  payload: Record<string, unknown>,
): Promise<Revision> => ({
  id: "revised",
  kind,
  planId: "p",
  datasetId: null,
  revisionId: "10000000-0000-4000-8000-000000000002",
  baseRevision: null,
  seq: 1,
  createdAt: 1,
  conflict: false,
  deleted: false,
  payload,
  contentHash: await hashPayload(kind, payload),
});
test("writing correction association survives submit and draft recovery without entering the essay text hash", async () => {
  const draft = newWritingDraft({
    planId: "p",
    date: "2026-11-14",
    taskType: "task2",
    prompt: "Self-authored fixture",
    text: "A corrected paragraph.",
    parentRevisionId: parent,
    correctionId,
  });
  const payload = essayPayload(draft, "submitted");
  assert.equal(payload.correctionId, correctionId);
  assert.equal(payload.parentRevisionId, parent);
  const work = await record("essay", payload);
  assert.equal(draftFromRevision(work).correctionId, correctionId);
  assert.equal(
    await hashPayload("essay", { ...payload, correctionId: "another" }),
    work.contentHash,
  );
});
test("speaking correction association survives the existing payload and restore path without changing transcript hashing", async () => {
  const draft = newSpeakingDraft({
    planId: "p",
    date: "2026-11-14",
    part: 2,
    prompt: "Self-authored cue",
    transcript: "A second saved answer.",
    parentRevisionId: parent,
    correctionId,
  });
  const payload = speakingPayload(draft);
  assert.equal(payload.correctionId, correctionId);
  assert.equal(payload.parentRevisionId, parent);
  const work = await record("speaking", payload);
  assert.equal(speakingDraftFromRevision(work).correctionId, correctionId);
  assert.equal(
    await hashPayload("speaking", { ...payload, correctionId: "another" }),
    work.contentHash,
  );
});
