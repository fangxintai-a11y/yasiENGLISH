import test from 'node:test';
import assert from 'node:assert/strict';
import { sequenceCheckRemaining, SEQUENCE_CHECK_SECONDS, type ListeningSequenceState } from './listeningSequence';
// A display-only projection: media/ready transitions and their deadline stay outside this function.
const deadline = 987654.125;
const state = { phase: 'checking', checkingEndsAt: deadline } as ListeningSequenceState;
test('R6-1: check display never exceeds its segment duration at every millisecond around the first frame', () => {
  const original = JSON.stringify(state);
  for (let offset = -50; offset <= 50; offset++) {
    const now = deadline - SEQUENCE_CHECK_SECONDS * 1000 + offset;
    const seconds = sequenceCheckRemaining(state, now);
    assert.ok(Number.isInteger(seconds));
    assert.ok(seconds >= 0 && seconds <= SEQUENCE_CHECK_SECONDS, `first-frame offset ${offset}: ${seconds}`);
  }
  assert.equal(JSON.stringify(state), original);
});
test('R6-1: display floors the deadline delta while preserving the exact deadline and clamping expired values', () => {
  for (let offset = -50; offset <= 50; offset++) {
    assert.equal(sequenceCheckRemaining(state, deadline + offset), 0);
    assert.equal(state.checkingEndsAt, deadline);
  }
  assert.equal(sequenceCheckRemaining(state, deadline - 119900), 119);
  assert.equal(sequenceCheckRemaining({ ...state, phase: 'idle' }, deadline), 0);
});
