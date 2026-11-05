import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeRevision, hashPayload, validatePayload, type LearningPayload, type Revision, type WriteRequest } from './protocol';
interface FixtureRecord { recordId: string; request: WriteRequest; expectedContentHash: string }
interface InvalidCase { recordId: string; label: string; path: (string | number)[]; value?: unknown; error: string; remove?: boolean }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/r5-records.json', import.meta.url), 'utf8')) as { fixtureVersion: number; purpose: string; records: FixtureRecord[]; invalidCases: InvalidCase[] };
const record = (id: string) => { const item = fixture.records.find(value => value.recordId === id); assert.ok(item, id); return item; };
function changed(item: InvalidCase): LearningPayload {
  const value = structuredClone(record(item.recordId).request.payload); let target: any = value;
  for (const key of item.path.slice(0, -1)) target = target[key];
  const key = item.path.at(-1)!; if (item.remove) delete target[key]; else target[key] = item.value;
  return value;
}
for (const [index, item] of fixture.records.entries()) test(`R5 ${item.recordId} #${index + 1} accepts exact wire data and UTF-8 hash`, async () => {
  const before = JSON.stringify(item.request); validatePayload(item.request.kind, item.request.payload);
  assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  const saved: Revision = { id: item.recordId, kind: item.request.kind, datasetId: null, planId: String(item.request.payload.planId), revisionId: item.request.revisionId, baseRevision: item.request.baseRevision, seq: index + 1, payload: item.request.payload, contentHash: item.expectedContentHash, createdAt: index + 1, conflict: false, deleted: false, payloadVersion: 2 };
  assert.deepEqual(decodeRevision(saved).payload, item.request.payload); assert.equal(JSON.stringify(item.request), before);
});
for (const item of fixture.invalidCases) test(`R5 rejects ${item.label}`, () => {
  assert.throws(() => validatePayload(record(item.recordId).request.kind, changed(item)));
});
test('R5 compatible older record preserves all fields, payload bytes and original hash', async () => {
  const item = record('r4-legacy-attempt'), original = JSON.stringify(item.request.payload);
  assert.equal(Object.hasOwn(item.request.payload, 'retestOf'), false); assert.equal(Object.hasOwn(item.request.payload, 'correctionId'), false);
  validatePayload(item.request.kind, item.request.payload);
  assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  assert.equal(JSON.stringify(item.request.payload), original);
});
test('R5 optional retest metadata retains writing and speaking text-hash semantics', async () => {
  for (const id of ['r5-source-essay', 'r5-source-speaking']) {
    const item = record(id), value = { ...item.request.payload, retestOf: item.request.revisionId, correctionId: id === 'r5-source-essay' ? 'r5-correction-writing' : 'r5-correction-speaking' };
    validatePayload(item.request.kind, value);
    assert.equal(await hashPayload(item.request.kind, value), item.expectedContentHash);
  }
});
for (const kind of ['attempt', 'essay', 'speaking'] as const) test(`R5 retest fields are independently optional on ${kind} wire`, () => {
  const item = record(kind === 'attempt' ? 'r5-source-reading' : kind === 'essay' ? 'r5-source-essay' : 'r5-source-speaking');
  validatePayload(kind, { ...item.request.payload, retestOf: item.request.revisionId });
  validatePayload(kind, { ...item.request.payload, correctionId: 'r5-correction' });
});

test('R5 correction accepts exactly fifty distinct items and leaves their raw status unchanged', () => {
  const payload = structuredClone(record('r5-correction-reading').request.payload);
  payload.items = Array.from({ length: 50 }, (_, i) => ({ questionId: `q${i + 1}`, errorCause: 'vocab-unknown', action: 'vocab-review', status: 'open' }));
  const before = JSON.stringify(payload); validatePayload('correction', payload); assert.equal(JSON.stringify(payload), before);
});
test('R5 new note limits use UTF-16 characters consistently and permit the exact bound', () => {
  const value = { ...record('r5-answer-key-correct').request.payload, note: '🙂'.repeat(1000) };
  assert.doesNotThrow(() => validatePayload('answerReview', value));
  assert.throws(() => validatePayload('answerReview', { ...value, note: `${value.note}x` }));
});
