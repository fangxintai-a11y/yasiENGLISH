import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAssessment, buildExternalAttempt, latestAssessment, latestEffectiveBySkill as rawLatestEffectiveBySkill, scoreView as rawScoreView, sourceLabel } from './scoresModel';
import { SECTION_TARGETS, validatePayload, type Revision } from './protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreBook } from './ui/ScoreBook';
import { TaskRegistration } from './ui/TaskRegistration';
import { buildDayPlan } from './planEngine';
import { bundledRules } from './planData';
import { dayDate } from './calendar';

const scores = { listening: 8.5, reading: 8.5, writing: 7.5, speaking: 7.5 };
const input = { planId: 'plan-a', date: '2026-11-09', kind: 'baseline' as const, scores, scoreSources: { listening: 'self', reading: 'self', writing: 'human', speaking: 'human' } as const };
function record(payload: Record<string, unknown>, id = 'assessment-a', seq = 1): Revision {
  return { id, revisionId: '12345678-1234-1234-1234-123456789012', kind: 'assessment', datasetId: null, planId: 'plan-a', baseRevision: null, seq, createdAt: seq, contentHash: 'a'.repeat(64), conflict: false, deleted: false, payload, payloadVersion: 2 };
}

test('assessment builders persist all four per-skill scores/sources, including missing values', () => {
  const value = buildAssessment({ ...input, scores: { ...scores, writing: null }, scoreSources: { ...input.scoreSources, writing: null } });
  assert.deepEqual(value.scores, { ...scores, writing: null });
  assert.deepEqual(value.scoreSources, { ...input.scoreSources, writing: null });
  assert.doesNotThrow(() => validatePayload('assessment', value));
  assert.equal(scoreView(value).overall, null);
});

test('writing/speaking estimates remain visible but never enter target gaps', () => {
  for (const source of ['self', 'rules', 'ai'] as const) {
    const value = { ...buildAssessment(input), scoreSources: { ...input.scoreSources, writing: source, speaking: source } };
    const view = scoreView(value);
    assert.equal(view.scores.writing, 7.5);
    assert.equal(view.effectiveScores.writing, null);
    assert.equal(view.gaps.writing, null);
    assert.equal(view.effectiveOverall, null);
    assert.equal(sourceLabel(source, 'writing'), '估分');
    assert.equal(sourceLabel(source, 'speaking'), '估分');
  }
  assert.equal(sourceLabel('self', 'reading'), '自评');
  assert.equal(sourceLabel('rules', 'listening'), '规则');
});

test('all five R0 score examples retain numeric overall and formal-only completion', () => {
  const rules = JSON.parse(readFileSync(new URL('../../public/curriculum365/v1/plan-rules.json', import.meta.url), 'utf8'));
  assert.equal(rules.scoreExamples.length, 5);
  for (const example of rules.scoreExamples) {
    const value = { planId: 'plan-a', date: '2026-11-09', kind: example.source === 'official' ? 'official' : 'weekly-mock', source: example.source, scores: example.sections };
    const view = scoreView(value);
    assert.equal(view.overall, example.expected.overall, example.id);
    assert.equal(view.finalGoalMet, example.expected.finalGoalMet, example.id);
    if (example.source !== 'ai') assert.deepEqual(view.gaps, example.expected.gaps, example.id);
  }
});

test('baseline cannot save non-human writing scores; blank sources accompany blank scores', () => {
  assert.throws(() => buildAssessment({ ...input, scoreSources: { ...input.scoreSources, writing: 'self' } }), /写作.*真人/);
  assert.throws(() => buildAssessment({ ...input, scores: { ...scores, writing: null } }), /空分.*来源/);
  assert.throws(() => buildAssessment({ ...input, scores: { ...scores, reading: 8.2 } }), /半分/);
});

test('official records require complete official sources for the same sitting', () => {
  assert.throws(() => buildAssessment({ ...input, kind: 'official' }), /正式.*来源/);
  assert.throws(() => buildAssessment({ ...input, kind: 'official', scores: { ...scores, writing: null }, scoreSources: { listening: 'official', reading: 'official', writing: null, speaking: 'official' } }), /完整四科/);
  const value = buildAssessment({ ...input, kind: 'official', scoreSources: { listening: 'official', reading: 'official', writing: 'official', speaking: 'official' } });
  assert.equal(scoreView(value).finalGoalMet, true);
});

test('latest assessment chooses one dated current sitting without mixing best skills or plans', () => {
  const older = record(buildAssessment(input), 'old', 4);
  const newer = record(buildAssessment({ ...input, date: '2026-11-10', scores: { listening: 6, reading: 6, writing: null, speaking: null }, scoreSources: { ...input.scoreSources, writing: null, speaking: null } }), 'new', 2);
  const other = { ...record(buildAssessment(input), 'other', 9), planId: 'plan-b' };
  const conflict = { ...record(buildAssessment({ ...input, date: '2026-11-12' }), 'conflict', 10), conflict: true };
  assert.equal(latestAssessment([older, newer, other, conflict], 'plan-a')?.id, 'new');
  assert.deepEqual(scoreView(latestAssessment([older, newer], 'plan-a')!.payload).effectiveScores, { listening: 6, reading: 6, writing: null, speaking: null });
  assert.deepEqual(SECTION_TARGETS, scores);
});

test('latest heads honor deletion and malformed scores are not selected as valid sittings', () => {
  const old = record(buildAssessment(input));
  const deleted = { ...old, seq: 2, deleted: true };
  assert.equal(latestAssessment([old, deleted], 'plan-a'), null);
  assert.equal(latestAssessment([record({ ...old.payload, scores: { ...scores, reading: 42 } })], 'plan-a'), null);
});

test('G3 stores an explicit pair with distinct dates and materials, no silent reset', () => {
  const first = buildAssessment({ ...input, kind: 'gate', gateId: 'G3', consecutiveIndex: 1, materialId: 'paper-a' });
  assert.equal(first.consecutiveIndex, 1);
  assert.throws(() => buildAssessment({ ...input, kind: 'gate', gateId: 'G3', consecutiveIndex: 2, materialId: 'paper-b' }, []), /第一次/);
  const previous = [record(first)];
  assert.throws(() => buildAssessment({ ...input, kind: 'gate', gateId: 'G3', consecutiveIndex: 2, materialId: 'paper-b' }, previous), /不同日期/);
  assert.throws(() => buildAssessment({ ...input, date: '2026-11-10', kind: 'gate', gateId: 'G3', consecutiveIndex: 2, materialId: 'paper-a' }, previous), /不同材料/);
  const second = buildAssessment({ ...input, date: '2026-11-10', kind: 'gate', gateId: 'G3', consecutiveIndex: 2, materialId: 'paper-b' }, previous);
  assert.equal(second.consecutiveIndex, 2);
  assert.equal(second.materialId, 'paper-b');
});

test('external attempts use allowed fields, original counts and immutable first-answer conditions', () => {
  const attempt = buildExternalAttempt({ planId: 'plan-a', date: '2026-11-09', day: 1, taskId: 'd1-listening', skill: 'listening', contentId: 'paper-one', score: 32, total: 40, actualMinutes: 30, materialName: '自备试卷', materialUrl: 'https://ielts.org/', note: '按此材料评分表登记', timed: true, unseen: true, replayed: false, viewedTranscript: false, firstAttempt: true });
  assert.equal(attempt.score, 32);
  assert.equal(attempt.correct, 32);
  assert.equal(attempt.total, 40);
  assert.deepEqual(attempt.answers, []);
  assert.equal(attempt.firstAttempt, true);
  assert.deepEqual(attempt.conditions, { timed: true, unseen: true, replayed: false, viewedTranscript: false });
  assert.match(String(attempt.note), /自备试卷/);
  assert.match(String(attempt.note), /https:\/\/ielts.org\//);
  assert.doesNotThrow(() => validatePayload('attempt', attempt));
});

test('external attempt rejects one-sided counts, impossible scores, unsafe URLs and negative minutes', () => {
  const base = { planId: 'plan-a', date: '2026-11-09', taskId: 'd1-review', skill: 'review', contentId: 'external-a', actualMinutes: 10 };
  assert.throws(() => buildExternalAttempt({ ...base, score: 2 }), /正确数.*总题数/);
  assert.throws(() => buildExternalAttempt({ ...base, score: 41, total: 40 }), /正确数/);
  assert.throws(() => buildExternalAttempt({ ...base, materialUrl: 'javascript:alert(1)' }), /链接/);
  assert.throws(() => buildExternalAttempt({ ...base, actualMinutes: -1 }), /实际分钟/);
});

test('scorebook displays the saved raw count without applying a global band conversion', () => {
  const assessment = record(buildAssessment({ ...input, materialId: 'paper-one' }));
  const attempt = { ...record(buildExternalAttempt({ planId: 'plan-a', date: input.date, taskId: 'd1-listening', skill: 'listening', contentId: 'paper-one', score: 32, total: 40, actualMinutes: 30 }), 'attempt-one'), kind: 'attempt' as const };
  const html = renderToStaticMarkup(createElement(ScoreBook, { records: [assessment, attempt], planId: 'plan-a' }));
  assert.match(html, /听力原始正确数：32\/40/);
});

test('scorebook renders unknown overall and pending writing, rather than zero', () => {
  const value = buildAssessment({ ...input, scores: { ...scores, writing: null }, scoreSources: { ...input.scoreSources, writing: null } });
  const html = renderToStaticMarkup(createElement(ScoreBook, { records: [record(value)], planId: 'plan-a' }));
  assert.match(html, /写作：未评估/);
  assert.match(html, /总分：未知/);
  assert.doesNotMatch(html, /写作：0/);
});

test('external registration retains the saved phase-four skill instead of the default block skill', () => {
  const plan = { ...record({ planId: 'plan-a', startDate: '2026-11-09', timeZone: 'Asia/Shanghai' }, 'plan-a'), kind: 'plan' as const };
  const dayPlan = buildDayPlan(bundledRules, plan.payload, dayDate('2026-11-09', 'Asia/Shanghai', 302));
  const block = dayPlan.blocks.find(block => block.id === 'timed-section')!;
  assert.equal(block.skill, 'writing');
  const mission = { ...record({ skill: 'reading', status: 'in_progress', actualMinutes: 12 }), kind: 'mission' as const };
  const html = renderToStaticMarkup(createElement(TaskRegistration, { plan, dayPlan, block, mission }));
  assert.match(html, /外部完成后登记 · 阅读/);
  assert.match(html, /登记原始正确数/);
});

test('external registration honors a new explicit selection before the card status is saved', () => {
  const plan = { ...record({ planId: 'plan-a', startDate: '2026-11-09', timeZone: 'Asia/Shanghai' }, 'plan-a'), kind: 'plan' as const };
  const dayPlan = buildDayPlan(bundledRules, plan.payload, dayDate('2026-11-09', 'Asia/Shanghai', 302));
  const block = dayPlan.blocks.find(block => block.id === 'timed-section')!;
  const mission = { ...record({ skill: 'reading', status: 'in_progress', actualMinutes: 12 }), kind: 'mission' as const };
  const html = renderToStaticMarkup(createElement(TaskRegistration, { plan, dayPlan, block, mission, selectedSkill: 'writing' }));
  assert.match(html, /外部完成后登记 · 写作/);
  assert.doesNotMatch(html, /登记原始正确数/);
});

test('latest effective scores retain per-skill dates, sources and record IDs across split sessions', () => {
  const saturday = record(buildAssessment({ ...input, kind: 'weekly-mock', date: '2026-11-14', scores: { listening: 6.5, reading: 7, writing: null, speaking: null }, scoreSources: { listening: 'self', reading: 'rules', writing: null, speaking: null } }), 'saturday', 1);
  const sunday = record(buildAssessment({ ...input, kind: 'weekly-mock', date: '2026-11-15', scores: { listening: null, reading: null, writing: 7, speaking: 6.5 }, scoreSources: { listening: null, reading: null, writing: 'human', speaking: 'human' } }), 'sunday', 2);
  const result = latestEffectiveBySkill([sunday, saturday], 'plan-a');
  assert.deepEqual(result, {
    listening: { score: 6.5, source: 'self', date: '2026-11-14', recordId: 'saturday' },
    reading: { score: 7, source: 'rules', date: '2026-11-14', recordId: 'saturday' },
    writing: { score: 7, source: 'human', date: '2026-11-15', recordId: 'sunday' },
    speaking: { score: 6.5, source: 'human', date: '2026-11-15', recordId: 'sunday' },
  });
});

test('newer writing estimates and single-work weekly calibration never replace section scores', () => {
  const human = record(buildAssessment(input), 'human', 1);
  for (const source of ['self', 'rules', 'ai'] as const) {
    const estimate = record({ ...human.payload, date: '2026-11-16', scores: { listening: null, reading: null, writing: 9, speaking: 9 }, scoreSources: { listening: null, reading: null, writing: source, speaking: source } }, 'estimate', 2);
    const calibration = record({ planId: 'plan-a', kind: 'weekly-calibration', date: '2026-11-17', weekIndex: 1, source: 'human', workRevisionId: '12345678-1234-1234-1234-123456789012', taskType: 'task2', bands: { taskResponse: 9, coherence: 9, lexical: 9, grammar: 9 }, scores: { listening: 9, reading: 9, writing: 9, speaking: 9 } }, 'calibration', 3);
    assert.doesNotThrow(() => validatePayload('assessment', calibration.payload));
    const result = latestEffectiveBySkill([estimate, calibration, human], 'plan-a');
    assert.equal(result.writing?.recordId, 'human');
    assert.equal(result.speaking?.recordId, 'human');
    assert.equal(result.listening?.recordId, 'human');
  }
});

test('per-skill selection leaves missing scores null and excludes other plans, deleted heads and conflicts', () => {
  const complete = record(buildAssessment(input), 'complete', 1);
  const deleted = { ...complete, deleted: true, seq: 2, createdAt: 2 };
  const other = { ...record(buildAssessment(input), 'other', 3), planId: 'plan-b' };
  const conflict = { ...record(buildAssessment(input), 'conflict', 4), conflict: true };
  assert.deepEqual(latestEffectiveBySkill([complete, deleted, other, conflict], 'plan-a'), { listening: null, reading: null, writing: null, speaking: null });
});


test('per-skill trends choose the newest valid result even when its score is lower', () => {
  const older = record(buildAssessment(input), 'older', 9);
  const newer = record(buildAssessment({ ...input, date: '2026-11-16', scores: { listening: 6, reading: 6, writing: 6, speaking: 6 } }), 'newer', 1);
  const values = latestEffectiveBySkill([older, newer], 'plan-a');
  for (const value of Object.values(values)) {
    assert.equal(value?.score, 6);
    assert.equal(value?.recordId, 'newer');
    assert.equal(value?.date, '2026-11-16');
  }
});

// Existing score behavior cases now carry explicit synthetic, classified full-paper evidence.
function withMaterialEvidence(records: readonly Revision[]): Revision[] {
  return records.flatMap(item => {
    if (item.kind !== 'assessment' || !item.payload.scores) return [item];
    const materialId = String(item.payload.materialId ?? `synthetic-${item.id}`), payload = { ...item.payload, materialId };
    return [{ ...item, payload }, ...['listening', 'reading'].map(skill => ({ ...item, kind: 'attempt' as const, id: `evidence-${item.id}-${skill}`, payload: { planId: item.payload.planId, date: item.payload.date, contentId: materialId, skill, answers: Array(40).fill('a'), score: 37, correct: 37, total: 40, scope: 'full', materialSource: 'cambridge', contentHash: 'b'.repeat(64) } }))];
  });
}

function scoreView(payload: Record<string, unknown>) { const records = withMaterialEvidence([record(payload)]); return rawScoreView(records[0].payload, records); }
function latestEffectiveBySkill(records: readonly Revision[], planId: string) { return rawLatestEffectiveBySkill(withMaterialEvidence(records), planId); }
