import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeRevision, hashPayload, readAttemptMaterialSource, validateNewListeningReadingAttempt, validatePayload, type LearningPayload, type Revision, type WriteRequest } from './protocol';
interface FixtureRecord { recordId: string; request: WriteRequest; expectedContentHash: string }
interface InvalidCase { recordId: string; label: string; path: (string | number)[]; value?: unknown; error: string; remove?: boolean }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/r4-records.json', import.meta.url), 'utf8')) as { fixtureVersion: number; purpose: string; records: FixtureRecord[]; invalidCases: InvalidCase[] };
const record = (id: string) => { const value = fixture.records.find(item => item.recordId === id); assert.ok(value, id); return value; };
function invalidPayload(item: InvalidCase): LearningPayload {
  const value = structuredClone(record(item.recordId).request.payload); let target: any = value;
  for (const key of item.path.slice(0, -1)) target = target[key];
  const key = item.path.at(-1)!; if (item.remove) delete target[key]; else target[key] = item.value;
  return value;
}
for (const [index, item] of fixture.records.entries()) test(`R4 wire ${item.recordId} revision ${index + 1} validates with exact raw payload and hash`, async () => {
  const raw = JSON.stringify(item.request); validatePayload(item.request.kind, item.request.payload);
  assert.equal(await hashPayload(item.request.kind, item.request.payload), item.expectedContentHash);
  const revision: Revision = { id: item.recordId, kind: item.request.kind, datasetId: null, planId: 'r4-plan', revisionId: item.request.revisionId, baseRevision: item.request.baseRevision, payload: item.request.payload, contentHash: item.expectedContentHash, seq: index + 1, createdAt: index + 1, deleted: false, conflict: false, payloadVersion: 2 };
  assert.deepEqual(decodeRevision(revision).payload, item.request.payload); assert.equal(JSON.stringify(item.request), raw);
});
for (const item of fixture.invalidCases) test(`R4 rejects ${item.label}`, () => assert.throws(() => validatePayload('attempt', invalidPayload(item)), new RegExp(item.error)));
const base = { planId: 'r4-plan', contentId: 'r4-independent', skill: 'reading', answers: ['a', null] };
for (const [field, value] of Object.entries({ materialSource: 'official', sourceRef: 'Synthetic source', contentHash: 'a'.repeat(64), scope: 'section', coverage: { requestedWordIds: [], coveredWordIds: [], uncoveredWordIds: [], matcherVersion: 'r4-v1' }, reviewAnswers: ['b', null] })) test(`R4 independent attempt.${field} is optional on the compatible wire`, () => validatePayload('attempt', { ...base, [field]: value }));
test('R4 independent reviewCorrect and disputed null cause are accepted', () => {
  validatePayload('attempt', { ...base, questionResults: [{ questionId: 'q1', correct: false, confidence: 'sure', errorCause: 'spelling', reviewCorrect: true }] });
  validatePayload('attempt', { ...base, questionResults: [{ questionId: 'q1', correct: false, confidence: 'sure', errorCause: null, answerDisputed: true, note: 'Synthetic ambiguity.' }] });
});
test('R4 old attempt and old hash are retained; material hash and immutable revision hash differ', async () => {
  const old = record('r4-legacy-attempt'); validatePayload('attempt', old.request.payload);
  assert.equal(Object.hasOwn(old.request.payload, 'materialSource'), false); assert.equal(Object.hasOwn(old.request.payload, 'coverage'), false);
  assert.equal(await hashPayload('attempt', old.request.payload), old.expectedContentHash);
  const versions = fixture.records.filter(item => item.recordId === 'r4-reading-attempt');
  assert.deepEqual(versions[1].request.payload.answers, versions[0].request.payload.answers);
  for (const key of ['score', 'correct', 'total', 'firstAttempt', 'contentHash']) assert.deepEqual(versions[1].request.payload[key], versions[0].request.payload[key]);
  assert.equal(versions[1].request.baseRevision, versions[0].request.revisionId); assert.notEqual(versions[0].expectedContentHash, versions[1].expectedContentHash);
  assert.notEqual(versions[0].expectedContentHash, versions[0].request.payload.contentHash);
});


test('R4 new creation requires provenance while the old compatible wire does not', () => {
  const old = record('r4-legacy-attempt').request.payload, raw = JSON.stringify(old);
  assert.equal(readAttemptMaterialSource(old), null); assert.equal(JSON.stringify(old), raw);
  assert.throws(() => validateNewListeningReadingAttempt(old), /必须选择材料来源/);
  const value = record('r4-reading-attempt').request.payload;
  assert.doesNotThrow(() => validateNewListeningReadingAttempt(value));
  assert.equal(readAttemptMaterialSource(value), 'unofficial');
  for (const [field, error] of [['materialSource', '必须选择材料来源'], ['sourceRef', '必须填写材料出处'], ['contentHash', '必须保存材料校验值'], ['scope', '必须明确练习范围']] as const) {
    const next = { ...value }; delete next[field];
    assert.doesNotThrow(() => validatePayload('attempt', next));
    assert.throws(() => validateNewListeningReadingAttempt(next), new RegExp(error));
  }
  assert.throws(() => validateNewListeningReadingAttempt({ ...value, skill: 'writing' }), /必须明确听力或阅读/);
});
test('R4 coverage accepts exactly 50 targets without mutating their partition', () => {
  const ids = Array.from({ length: 50 }, (_, index) => `w-${index}`);
  const coverage = { requestedWordIds: ids, coveredWordIds: ids.slice(0, 20), uncoveredWordIds: ids.slice(20), matcherVersion: 'r4-v1' };
  const raw = JSON.stringify(coverage); validatePayload('attempt', { ...base, coverage }); assert.equal(JSON.stringify(coverage), raw);
});
