import test from "node:test";
import assert from "node:assert/strict";
import { newWritingDraft } from "./writingModel";
import { newSpeakingDraft } from "./speakingModel";
import {
  practicePrompts,
  promptKey,
  writingWithPrompt,
  speakingWithPrompt,
  retestWorkId,
  matchesRetestWork,
} from "./promptWorkSelection";
import type { LocalPrompt } from "./promptBankSchema";
import type { Revision } from "./protocol";
const writing = {
  id: "new-question",
  version: "v1",
  contentHash: "a".repeat(64),
  skill: "writing",
  taskType: "task2",
  questionType: "opinion",
  prompt: "Give your own opinion on a fictional town library.",
  sourceRef: "synthetic:fixture",
  materialSource: "unofficial",
  rights: "Self-authored fixture",
} as const satisfies LocalPrompt;
const speaking = {
  ...writing,
  id: "new-speaking",
  skill: "speaking",
  part: 2,
  taskType: undefined,
  questionType: undefined,
} as unknown as LocalPrompt;
test("normal imported questions preserve source metadata and do not replace body, outline, started timer or saved work", () => {
  const draft = newWritingDraft({
      planId: "p",
      date: "2026-11-12",
      taskType: "task2",
      prompt: "Old default",
    }),
    next = writingWithPrompt(draft, writing);
  assert.equal(next.prompt, writing.prompt);
  assert.equal(next.sourceRef, writing.sourceRef);
  assert.equal(next.contentId, writing.id);
  assert.equal(next.tableDescription, undefined);
  for (const changed of [
    { text: "my answer" },
    { outline: "my outline" },
    { timer: { ...draft.timer, elapsedSeconds: 1 } },
    { timer: { ...draft.timer, runningSince: 10 } },
    { baseRevision: "00000000-0000-4000-8000-000000000001" },
  ]) {
    const dirty = { ...draft, ...changed };
    assert.equal(writingWithPrompt(dirty, writing), dirty);
  }
  const paragraph = { ...draft, scope: "paragraph" as const };
  assert.equal(writingWithPrompt(paragraph, writing).scope, "paragraph");
});
test("holdout/unready/other type never enters workbench practice selection", () => {
  assert.deepEqual(
    practicePrompts([
      writing,
      { ...writing, ready: false },
      {
        ...writing,
        pool: "holdout",
        prompt: "A different reserved writing question.",
      },
    ]),
    [writing],
  );
  const task1 = newWritingDraft({
    planId: "p",
    date: "2026-11-12",
    taskType: "task1",
    prompt: "Old chart",
  });
  assert.equal(writingWithPrompt(task1, writing), task1);
});
test("speaking picker preserves blank normal Part but refuses an existing transcript or recording", () => {
  const d = newSpeakingDraft({
      planId: "p",
      date: "2026-11-12",
      part: 2,
      prompt: "Old default",
    }),
    next = speakingWithPrompt(d, speaking);
  assert.equal(next.prompt, speaking.prompt);
  assert.equal(next.part, 2);
  assert.equal(next.sourceRef, speaking.sourceRef);
  assert.notEqual(next.recordId, d.recordId);
  for (const changed of [
    { transcript: "my transcript" },
    { recordingId: "local-recording" },
    { durationSeconds: 1 },
    { prepSeconds: 1 },
  ]) {
    const dirty = { ...d, ...changed };
    assert.equal(speakingWithPrompt(dirty, speaking), dirty);
  }
});
test("one exact retest link has stable work identity isolated by scope, correction, source revision and full selected prompt hash", async () => {
  const c = {
      date: "2026-11-12",
      taskId: "d4-writing",
      correctionId: "correction",
      retestOf: "00000000-0000-4000-8000-000000000001",
    },
    key = promptKey(writing),
    id = await retestWorkId("guest", "p", c, key);
  assert.equal(await retestWorkId("guest", "p", c, key), id);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  for (const changed of [
    await retestWorkId("user:2", "p", c, key),
    await retestWorkId("guest", "p", { ...c, correctionId: "other" }, key),
    await retestWorkId(
      "guest",
      "p",
      { ...c, retestOf: "00000000-0000-4000-8000-000000000002" },
      key,
    ),
    await retestWorkId("guest", "p", c, key.replace(/a$/, "b")),
  ])
    assert.notEqual(changed, id);
  const work = {
    id,
    kind: "essay",
    planId: "p",
    deleted: false,
    conflict: false,
    payload: {
      ...c,
      contentId: writing.id,
      contentVersion: writing.version,
      taskType: "task2",
    },
  } as unknown as Revision;
  assert.equal(matchesRetestWork(work, id, "p", c, writing), true);
  assert.equal(
    matchesRetestWork(
      { ...work, payload: { ...work.payload, retestOf: "other" } },
      id,
      "p",
      c,
      writing,
    ),
    false,
  );
  await assert.rejects(
    retestWorkId("guest", "p", { ...c, correctionId: undefined }, key),
  );
});
test("holdout aliases cannot enter normal practice after only changing id/version/source or punctuation", () => {
  const holdout = {
      ...writing,
      id: "reserved-writing",
      pool: "holdout" as const,
    },
    alias = {
      ...writing,
      id: "renamed-writing",
      version: "v2",
      sourceRef: "synthetic:renamed",
      prompt: "ＧＩＶＥ your own opinion on a fictional town library !!!",
    };
  const speech = {
      ...speaking,
      id: "reserved-speaking",
      pool: "holdout" as const,
    },
    spokenAlias = {
      ...speaking,
      id: "renamed-speaking",
      prompt: speaking.prompt.toUpperCase(),
    };
  assert.deepEqual(practicePrompts([holdout, alias, speech, spokenAlias]), []);
  const otherPart = {
    ...spokenAlias,
    id: "different-part",
    part: 3,
  } as LocalPrompt;
  assert.deepEqual(practicePrompts([speech, spokenAlias, otherPart]), [
    otherPart,
  ]);
});
test("Task1 holdout aliases share original stimulus identity while distinct original charts remain available", () => {
  const chart = {
    ...writing,
    taskType: "task1" as const,
    questionType: "bar-chart",
    prompt: "The chart below shows fictional traffic data.",
    stimulusHash: "b".repeat(64),
    stimulusText: "Self-authored original chart A.",
  };
  const reserved = { ...chart, id: "reserved-chart", pool: "holdout" as const },
    alias = { ...chart, id: "renamed-chart", version: "v2" },
    different = {
      ...chart,
      id: "different-chart",
      stimulusHash: "c".repeat(64),
      stimulusText: "Self-authored distinct original chart B.",
    };
  assert.deepEqual(practicePrompts([reserved, alias, different]), [different]);
});
