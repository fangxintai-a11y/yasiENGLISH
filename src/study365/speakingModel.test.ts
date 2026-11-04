import assert from "node:assert/strict";
import test from "node:test";
import {
  measuredPreparation,
  newSpeakingDraft,
  newSpeakingTiming,
  part2Full,
  rerecordSpeaking,
  speakingPart,
  speakingPayload,
  speakingTimingStatus,
  startPracticeTimer,
  stopPracticeTimer,
  timerElapsed,
} from "./speakingModel";
import { saveSpeakingAttempt } from "./speakingWorks";
import { validatePayload, type Revision } from "./protocol";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const draft = () =>
  newSpeakingDraft({
    id: "answer-a",
    planId: "plan-a",
    date: "2026-11-15",
    part: 2,
    prompt: "Describe a useful skill.",
  });
function revision(input: ReturnType<typeof draft>, n = 1): Revision {
  return {
    id: input.recordId,
    kind: "speaking",
    planId: input.planId,
    datasetId: null,
    revisionId: uuid(n),
    baseRevision: input.baseRevision,
    seq: n,
    createdAt: n,
    deleted: false,
    conflict: false,
    contentHash: "a".repeat(64),
    payload: speakingPayload(input),
  };
}
test("Part2 preparation records at most60 but actual practice timer keeps overrun independently", () => {
  const timing = newSpeakingTiming();
  timing.prep = startPracticeTimer(timing.prep, 1000);
  assert.equal(measuredPreparation(2, timing, 60000), 59);
  assert.equal(speakingTimingStatus(2, timing, 61000).prepRemaining, 0);
  timing.prep = stopPracticeTimer(timing.prep, 91000);
  assert.equal(measuredPreparation(2, timing), 60);
  assert.equal(speakingTimingStatus(2, timing).actualSeconds, 90);
  assert.equal(measuredPreparation(1, timing), 0);
});
test("Part2 target is120 and does not stop an ongoing answer; Part1 has a30-second suggested target", () => {
  const timing = newSpeakingTiming();
  timing.answer = startPracticeTimer(timing.answer, 1000);
  assert.equal(speakingTimingStatus(2, timing, 120900).part2Full, false);
  assert.equal(speakingTimingStatus(2, timing, 121000).part2Full, true);
  assert.equal(timerElapsed(timing.answer, 131000), 130);
  assert.equal(timing.answer.runningSince, 1000);
  assert.equal(speakingTimingStatus(1, timing).answerTarget, 30);
  assert.equal(part2Full(119.99), false);
  assert.equal(part2Full(120), true);
});
test("fresh answers have an explicit part and allow empty transcript without recording or invented duration", () => {
  const value = draft();
  assert.equal(value.transcript, "");
  assert.equal(value.durationSeconds, 0);
  assert.equal(value.recordingStatus, "none");
  assert.equal(speakingPart(undefined), null);
  assert.equal(speakingPart(4), null);
  validatePayload("speaking", speakingPayload(value));
});
test("saving transcript creates a new revision on the same work and retains its exact base", async () => {
  let serial = 0;
  const writes: unknown[] = [];
  const port = {
    save: async (input: {
      id: string;
      kind: "speaking";
      payload: Record<string, unknown>;
      baseRevision: string | null;
    }) => {
      writes.push(input);
      return {
        ...revision(draft(), ++serial),
        id: input.id,
        baseRevision: input.baseRevision,
        payload: input.payload,
      };
    },
  };
  const first = await saveSpeakingAttempt(draft(), {
    expectedUserId: null,
    port,
  });
  const second = await saveSpeakingAttempt(
    { ...first.draft, transcript: "I learned to cook." },
    { expectedUserId: null, port },
  );
  assert.equal(first.work.id, second.work.id);
  assert.equal(second.work.baseRevision, first.work.revisionId);
  assert.notEqual(first.work.revisionId, second.work.revisionId);
  assert.equal(second.work.payload.transcript, "I learned to cook.");
  assert.doesNotMatch(JSON.stringify(writes), /audioData|base64|blob/);
});
test("re-answer uses a new record and exact parent without overwriting the old audio or copying old transcript as new speech", () => {
  const original = revision({
    ...draft(),
    transcript: "Old answer.",
    recordingId: "audio-old",
    recordingStatus: "local",
    recordingDevice: "设备 old",
    durationSeconds: 125,
  });
  const next = rerecordSpeaking(original);
  assert.notEqual(next.recordId, original.id);
  assert.equal(next.parentRevisionId, original.revisionId);
  assert.equal(next.baseRevision, null);
  assert.equal(next.recordingId, null);
  assert.equal(next.transcript, "");
  assert.equal(original.payload.recordingId, "audio-old");
  assert.equal(original.payload.transcript, "Old answer.");
});
