import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSecondsRemaining,
  createListeningPlayback,
  evidencePlaybackStart,
  firstSeekTarget,
  listeningPlaybackKey,
  listeningReady,
  playbackConditions,
  restoreListeningPlayback,
  transitionListeningPlayback,
  type ListeningIdentity,
} from "./listeningPlayback";

const identity: ListeningIdentity = { userId: "learner-a", materialId: "listening-section-1", contentHash: "a".repeat(64) };
const fresh = () => createListeningPlayback(identity, 270);
const playing = () => transitionListeningPlayback(fresh(), { type: "play" }, 1_000);
const progressed = () => transitionListeningPlayback(playing(), { type: "progress", seconds: 42.5 }, 43_500);
const checking = () => transitionListeningPlayback(progressed(), { type: "ended" }, 300_000);

test("a new first answer cannot submit before playback", () => {
  assert.equal(listeningReady(fresh(), 900_000), false);
});
test("first playback is not marked as a replay", () => {
  assert.deepEqual(playbackConditions(playing()), { replayed: false, replays: 0, transcriptViewed: false });
});
test("ordinary audio progress survives as an exact fractional position", () => {
  assert.equal(progressed().positionSeconds, 42.5);
});
test("first-answer backward dragging returns to the saved position", () => {
  assert.equal(firstSeekTarget(progressed(), 5), 42.5);
});
test("first-answer forward dragging cannot skip the remaining audio", () => {
  assert.equal(firstSeekTarget(progressed(), 260), 42.5);
});
test("audio progress cannot move backwards during the first pass", () => {
  assert.equal(transitionListeningPlayback(progressed(), { type: "progress", seconds: 20 }, 44_000).positionSeconds, 42.5);
});
test("natural end starts exactly sixty seconds of answer checking", () => {
  assert.equal(checkSecondsRemaining(checking(), 300_000), 60);
});
test("checking with one millisecond remaining still blocks submission", () => {
  assert.equal(listeningReady(checking(), 359_999), false);
});
test("the exact checking deadline unlocks submission", () => {
  assert.equal(listeningReady(checking(), 360_000), true);
});
test("a repeated ended event does not extend the checking deadline", () => {
  assert.equal(transitionListeningPlayback(checking(), { type: "ended" }, 330_000).checkingEndsAt, 360_000);
});
test("the first-pass audio cannot restart while checking", () => {
  assert.equal(transitionListeningPlayback(checking(), { type: "play" }, 310_000).phase, "checking");
});
test("the first-pass audio cannot restart after checking", () => {
  const ready = transitionListeningPlayback(checking(), { type: "tick" }, 360_000);
  assert.equal(transitionListeningPlayback(ready, { type: "play" }, 370_000).phase, "ready");
});
test("leaving mid-audio restores the exact position without starting automatically", () => {
  const restored = restoreListeningPlayback(progressed(), identity, 270, 100_000);
  assert.equal(restored.positionSeconds, 42.5);
  assert.equal(restored.phase, "paused");
});
test("returning to unfinished audio records a resumed first pass", () => {
  assert.deepEqual(playbackConditions(restoreListeningPlayback(progressed(), identity, 270, 100_000)),
    { replayed: true, replays: 1, transcriptViewed: false });
});
test("refreshing while checking preserves the original absolute deadline", () => {
  assert.equal(restoreListeningPlayback(checking(), identity, 270, 330_000).checkingEndsAt, 360_000);
});
test("returning after the checking deadline is ready without another minute", () => {
  assert.equal(restoreListeningPlayback(checking(), identity, 270, 400_000).phase, "ready");
});
test("another account cannot restore this playback position", () => {
  assert.equal(restoreListeningPlayback(progressed(), { ...identity, userId: "learner-b" }, 270, 100_000).positionSeconds, 0);
});
test("a changed material hash cannot restore the previous version", () => {
  assert.equal(restoreListeningPlayback(progressed(), { ...identity, contentHash: "b".repeat(64) }, 270, 100_000).positionSeconds, 0);
});
test("a different material ID cannot inherit the first-pass position", () => {
  assert.equal(restoreListeningPlayback(progressed(), { ...identity, materialId: "listening-section-2" }, 270, 100_000).positionSeconds, 0);
});
test("guest and an account literally named guest have separate keys", () => {
  assert.notEqual(listeningPlaybackKey({ ...identity, userId: null }), listeningPlaybackKey({ ...identity, userId: "guest" }));
});
test("tuple keys do not collide when account and material IDs contain separators", () => {
  assert.notEqual(listeningPlaybackKey({ ...identity, userId: "a:b", materialId: "c" }), listeningPlaybackKey({ ...identity, userId: "a", materialId: "b:c" }));
});
test("a malformed stored numeric position is ignored", () => {
  assert.equal(restoreListeningPlayback({ ...progressed(), positionSeconds: "42" }, identity, 270, 100_000).phase, "idle");
});
test("an unknown stored phase is ignored", () => {
  assert.equal(restoreListeningPlayback({ ...progressed(), phase: "unrestricted" }, identity, 270, 100_000).phase, "idle");
});
test("first-answer transcript requests do not mark or reveal it", () => {
  assert.equal(transitionListeningPlayback(playing(), { type: "transcript" }, 2_000).transcriptViewed, false);
});
test("review permits backward audio navigation", () => {
  const review = transitionListeningPlayback(progressed(), { type: "review" }, 100_000);
  assert.equal(firstSeekTarget(review, 5), 5);
});
test("review playback records the extra play", () => {
  const review = transitionListeningPlayback(checking(), { type: "review" }, 100_000);
  assert.deepEqual(playbackConditions(transitionListeningPlayback(review, { type: "play" }, 100_001)),
    { replayed: true, replays: 1, transcriptViewed: false });
});
test("review can record an explicitly opened transcript", () => {
  const review = transitionListeningPlayback(checking(), { type: "review" }, 100_000);
  assert.equal(transitionListeningPlayback(review, { type: "transcript" }, 100_001).transcriptViewed, true);
});
test("evidence playback starts five seconds before the actual evidence", () => {
  assert.equal(evidencePlaybackStart(32.75), 27.75);
});
test("evidence close to the beginning never seeks before zero", () => {
  assert.equal(evidencePlaybackStart(3), 0);
});
