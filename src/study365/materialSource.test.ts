import test from 'node:test';
import assert from 'node:assert/strict';
import { assessmentMaterialEligibility, materialQualifiedRecords } from './materialSource';
import { buildAssessment, latestEffectiveBySkill, scoreView } from './scoresModel';
import { buildProgress } from './progressModel';
import { SECTION_TARGETS, type LearningPayload, type Revision } from './protocol';
function record(kind: Revision['kind'], payload: LearningPayload, id = 'assessment', seq = 1): Revision {
  return { id, kind, payload, planId: 'plan-a', datasetId: null, revisionId: '12345678-1234-1234-1234-123456789012', baseRevision: null, seq, createdAt: seq, contentHash: 'a'.repeat(64), deleted: false, conflict: false };
}
const input = { planId: 'plan-a', date: '2026-11-09', kind: 'baseline' as const, materialId: 'paper-a', scores: { ...SECTION_TARGETS }, scoreSources: { listening: 'self', reading: 'rules', writing: 'human', speaking: 'human' } as const };
const plan = record('plan', { planId: 'plan-a', startDate: input.date, timeZone: 'Asia/Shanghai' }, 'plan-a');
function evidence(source: unknown, scope = 'full', date = input.date, materialId = input.materialId) {
  return (['listening', 'reading'] as const).map(skill => record('attempt', { planId: 'plan-a', date, contentId: materialId, skill, answers: Array(40).fill('a'), score: 37, correct: 37, total: 40, scope, ...(source === undefined ? {} : { materialSource: source }), contentHash: 'b'.repeat(64) }, `${materialId}-${skill}-${date}`));
}
for (const source of ['official', 'cambridge', 'publisher', 'unofficial', undefined]) test(`R4 qualification is explicit for ${source ?? 'unclassified'} material`, () => {
  const payload = buildAssessment(input), records = evidence(source), view = scoreView(payload, records), eligible = source === 'official' || source === 'cambridge';
  assert.equal(view.effectiveScores.reading, eligible ? 8.5 : null); assert.equal(view.gaps.listening, eligible ? 0 : null);
  assert.equal(view.scores.reading, 8.5); assert.equal(view.referenceSkills.includes('reading'), !eligible);
  assert.equal(view.effectiveScores.writing, 7.5);
});
test('R4 old unclassified scores remain visible but never contribute a gap or per-skill trend', () => {
  const assessment = record('assessment', buildAssessment(input));
  assert.equal(scoreView(assessment.payload).effectiveScores.listening, null);
  assert.equal(scoreView(assessment.payload).gaps.reading, null);
  assert.equal(latestEffectiveBySkill([assessment], plan.id).reading, null);
});
test('R4 association requires exact plan, date, contentId, valid hash, and full scope', () => {
  const payload = buildAssessment(input), good = evidence('official');
  for (const [field, value] of [['date', '2026-11-10'], ['contentId', 'paper-a-reading'], ['contentHash', 'not-a-hash'], ['scope', 'type-drill'], ['scope', 'short'], ['scope', 'section']] as const) {
    assert.equal(assessmentMaterialEligibility(payload, good.map(item => ({ ...item, payload: { ...item.payload, [field]: value } }))).reading.eligible, false, field);
  }
  assert.equal(assessmentMaterialEligibility(payload, good.map(item => ({ ...item, planId: 'other-plan' }))).reading.eligible, false);
  assert.equal(assessmentMaterialEligibility(payload, good.map(item => ({ ...item, deleted: true }))).reading.eligible, false);
  assert.equal(assessmentMaterialEligibility(payload, good.map(item => ({ ...item, conflict: true }))).reading.eligible, false);
});
test('R4 newest current attempt cannot be replaced by an older trusted revision or a guessed ID prefix', () => {
  const payload = buildAssessment(input), good = evidence('cambridge');
  const revised = good.map(item => ({ ...item, seq: 2, createdAt: 2, payload: { ...item.payload, materialSource: 'unofficial' } }));
  assert.equal(assessmentMaterialEligibility(payload, [...good, ...revised]).reading.eligible, false);
  assert.equal(assessmentMaterialEligibility({ ...payload, materialId: 'C15' }, good).reading.eligible, false);
});
test('R4 formal official results retain completion, but an official reviewer on a weekly mock is not material evidence', () => {
  const formal = buildAssessment({ ...input, kind: 'official', scoreSources: { listening: 'official', reading: 'official', writing: 'official', speaking: 'official' } });
  assert.equal(scoreView(formal).finalGoalMet, true); assert.equal(scoreView(formal).effectiveScores.reading, 8.5);
  assert.equal(buildProgress(plan, [record('assessment', formal)], input.date).completed, true);
  assert.equal(scoreView({ ...formal, kind: 'weekly-mock' }).effectiveScores.reading, null);
  const gate = buildAssessment({ ...input, kind: 'gate', gateId: 'G4', scoreSources: { listening: 'official', reading: 'official', writing: 'official', speaking: 'official' } });
  assert.equal(buildProgress(plan, [record('assessment', gate)], input.date).completed, true);
});
test('R4 source qualification feeds original gate logic without mutating raw scores, hashes or sequence', () => {
  const first = record('assessment', buildAssessment({ ...input, kind: 'gate', gateId: 'G3', consecutiveIndex: 1 }), 'g3-first');
  const second = record('assessment', buildAssessment({ ...input, kind: 'gate', gateId: 'G3', consecutiveIndex: 2, date: '2026-11-10', materialId: 'paper-b' }, [first]), 'g3-second', 2);
  const originals = [first, second], raw = JSON.stringify(originals), accepted = [...evidence('official'), ...evidence('cambridge', 'full', '2026-11-10', 'paper-b')];
  assert.equal(buildProgress(plan, [...originals, ...accepted], '2026-11-10').gates.find(item => item.id === 'G3')?.met, true);
  const untrusted = accepted.map(item => item.payload.contentId === 'paper-b' ? { ...item, payload: { ...item.payload, materialSource: 'unofficial' } } : item);
  assert.equal(buildProgress(plan, [...originals, ...untrusted], '2026-11-10').gates.find(item => item.id === 'G3')?.met, false);
  const derived = materialQualifiedRecords([...originals, ...untrusted], plan.id).filter(item => item.kind === 'assessment');
  assert.deepEqual(derived.map(item => item.id), originals.map(item => item.id)); assert.equal((derived[1].payload.scores as Record<string, unknown>).reading, null);
  assert.equal((derived[1].payload.scoreSources as Record<string, unknown>).reading, null); assert.equal(JSON.stringify(originals), raw);
});

test('R4 full listening and reading with different content IDs can qualify one sitting via an exact common sourceRef', () => {
  const payload = buildAssessment({ ...input, materialId: 'C15T1' });
  const records = evidence('cambridge').map(item => ({ ...item, payload: { ...item.payload, contentId: `C15T1-${item.payload.skill}`, sourceRef: 'C15T1', total: 40, score: 37, correct: 37, answers: Array(40).fill('a') } }));
  const view = scoreView(payload, records);
  assert.equal(view.effectiveScores.listening, 8.5); assert.equal(view.effectiveScores.reading, 8.5);
  assert.equal(scoreView({ ...payload, materialId: 'C15' }, records).effectiveScores.reading, null, 'shared source references require exact equality, never a book/test prefix guess');
});
test('R4 partial nonempty answer lists or fewer than forty total questions cannot qualify as a full paper', () => {
  const payload = buildAssessment(input), records = evidence('official');
  assert.equal(scoreView(payload, records.map(item => ({ ...item, payload: { ...item.payload, answers: ['a'], total: 1 } }))).effectiveScores.reading, null);
  assert.equal(scoreView(payload, records.map(item => ({ ...item, payload: { ...item.payload, answers: Array(39).fill('a'), total: 40 } }))).effectiveScores.reading, null);
  assert.equal(scoreView(payload, records.map(item => ({ ...item, payload: { ...item.payload, answers: Array(40).fill('a'), total: 39 } }))).effectiveScores.reading, null);
});

test('R4 an explicitly classified external full-paper aggregate can qualify without invented answers or a material hash', () => {
  const payload = buildAssessment({ ...input, materialId: 'C15T1' });
  const records = evidence('cambridge').map(item => {
    const { contentHash: _hash, ...external } = item.payload;
    return { ...item, payload: { ...external, contentId: `external-${item.payload.skill}`, sourceRef: 'C15T1', scope: 'full', total: 40, score: 37, correct: 37, answers: [] } };
  });
  const raw = JSON.stringify(records), view = scoreView(payload, records);
  assert.equal(view.effectiveScores.listening, 8.5); assert.equal(view.effectiveScores.reading, 8.5);
  assert.equal(JSON.stringify(records), raw); assert.equal(Object.hasOwn(records[0].payload, 'contentHash'), false);
  assert.equal(scoreView(payload, records.map(item => ({ ...item, payload: { ...item.payload, answers: ['a'] } }))).effectiveScores.reading, null, 'a nonempty partial answer list is not a complete paper');
});
test('R4 full-paper qualification requires a valid integer raw count and consistent score/correct evidence', () => {
  const payload = buildAssessment(input), records = evidence('official');
  for (const patch of [{ score: 41 }, { score: 37.5 }, { correct: 36 }, { score: undefined, correct: undefined }]) {
    const changed = records.map(item => { const next = { ...item.payload, ...patch }; if (next.score === undefined) delete next.score; if (next.correct === undefined) delete next.correct; return { ...item, payload: next }; });
    assert.equal(scoreView(payload, changed).effectiveScores.reading, null);
  }
});
