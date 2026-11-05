import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgress as rawBuildProgress } from './progressModel';
import { bundledRules } from './planData';
import { buildAssessment, scoreView } from './scoresModel';
import { GATE_TARGETS, SECTION_TARGETS, type LearningPayload, type Revision } from './protocol';
import { dayDate } from './calendar';

function record(kind: Revision['kind'], payload: LearningPayload, id = 'record-a', seq = 1): Revision {
  return { id, kind, payload, datasetId: null, planId: 'plan-a', revisionId: '12345678-1234-1234-1234-123456789012', baseRevision: null, seq, createdAt: seq, contentHash: 'a'.repeat(64), conflict: false, deleted: false };
}
const plan = record('plan', { planId: 'plan-a', startDate: '2026-11-09', timeZone: 'Asia/Shanghai', curriculumVersion: bundledRules.version, studyBudgetMinutes: bundledRules.goal.dailyMinutes, targetBand: GATE_TARGETS.G4.overall, sectionTargets: SECTION_TARGETS, enabled: true }, 'plan-a');
const sources = { listening: 'human', reading: 'human', writing: 'human', speaking: 'human' } as const;
const scoreInput = { planId: plan.id, kind: 'baseline' as const, date: '2026-11-09', scores: { ...SECTION_TARGETS }, scoreSources: sources };

test('progress applies all five saved R0 examples and never completes on estimates or a date', () => {
  for (const example of bundledRules.scoreExamples) {
    const payload = { planId: plan.id, kind: example.source === 'official' ? 'official' : 'weekly-mock', source: example.source, date: '2026-11-09', scores: example.sections };
    const model = buildProgress(plan, [record('assessment', payload)], '2027-11-09');
    assert.equal(scoreView(payload).overall, example.expected.overall, example.id);
    assert.equal(model.current.effectiveOverall, example.source === 'ai' ? null : example.expected.overall, example.id);
    assert.equal(model.completed, example.expected.finalGoalMet, example.id);
  }
  assert.equal(buildProgress(plan, [], '2027-11-09').completed, false);
});

test('later writing estimates retain earlier effective human scores and the latest complete sitting', () => {
  const old = record('assessment', buildAssessment(scoreInput), 'old');
  const newer = record('assessment', { ...buildAssessment({ ...scoreInput, date: '2026-11-10' }), scoreSources: { ...sources, writing: 'ai' } }, 'new', 2);
  const model = buildProgress(plan, [old, newer], '2026-11-10');
  assert.equal(model.latest?.id, 'old');
  assert.equal(model.bySkill.writing?.recordId, 'old');
  assert.equal(model.bySkill.writing?.date, '2026-11-09');
  assert.equal(model.bySkill.reading?.recordId, 'new');
  assert.equal(model.current.effectiveScores.writing, 7.5);
  assert.equal(model.overallGap, 0);
  assert.equal(model.completed, false);
});

test('gate dates remain plan days 90/210/300 and actual gate records determine passage', () => {
  const model = buildProgress(plan, [], '2026-11-09');
  assert.deepEqual(model.gates.map(gate => gate.dueDate), [...[90, 210, 300].map(day => dayDate(String(plan.payload.startDate), String(plan.payload.timeZone), day)), null]);
  assert.equal(model.nextGate?.id, 'G1');
  assert.equal(model.nextGate?.met, false);
  assert.equal(buildProgress(plan, [], '2027-11-09').gates[0].met, false);
});

test('G3 is passed only by two explicitly indexed different-date different-material gate records', () => {
  const first = record('assessment', buildAssessment({ ...scoreInput, kind: 'gate', gateId: 'G3', consecutiveIndex: 1, materialId: 'paper-a' }), 'g3-one', 1);
  const second = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-10', kind: 'gate', gateId: 'G3', consecutiveIndex: 2, materialId: 'paper-b' }, [first]), 'g3-two', 2);
  const model = buildProgress(plan, [first, second], '2026-11-11');
  assert.equal(model.gates.find(gate => gate.id === 'G3')?.met, true);
  assert.equal(model.gates.find(gate => gate.id === 'G3')?.required, 2);
  const broken = { ...second, payload: { ...second.payload, materialId: 'paper-a' } };
  assert.equal(buildProgress(plan, [first, broken], '2026-11-11').gates.find(gate => gate.id === 'G3')?.met, false);
});

test('actual time and 28-day completions use mission heads without turning hours into scores', () => {
  const mission = (id: string, plannedMinutes: number, actualMinutes: number, status: string, seq: number) => record('mission', { planId: plan.id, date: '2026-11-09', day: 1, taskId: id, status, plannedMinutes, actualMinutes, timeSource: 'manual' }, id, seq);
  const records = [mission('done', 90, 80, 'completed', 1), mission('done', 90, 85, 'completed', 2), mission('partial', 30, 20, 'partial', 3)];
  const model = buildProgress(plan, records, '2026-11-09');
  assert.equal(model.capacityMinutes, 730 * 60);
  assert.equal(model.actualMinutes, 105);
  assert.equal(model.recentDays.length, 28);
  assert.equal(model.recentDays.at(-1)?.date, '2026-11-09');
  assert.equal(model.recentDays.at(-1)?.ratio, 0.75);
  assert.equal(model.recentDays.at(-1)?.status, 'partial');
  assert.equal(model.current.overall, null);
  assert.equal(model.completed, false);
});

test('weak-skill recommendation uses effective gaps and fixed writing/speaking/listening/reading tie order', () => {
  const low = { listening: 7.5, reading: 7.5, writing: 6.5, speaking: 6.5 };
  let model = buildProgress(plan, [record('assessment', buildAssessment({ ...scoreInput, scores: low }))], '2026-11-09');
  assert.equal(model.recommendedSkill, 'writing');
  model = buildProgress(plan, [record('assessment', buildAssessment({ ...scoreInput, scores: { ...low, writing: 7.5 } }))], '2026-11-09');
  assert.equal(model.recommendedSkill, 'speaking');
  assert.equal(model.hasScores, true);
  assert.equal(buildProgress(plan, [], '2026-11-09').hasScores, false);
});

test('weekend split assessments retain listening for the gate gap after Sunday writing arrives', () => {
  const saturday = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-14', kind: 'weekly-mock', scores: { listening: 5, reading: 4, writing: null, speaking: null }, scoreSources: { listening: 'self', reading: 'self', writing: null, speaking: null } }), 'sat', 2);
  const sunday = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-15', kind: 'weekly-mock', scores: { listening: null, reading: null, writing: 7, speaking: 7 }, scoreSources: { listening: null, reading: null, writing: 'human', speaking: 'human' } }), 'sun', 3);
  const model = buildProgress(plan, [saturday, sunday], '2026-11-15');
  assert.equal(model.gates[0].gaps.listening, 2);
});

test('weekend split assessments recommend the largest current per-skill gap', () => {
  const saturday = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-14', kind: 'weekly-mock', scores: { listening: 5, reading: 4, writing: null, speaking: null }, scoreSources: { listening: 'self', reading: 'self', writing: null, speaking: null } }), 'sat', 2);
  const sunday = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-15', kind: 'weekly-mock', scores: { listening: null, reading: null, writing: 7, speaking: 7 }, scoreSources: { listening: null, reading: null, writing: 'human', speaking: 'human' } }), 'sun', 3);
  assert.equal(buildProgress(plan, [saturday, sunday], '2026-11-15').recommendedSkill, 'reading');
});

test('overall target gap keeps the most recent complete effective sitting after partial results', () => {
  const complete = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-09', scores: { listening: 6.5, reading: 6.5, writing: 6.5, speaking: 6.5 } }), 'complete', 1);
  const partial = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-15', scores: { listening: null, reading: null, writing: 7, speaking: 7 }, scoreSources: { listening: null, reading: null, writing: 'human', speaking: 'human' } }), 'partial', 2);
  const model = buildProgress(plan, [complete, partial], '2026-11-15');
  assert.equal(model.overallGap, 1.5);
});


test('all four per-skill targets across two partial sittings do not manufacture an overall', () => {
  const saturday = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-14', kind: 'weekly-mock', scores: { listening: 8.5, reading: 8.5, writing: null, speaking: null }, scoreSources: { listening: 'self', reading: 'self', writing: null, speaking: null } }), 'sat', 2);
  const sunday = record('assessment', buildAssessment({ ...scoreInput, date: '2026-11-15', kind: 'weekly-mock', scores: { listening: null, reading: null, writing: 7.5, speaking: 7.5 }, scoreSources: { listening: null, reading: null, writing: 'human', speaking: 'human' } }), 'sun', 3);
  const model = buildProgress(plan, [saturday, sunday], '2026-11-15');
  assert.deepEqual(model.sectionScores, SECTION_TARGETS);
  assert.equal(model.latest, null);
  assert.equal(model.current.effectiveOverall, null);
  assert.equal(model.overallGap, null);
  assert.equal(model.gates[0].overallGap, null);
  assert.equal(model.completed, false);
});

// Existing score behavior cases now carry explicit synthetic, classified full-paper evidence.
function withMaterialEvidence(records: readonly Revision[]): Revision[] {
  return records.flatMap(item => {
    if (item.kind !== 'assessment' || !item.payload.scores) return [item];
    const materialId = String(item.payload.materialId ?? `synthetic-${item.id}`), payload = { ...item.payload, materialId };
    return [{ ...item, payload }, ...['listening', 'reading'].map(skill => ({ ...item, kind: 'attempt' as const, id: `evidence-${item.id}-${skill}`, payload: { planId: item.payload.planId, date: item.payload.date, contentId: materialId, skill, answers: Array(40).fill('a'), score: 37, correct: 37, total: 40, scope: 'full', materialSource: 'cambridge', contentHash: 'b'.repeat(64) } }))];
  });
}

function buildProgress(plan: Revision, records: readonly Revision[], date: string) { return rawBuildProgress(plan, withMaterialEvidence(records), date); }
