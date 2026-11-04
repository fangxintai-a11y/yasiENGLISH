import test from "node:test";
import assert from "node:assert/strict";
import {
  createListeningSequence,
  deriveListeningSequences,
  restoreListeningSequence,
  SEQUENCE_CHECK_SECONDS,
  sequenceCheckRemaining,
  sequenceConditions,
  sequencePlaybackKey,
  sequenceReady,
  transitionListeningSequence,
  withListeningSequences,
  type ListeningMaterial,
  type ListeningSequence,
  type ListeningSequenceState,
} from "./listeningSequence";
import { firstSeekTarget } from "./listeningPlayback";
import { attemptPayload } from "./readingModel";
import { validatePayload } from "./protocol";
const part = (
  section: number,
  patch: Partial<ListeningMaterial> = {},
): ListeningMaterial => ({
  id: `synthetic-s${section}`,
  examId: "C99T1",
  section,
  version: "1",
  contentHash: String(section).repeat(64),
  title: `Self-authored section ${section}`,
  skill: "listening",
  scope: "section",
  pool: "practice",
  deliveryMode: "local-import",
  source: {
    materialSource: "cambridge",
    sourceRef: `synthetic:C99T1S${section}`,
    rights: "Self-authored test fixture; not an actual Cambridge test.",
    answerVerified: true,
  },
  transcript: `Section ${section} says word${section}.`,
  audio: {
    path: `audio/synthetic-${section}.wav`,
    durationSeconds: 1,
    sha256: String(section).repeat(64),
  },
  questions: Array.from({ length: 10 }, (_, index) => ({
    id: `q${(section - 1) * 10 + index + 1}`,
    number: (section - 1) * 10 + index + 1,
    type: "sentence-completion",
    prompt: `Complete synthetic question ${index + 1}.`,
    answer: { accepted: [`word${section}`], maxWords: 1 },
    evidence: { quote: `word${section}`, startSeconds: 0.1, endSeconds: 0.9 },
    answerVerified: true,
  })),
  ...patch,
});
const fixtures = () => [1, 2, 3, 4].map((section) => part(section));
async function sequence(): Promise<ListeningSequence> {
  const all = await deriveListeningSequences(fixtures());
  assert.equal(all.length, 1);
  return all[0];
}
function finishPart(state: ListeningSequenceState, now: number) {
  let current =
    state.phase === "idle" || state.phase === "paused"
      ? transitionListeningSequence(state, { type: "start" }, now)
      : state;
  current = transitionListeningSequence(current, { type: "play" }, now);
  current = transitionListeningSequence(
    current,
    {
      type: "progress",
      seconds: current.parts[current.partIndex].durationSeconds,
    },
    now + 1000,
  );
  return transitionListeningSequence(current, { type: "ended" }, now + 1000);
}
test("four source originals derive a stable full material and 40 original question bindings without a fake single audio", async () => {
  const originals = fixtures(),
    before = JSON.stringify(originals),
    [derived] = await deriveListeningSequences(originals),
    [again] = await deriveListeningSequences([...originals].reverse());
  assert.equal(derived.material.scope, "full");
  assert.equal(derived.material.questions.length, 40);
  assert.equal(derived.material.audio, undefined);
  assert.equal(derived.material.contentHash, again.material.contentHash);
  assert.equal(derived.material.version, again.material.version);
  assert.equal(JSON.stringify(originals), before);
  assert.deepEqual(
    derived.material.questions.map((question) => question.number),
    Array.from({ length: 40 }, (_, index) => index + 1),
  );
  assert.deepEqual(derived.previewSeconds, [0, 0, 0, 0]);
  const origin = derived.questionOrigins.q21;
  assert.equal(origin.partIndex, 2);
  assert.equal(origin.materialId, originals[2].id);
  assert.equal(origin.questionId, "q21");
});
test("missing section, missing audio, repeated global numbers and reused audio cannot be declared full", async () => {
  const missing = fixtures().slice(0, 3);
  assert.deepEqual(await deriveListeningSequences(missing), []);
  const noAudio = fixtures();
  delete noAudio[2].audio;
  assert.deepEqual(await deriveListeningSequences(noAudio), []);
  const badNumbers = fixtures();
  badNumbers[3].questions[0].number = 1;
  assert.deepEqual(await deriveListeningSequences(badNumbers), []);
  const repeated = fixtures();
  repeated[3].audio = { ...repeated[0].audio! };
  assert.deepEqual(await deriveListeningSequences(repeated), []);
});
test("different source bands or mixed practice and holdout parts never combine", async () => {
  const sources = fixtures();
  sources[3].source = { ...sources[3].source, materialSource: "unofficial" };
  assert.deepEqual(await deriveListeningSequences(sources), []);
  const pools = fixtures();
  pools[3].pool = "holdout";
  assert.deepEqual(await deriveListeningSequences(pools), []);
  const holdout = fixtures().map((part) => ({
    ...part,
    pool: "holdout" as const,
  }));
  assert.equal(
    (await deriveListeningSequences(holdout))[0].material.pool,
    "holdout",
  );
});
test("colliding question IDs and per-part group IDs get safe virtual identities with exact source backreferences", async () => {
  const originals = fixtures();
  originals.forEach((part) =>
    part.questions.forEach((question, index) => {
      question.id = `local-${index + 1}`;
      question.groupId = "group-1";
    }),
  );
  const [derived] = await deriveListeningSequences(originals);
  assert.equal(
    new Set(derived.material.questions.map((question) => question.id)).size,
    40,
  );
  assert.equal(
    new Set(derived.material.questions.map((question) => question.groupId))
      .size,
    4,
  );
  assert.equal(derived.questionOrigins["sequence-q31"].questionId, "local-1");
  assert.equal(derived.questionOrigins["sequence-q31"].partIndex, 3);
});
test("derived versions retain common historical part versions while preferring current originals", async () => {
  const old = fixtures(),
    newer = old.map((part) => ({
      ...part,
      version: "2",
      contentHash: "a".repeat(64),
    }));
  const both = await deriveListeningSequences([...old, ...newer]);
  assert.equal(both.length, 2);
  assert.equal(both[0].parts[0].version, "2");
  assert.notEqual(both[0].material.contentHash, both[1].material.contentHash);
  const augmented = await withListeningSequences([...old, ...newer]);
  assert.equal(augmented.length, 10);
  assert.equal(augmented[0].id.startsWith("sequence-"), true);
});
test("one part hash change changes the complete identity and cannot restore old state", async () => {
  const before = await sequence(),
    changed = fixtures();
  changed[2].contentHash = "b".repeat(64);
  const [after] = await deriveListeningSequences(changed);
  assert.notEqual(after.material.contentHash, before.material.contentHash);
  const playing = transitionListeningSequence(
    createListeningSequence("user-a", before),
    { type: "play" },
    0,
  );
  const reset = restoreListeningSequence(playing, "user-a", after, 100);
  assert.equal(reset.phase, "idle");
});
test("the four protected playback cores advance in order with no per-part extra minute and only one final 120-second deadline", async () => {
  const derived = await sequence();
  let state = createListeningSequence("user-a", derived);
  for (let index = 0; index < 4; index++) {
    assert.equal(state.partIndex, index);
    assert.equal(sequenceReady(state, index * 2000), false);
    state = finishPart(state, index * 2000);
    if (index < 3) {
      assert.equal(state.partIndex, index + 1);
      assert.equal(state.phase, "loading");
      assert.equal(state.checkingEndsAt, null);
    }
  }
  assert.equal(SEQUENCE_CHECK_SECONDS, 120);
  assert.equal(state.phase, "checking");
  assert.equal(state.checkingEndsAt, 127000);
  assert.equal(sequenceReady(state, 67000), false);
  assert.equal(sequenceReady(state, 126999), false);
  assert.equal(sequenceReady(state, 127000), true);
  assert.equal(sequenceCheckRemaining(state, 67000), 60);
});
test("an ended signal without played media progress cannot skip a part or unlock checking", async () => {
  const derived = await sequence();
  const playing = transitionListeningSequence(
    createListeningSequence(null, derived),
    { type: "play" },
    0,
  );
  assert.equal(
    transitionListeningSequence(playing, { type: "ended" }, 1),
    playing,
  );
  assert.equal(
    transitionListeningSequence(
      createListeningSequence(null, derived),
      { type: "ended" },
      1,
    ).partIndex,
    0,
  );
});
test("explicit missing-preview timing is absolute, starts once and is not added to default original pauses", async () => {
  const [derived] = await deriveListeningSequences(fixtures(), {
    previewSeconds: [2, 3, 0, 0],
  });
  let state = transitionListeningSequence(
    createListeningSequence(null, derived),
    { type: "start" },
    1000,
  );
  assert.equal(state.phase, "preview");
  assert.equal(state.previewEndsAt, 3000);
  assert.equal(
    transitionListeningSequence(state, { type: "play" }, 2000),
    state,
  );
  assert.equal(
    transitionListeningSequence(state, { type: "start" }, 2000),
    state,
  );
  state = transitionListeningSequence(state, { type: "tick" }, 3000);
  assert.equal(state.phase, "loading");
  state = finishPart(state, 3000);
  assert.equal(state.partIndex, 1);
  assert.equal(state.phase, "preview");
  assert.equal(state.previewEndsAt, 7000);
  assert.equal(
    restoreListeningSequence(state, null, derived, 6000).previewEndsAt,
    7000,
  );
});
test("first pass cannot select a different part or seek, but review can", async () => {
  const derived = await sequence();
  let state = createListeningSequence(null, derived);
  assert.equal(
    transitionListeningSequence(state, { type: "select", index: 3 }, 0),
    state,
  );
  state = transitionListeningSequence(state, { type: "play" }, 0);
  state = transitionListeningSequence(
    state,
    { type: "progress", seconds: 0.3 },
    300,
  );
  assert.equal(firstSeekTarget(state.parts[0], 0), 0.3);
  assert.equal(firstSeekTarget(state.parts[0], 0.9), 0.3);
  state = transitionListeningSequence(state, { type: "review" }, 500);
  state = transitionListeningSequence(state, { type: "select", index: 2 }, 600);
  assert.equal(state.partIndex, 2);
  assert.equal(firstSeekTarget(state.parts[2], 0.7), 0.7);
});
test("stale media callbacks from the previous audio cannot alter the new section", async () => {
  const derived = await sequence(),
    state = finishPart(createListeningSequence(null, derived), 0);
  assert.equal(state.partIndex, 1);
  assert.equal(
    transitionListeningSequence(state, { type: "pause", partIndex: 0 }, 1200),
    state,
  );
  assert.equal(
    transitionListeningSequence(
      state,
      { type: "progress", seconds: 0.8, partIndex: 0 },
      1200,
    ),
    state,
  );
});
test("interruption restores current section and seconds, aggregates resumed conditions and keeps account/hash boundaries", async () => {
  const derived = await sequence();
  let state = finishPart(createListeningSequence("account-a", derived), 0);
  state = transitionListeningSequence(state, { type: "play" }, 1000);
  state = transitionListeningSequence(
    state,
    { type: "progress", seconds: 0.45 },
    1450,
  );
  const restored = restoreListeningSequence(
    JSON.parse(JSON.stringify(state)),
    "account-a",
    derived,
    5000,
  );
  assert.equal(restored.partIndex, 1);
  assert.equal(restored.phase, "paused");
  assert.equal(restored.parts[1].positionSeconds, 0.45);
  assert.equal(sequenceConditions(restored).replayed, true);
  assert.equal(sequenceConditions(restored).replays, 1);
  assert.equal(sequenceConditions(restored).sequential, true);
  assert.equal(
    restoreListeningSequence(state, "account-b", derived, 5000).phase,
    "idle",
  );
  assert.notEqual(
    sequencePlaybackKey({ userId: "a:b", materialId: "c", contentHash: "d" }),
    sequencePlaybackKey({ userId: "a", materialId: "b:c", contentHash: "d" }),
  );
});
test("reloading the final check does not restart or shorten the original 120-second deadline", async () => {
  const derived = await sequence();
  let state = createListeningSequence(null, derived);
  for (let i = 0; i < 4; i++) state = finishPart(state, i * 2000);
  const restored = restoreListeningSequence(state, null, derived, 68000);
  assert.equal(restored.checkingEndsAt, 127000);
  assert.equal(sequenceReady(restored, 68000), false);
  assert.equal(
    sequenceReady(
      restoreListeningSequence(state, null, derived, 128000),
      128000,
    ),
    true,
  );
});
test("corrupt future parts or prematurely saved ready status fail closed", async () => {
  const derived = await sequence();
  const bad = createListeningSequence(null, derived);
  bad.parts[2].hasPlayed = true;
  assert.equal(restoreListeningSequence(bad, null, derived, 10).phase, "idle");
  let state = createListeningSequence(null, derived);
  for (let i = 0; i < 4; i++) state = finishPart(state, i * 2000);
  state.phase = "ready";
  const restored = restoreListeningSequence(state, null, derived, 68000);
  assert.equal(sequenceReady(restored, 68000), false);
});
test("review-only transcript and replays do not change first-answer material metadata", async () => {
  const derived = await sequence(),
    before = JSON.stringify(derived.material);
  let state = transitionListeningSequence(
    createListeningSequence(null, derived),
    { type: "review" },
    0,
  );
  state = transitionListeningSequence(state, { type: "transcript" }, 0);
  state = transitionListeningSequence(state, { type: "play" }, 0);
  assert.equal(sequenceConditions(state).transcriptViewed, true);
  assert.equal(sequenceConditions(state).replayed, true);
  assert.equal(JSON.stringify(derived.material), before);
});
test("a normal sequential first-answer payload retains 40 original slots, full scope and stable source evidence", async () => {
  const derived = await sequence();
  const payload = attemptPayload(
    derived.material,
    derived.material.questions.map((question) => question.answer.accepted[0]),
    { planId: "sequence-plan", date: "2026-11-14", day: 6 },
    [],
    1000,
    { timed: true, replayed: false, transcriptViewed: false, replays: 0 },
  );
  payload.conditions = { ...(payload.conditions as object), sequential: true };
  validatePayload("attempt", payload);
  assert.equal(payload.total, 40);
  assert.equal(payload.score, 40);
  assert.equal(payload.scope, "full");
  assert.equal(payload.firstAttempt, true);
  assert.equal((payload.conditions as any).sequential, true);
  assert.equal(payload.contentHash, derived.material.contentHash);
});

test("an interrupted exact-end checkpoint advances instead of replaying that whole section from zero", async () => {
  const derived = await sequence();
  let state = transitionListeningSequence(
    createListeningSequence(null, derived),
    { type: "play" },
    0,
  );
  state = transitionListeningSequence(
    state,
    { type: "progress", seconds: 1 },
    1000,
  );
  const restored = restoreListeningSequence(state, null, derived, 5000);
  assert.equal(restored.partIndex, 1);
  assert.equal(restored.phase, "loading");
  assert.equal(restored.parts[1].positionSeconds, 0);
  assert.equal(restored.parts[1].hasPlayed, false);
});
