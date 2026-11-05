import test from 'node:test';
import assert from 'node:assert/strict';
import { READING_QUESTION_TYPES, LISTENING_QUESTION_TYPES } from './contentSchemas';
import { LocalMaterialSchema, type LocalMaterial, type LocalQuestion } from './localBankSchema';
import type { Revision } from './protocol';
import { buildListeningReadingSchedule, officialTypeCalibration, selectReadingForDay } from './listeningReadingSchedule';
const readingTypes: LocalQuestion['type'][] = ['true-false-not-given', 'yes-no-not-given', 'matching-headings', 'matching-information', 'summary-completion', 'multiple-choice'];
const name = (index: number) => String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
function material(index: number, skill: 'reading' | 'listening' = 'reading', scope: LocalMaterial['scope'] = 'section', source: LocalMaterial['source']['materialSource'] = 'unofficial'): LocalMaterial {
  const q: LocalQuestion = { id: 'q1', type: skill === 'reading' ? readingTypes[index % readingTypes.length] : 'note-completion', prompt: 'Synthetic question.', answer: { accepted: ['a'], maxWords: 2 }, evidence: {}, answerVerified: true };
  const common = { id: `${skill}-${scope}-${source}-${index}`, version: '1', title: `Synthetic ${skill} report ${name(index)}`, source: { materialSource: source, sourceRef: `synthetic:${index}`, rights: 'Self-authored fixture', answerVerified: true }, contentHash: 'a'.repeat(64), scope, deliveryMode: 'local-import' as const, questions: [q], pool: 'practice' as const, frequency: 'high' as const };
  return skill === 'reading' ? { ...common, skill, passage: 'A synthetic passage.', paragraphs: [{ id: 'p1', text: 'A synthetic passage.' }], passageNumber: (index % 3 + 1) as 1 | 2 | 3 } : { ...common, skill, transcript: 'Synthetic audio transcript.', section: 1, audio: { path: `audio/sample-${index}.mp3`, durationSeconds: 60 } };
}
function bank(): LocalMaterial[] {
  return [...Array.from({ length: 42 }, (_, index) => material(index)), ...Array.from({ length: 6 }, (_, index) => material(100 + index, 'reading', 'type-drill', 'official')), ...Array.from({ length: 14 }, (_, index) => material(200 + index, 'listening')), ...Array.from({ length: 4 }, (_, index) => material(300 + index, 'listening', 'type-drill', 'official'))];
}
function attempt(mat: LocalMaterial, index: number, score = 9, total = 10): Revision {
  return { id: `attempt-${index}`, kind: 'attempt', planId: 'plan-a', datasetId: null, revisionId: '12345678-1234-1234-1234-123456789012', baseRevision: null, seq: index, createdAt: index, deleted: false, conflict: false, contentHash: 'b'.repeat(64), payload: { planId: 'plan-a', date: `2026-11-${String(10 + index).padStart(2, '0')}`, contentId: mat.id, contentVersion: mat.version, contentHash: mat.contentHash, skill: mat.skill, materialSource: mat.source.materialSource, sourceRef: mat.source.sourceRef, scope: mat.scope, answers: ['a'], firstAttempt: true, score, correct: score, total } };
}
test('14-day schedule never repeats reading, includes all six families, climbs P1 to P3 and retains fourteen reserve pieces', () => {
  const value = buildListeningReadingSchedule(bank());
  assert.equal(value.days.length, 14); assert.equal(new Set(value.days.map(day => day.reading?.id)).size, 14);
  assert.deepEqual(value.days.map(day => day.reading?.passageNumber), [...Array(5).fill(1), ...Array(5).fill(2), ...Array(4).fill(3)]);
  assert.equal(value.readingReserve.length, 14); assert.ok(value.readingReserve.every(item => !value.days.some(day => day.reading?.id === item.id)));
  assert.equal(new Set(value.days.flatMap(day => day.readingOfficial?.questionTypes ?? [])).size, 6);
  assert.ok(value.days.every(day => day.readingOfficial && day.listeningOfficial && day.listening)); assert.equal(value.missing.reading, 0);
});
test('title normalization does not count another ID or version of the same passage as a new article', () => {
  const materials = bank(), first = materials[0];
  const duplicate = { ...first, id: 'duplicate-id', version: '2', title: first.title.toUpperCase().replaceAll(' ', ' - ') };
  const value = buildListeningReadingSchedule([first, duplicate]);
  assert.equal(value.days.filter(day => day.reading).length, 1); assert.equal(value.missing.reading, 13); assert.equal(value.readingReserve.length, 0);
});
test('holdout is never scheduled and full exam sections stay reserved for mocks', () => {
  const full = { ...material(1, 'listening', 'full', 'cambridge'), examId: 'C15T1' };
  const section = { ...material(2, 'listening', 'section', 'cambridge'), examId: 'C15T1' };
  const held = { ...material(3), pool: 'holdout' as const };
  const value = buildListeningReadingSchedule([full, section, held]);
  assert.ok(value.days.every(day => !day.reading && !day.listening)); assert.equal(value.missing.listening, 14);
});
test('frequency orders choices within a passage level; it does not stand in for level', () => {
  const high = { ...material(0), frequency: 'high' as const, id: 'z-high' }, low = { ...material(3), frequency: 'low' as const, id: 'a-low' };
  const value = buildListeningReadingSchedule([low, high]); assert.equal(value.days[0].reading?.id, high.id); assert.equal(value.days[1].reading?.id, low.id);
});
test('missing questions or audio and transcript-only short samples cannot masquerade as official drills', () => {
  const reading = { ...material(100, 'reading', 'short', 'official'), questions: [] };
  const listening = { ...material(300, 'listening', 'type-drill', 'official'), audio: undefined };
  const value = buildListeningReadingSchedule([reading, listening]);
  assert.equal(value.missing.readingOfficialDays, 14); assert.equal(value.missing.listeningOfficialDays, 14);
  assert.ok(value.shortages.some(text => text.includes('还缺14篇')));
});
test('daily listening prioritizes surplus Cambridge sections, then other section practice, never repeats audio material', () => {
  const cam = material(1, 'listening', 'section', 'cambridge'), other = material(2, 'listening'), official = material(3, 'listening', 'section', 'official');
  const value = buildListeningReadingSchedule([official, other, cam]); assert.deepEqual(value.days.slice(0, 3).map(day => day.listening?.id), [cam.id, other.id, official.id]);
  assert.equal(value.missing.listening, 11);
});
test('three most recent same-level first answers at 85 percent advance only selection; low accuracy retains level on a different article', () => {
  const materials = bank(), p1 = materials.filter(item => item.skill === 'reading' && item.scope === 'section' && item.passageNumber === 1).slice(0, 3);
  const high = p1.map((item, index) => attempt(item, index + 1, 9, 10));
  const next = selectReadingForDay(materials, high, 'plan-a', 4); assert.equal(next.reason, 'advance'); assert.equal(next.passageNumber, 2); assert.equal(next.material?.passageNumber, 2);
  const low = selectReadingForDay(materials, [attempt(p1[0], 1, 5, 10)], 'plan-a', 6); assert.equal(low.reason, 'repeat-level'); assert.equal(low.passageNumber, 1); assert.notEqual(low.material?.id, p1[0].id);
});
test('retakes, other plans, disputed questions and revision copies do not manufacture three successful first answers', () => {
  const materials = bank(), p1 = materials.filter(item => item.skill === 'reading' && item.scope === 'section' && item.passageNumber === 1).slice(0, 3);
  const first = attempt(p1[0], 1, 9, 10), revision = { ...first, seq: 9, createdAt: 9 };
  const other = { ...attempt(p1[1], 2), planId: 'plan-other' }, retake = { ...attempt(p1[2], 3), payload: { ...attempt(p1[2], 3).payload, firstAttempt: false } };
  assert.equal(selectReadingForDay(materials, [first, revision, other, retake], 'plan-a', 4).reason, 'scheduled');
});
test('official type calibration reports accuracy only and ignores review answers, disputed items, unclassified and mismatched hashes', () => {
  const mat = material(100, 'reading', 'type-drill', 'official'), valid = attempt(mat, 1, 0, 1);
  valid.payload.questionResults = [{ questionId: 'q1', correct: false, confidence: 'sure', errorCause: 'vocab-unknown', reviewCorrect: true }]; valid.payload.reviewAnswers = ['a'];
  const rows = officialTypeCalibration([valid], [mat], 'plan-a'); assert.equal(rows.length, 1); assert.equal(rows[0].correct, 0); assert.equal(rows[0].total, 1); assert.equal(rows[0].accuracy, 0); assert.equal(Object.hasOwn(rows[0], 'band'), false);
  const disputed = { ...valid, payload: { ...valid.payload, questionResults: [{ questionId: 'q1', correct: false, confidence: 'sure', errorCause: null, answerDisputed: true, note: 'Synthetic key dispute.' }] } };
  assert.equal(officialTypeCalibration([disputed], [mat], 'plan-a').length, 0);
  assert.equal(officialTypeCalibration([{ ...valid, payload: { ...valid.payload, materialSource: 'unofficial' } }], [mat], 'plan-a').length, 0);
  assert.equal(officialTypeCalibration([{ ...valid, payload: { ...valid.payload, contentHash: 'c'.repeat(64) } }], [mat], 'plan-a').length, 0);
});

test('official type rotation restarts the complete cycle instead of repeating only its first item', () => {
  const value = buildListeningReadingSchedule(bank());
  assert.equal(new Set(value.days.slice(6, 12).map(day => day.readingOfficial?.id)).size, 6);
});
test('duplicate first-attempt claims for one article cannot count as three independent successful articles', () => {
  const materials = bank(), mat = materials.find(item => item.skill === 'reading' && item.scope === 'section' && item.passageNumber === 1)!;
  const duplicateClaims = [1, 2, 3].map(index => attempt(mat, index));
  assert.equal(selectReadingForDay(materials, duplicateClaims, 'plan-a', 4).reason, 'scheduled');
});

test('default live reading follows the scheduled unused article before a same-level fallback', () => {
  const first = { ...material(0), id: 'a-first', passageNumber: 1, frequency: 'high' } as LocalMaterial;
  const repeatedType = { ...material(6), id: 'b-repeat-type', passageNumber: 1, frequency: 'high' } as LocalMaterial;
  const unseenType = { ...material(1), id: 'z-new-type', passageNumber: 1, frequency: 'medium' } as LocalMaterial;
  const materials = [first, repeatedType, unseenType], schedule = buildListeningReadingSchedule(materials);
  assert.equal(schedule.days[1].reading?.id, unseenType.id);
  const selected = selectReadingForDay(materials, [attempt(first, 1, 8, 10)], 'plan-a', 2);
  assert.equal(selected.reason, 'scheduled'); assert.equal(selected.material?.id, schedule.days[1].reading?.id);
});
test('official calibration uses the earliest independent first-claim only for the same material version and hash', () => {
  const mat = material(100, 'reading', 'type-drill', 'official'), first = attempt(mat, 1, 0, 1), later = attempt(mat, 2, 1, 1);
  first.payload.answers = ['wrong']; first.payload.questionResults = [{ questionId: 'q1', correct: false, confidence: 'sure', errorCause: 'vocab-unknown' }];
  later.payload.answers = ['a']; later.payload.questionResults = [{ questionId: 'q1', correct: true, confidence: 'sure', errorCause: null }];
  const rows = officialTypeCalibration([later, first], [mat], 'plan-a');
  assert.equal(rows.length, 1); assert.equal(rows[0].total, 1); assert.equal(rows[0].correct, 0); assert.equal(rows[0].accuracy, 0);
  assert.deepEqual(rows[0].attemptIds, [first.id]);
});


test('a two-type official pool reports missing question types even when rotation fills all fourteen dates', () => {
  const reading = [material(100, 'reading', 'type-drill', 'official'), material(101, 'reading', 'type-drill', 'official')];
  const listening = [material(200, 'listening', 'type-drill', 'official'), { ...material(201, 'listening', 'type-drill', 'official'), questions: [{ ...material(201, 'listening', 'type-drill', 'official').questions[0], type: 'form-completion' as const }] }];
  const value = buildListeningReadingSchedule([...reading, ...listening]);
  const actualReadingTypes = new Set(reading.flatMap(item => item.questions.map(question => question.type)));
  assert.equal(value.missing.readingOfficialDays, 0); assert.equal(value.missing.listeningOfficialDays, 0);
  assert.deepEqual(value.missingOfficialReadingTypes, READING_QUESTION_TYPES.filter(type => !actualReadingTypes.has(type)));
  assert.deepEqual(value.missingOfficialListeningTypes, LISTENING_QUESTION_TYPES.filter(type => !['note-completion', 'form-completion'].includes(type)));
  assert.ok(value.shortages.some(text => text.includes('官方阅读题型尚缺'))); assert.ok(value.shortages.some(text => text.includes('官方听力题型尚缺')));
});
test('complete expected official-type pools cover the enum and expose no fabricated type shortage', () => {
  const typed = (type: LocalQuestion['type'], index: number, skill: 'reading' | 'listening') => {
    const item = material(index, skill, 'type-drill', 'official');
    const options = ['multiple-choice', 'matching', 'map-labeling', 'matching-headings', 'matching-features', 'matching-sentence-endings'].includes(type) ? [{ id: 'A', text: 'Synthetic option A' }, { id: 'B', text: 'Synthetic option B' }] : undefined;
    const accepted = type === 'true-false-not-given' ? ['TRUE'] : type === 'yes-no-not-given' ? ['YES'] : ['A'];
    return LocalMaterialSchema.parse({ ...item, questions: [{ ...item.questions[0], type, answer: { accepted, maxWords: 2 }, ...(options ? { options } : {}) }] });
  };
  const reading = READING_QUESTION_TYPES.map((type, index) => typed(type, 100 + index, 'reading'));
  const listening = LISTENING_QUESTION_TYPES.map((type, index) => typed(type, 200 + index, 'listening'));
  const value = buildListeningReadingSchedule([...reading, ...listening]);
  assert.deepEqual(value.missingOfficialReadingTypes, []); assert.deepEqual(value.missingOfficialListeningTypes, []);
  assert.deepEqual(new Set(value.days.flatMap(day => day.readingOfficial?.questionTypes ?? [])), new Set(READING_QUESTION_TYPES));
  assert.deepEqual(new Set(value.days.flatMap(day => day.listeningOfficial?.questionTypes ?? [])), new Set(LISTENING_QUESTION_TYPES));
});
