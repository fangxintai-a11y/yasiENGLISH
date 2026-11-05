import assert from "node:assert/strict";
import test from "node:test";
import type { LearningPayload, Revision } from "./protocol";
import { listSpeakingWorks, speakingListSummary } from "./speakingList";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function revision(
  kind: Revision["kind"],
  id: string,
  payload: LearningPayload,
  n = 1,
): Revision {
  return {
    id,
    kind,
    planId: "plan",
    datasetId: null,
    revisionId: uuid(n),
    baseRevision: null,
    seq: n,
    createdAt: n,
    deleted: false,
    conflict: false,
    contentHash: "a".repeat(64),
    payload: { planId: "plan", ...payload },
  };
}
const work = (fields: LearningPayload = {}) =>
  revision("speaking", "answer", {
    date: "2026-11-15",
    part: 2,
    prompt: "Describe a skill.",
    transcript: "I learned to cook.",
    durationSeconds: 120,
    recordingId: "audio-a",
    recordingStatus: "local",
    ...fields,
  });
function feedback(
  saved: Revision,
  id: string,
  fields: LearningPayload = {},
): Revision {
  return revision("feedback", id, {
    workId: saved.id,
    workRevisionId: saved.revisionId,
    inputHash: saved.contentHash,
    source: "self",
    taskType: "speaking",
    errorCauses: ["grammar"],
    ...fields,
  });
}
function human(saved: Revision): Revision {
  return revision("assessment", "human", {
    kind: "weekly-calibration",
    source: "human",
    date: "2026-11-15",
    weekIndex: 1,
    workId: saved.id,
    workRevisionId: saved.revisionId,
    inputHash: saved.contentHash,
    bands: { fluency: 7.5, lexical: 7.5, grammar: 7.5, pronunciation: 7.5 },
  });
}
test("speaking list sorts by work date before creation time, preserving input and hiding other plans/deleted/conflicts", () => {
  const old = { ...work({ date: "2026-11-14" }), id: "old", createdAt: 999 },
    late = { ...work(), id: "late", createdAt: 20 },
    early = { ...work(), id: "early", createdAt: 10 };
  const input = [
    old,
    { ...work(), id: "deleted", deleted: true },
    late,
    { ...work(), id: "other", planId: "other" },
    early,
    { ...work(), id: "conflict", conflict: true },
  ];
  assert.deepEqual(
    listSpeakingWorks(input, "plan").map((value) => value.id),
    ["late", "early", "old"],
  );
  assert.equal(input[0], old);
});
test("legacy unknown Part, missing duration and empty transcript do not become guessed Part1, zero seconds or playable audio", () => {
  const saved = work({
    part: undefined,
    durationSeconds: undefined,
    transcript: " \n",
    recordingId: null,
    recordingStatus: "none",
  });
  const summary = speakingListSummary(saved, []);
  assert.equal(summary.part, null);
  assert.equal(summary.durationSeconds, null);
  assert.equal(summary.part2Full, null);
  assert.equal(summary.hasRecordingReference, false);
  assert.equal(summary.hasTranscript, false);
  assert.equal(summary.hasHumanCalibration, false);
  assert.deepEqual(summary.errorCauses, []);
  assert.equal(Object.hasOwn(summary, "playable"), false);
});
test("Part2 full status uses actual 120-second boundary, while an audio ID is only a reference", () => {
  assert.equal(
    speakingListSummary(work({ durationSeconds: 119.99 }), []).part2Full,
    false,
  );
  assert.equal(speakingListSummary(work(), []).part2Full, true);
  assert.equal(speakingListSummary(work({ part: 1 }), []).part2Full, null);
  assert.equal(speakingListSummary(work(), []).hasRecordingReference, true);
});
test("list causes use only current exact revision/hash/plan feedback and allowed unique speaking codes", () => {
  const saved = work(),
    good = feedback(saved, "good", {
      errorCauses: ["grammar", "grammar", "pronunciation", "spelling"],
    });
  const records = [
    good,
    feedback(saved, "old", {
      workRevisionId: uuid(2),
      errorCauses: ["coherence"],
    }),
    feedback(saved, "hash", {
      inputHash: "b".repeat(64),
      errorCauses: ["fluency-pause"],
    }),
    {
      ...feedback(saved, "plan", { errorCauses: ["time-pressure"] }),
      planId: "other",
    },
    {
      ...feedback(saved, "conflict", { errorCauses: ["other"] }),
      conflict: true,
    },
    {
      ...feedback(saved, "deleted", { errorCauses: ["other"] }),
      deleted: true,
    },
  ];
  assert.deepEqual(speakingListSummary(saved, records).errorCauses, [
    "grammar",
    "pronunciation",
  ]);
});
test("human list status needs exact current work revision/hash and never treats estimates or old/deleted calibration as human", () => {
  const saved = work(),
    good = human(saved);
  assert.equal(speakingListSummary(saved, [good]).hasHumanCalibration, true);
  for (const bad of [
    { ...good, payload: { ...good.payload, workRevisionId: uuid(2) } },
    { ...good, payload: { ...good.payload, inputHash: "b".repeat(64) } },
    { ...good, payload: { ...good.payload, source: "ai" } },
    { ...good, deleted: true },
    { ...good, conflict: true },
  ])
    assert.equal(speakingListSummary(saved, [bad]).hasHumanCalibration, false);
});
