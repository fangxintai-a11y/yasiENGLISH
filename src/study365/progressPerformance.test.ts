import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProgress } from './progressModel';
import { SECTION_TARGETS, type Revision } from './protocol';

test('15000-record progress shares the full-history projection across all 28 dates', () => {
  const planId = 'scale-progress';
  const records: Revision[] = Array.from({ length: 15000 }, (_, index) => ({
    id: `record-${index}`, kind: 'mission', planId, datasetId: null,
    revisionId: `b6000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    baseRevision: null, seq: index, createdAt: index, contentHash: 'a'.repeat(64), conflict: false, deleted: false,
    payload: { planId, date: '2027-11-08', day: 365, taskId: `task-${index}`, status: 'partial', plannedMinutes: 0, actualMinutes: 0, timeSource: 'timer' },
  }));
  const plan: Revision = { ...records[0], id: planId, kind: 'plan', payload: {
    planId, startDate: '2026-11-09', timeZone: 'Asia/Shanghai', targetBand: 8, sectionTargets: SECTION_TARGETS,
  } };
  records[0] = { ...records[0], payload: { ...records[0].payload, status: 'completed', plannedMinutes: 30, actualMinutes: 17 } };
  const originalSort = Array.prototype.sort;
  let fullHistorySorts = 0;
  Array.prototype.sort = function (...args) {
    if (this.length >= records.length) fullHistorySorts++;
    return originalSort.apply(this, args);
  };
  try {
    const model = buildProgress(plan, records, '2027-11-08');
    assert.equal(model.recentDays.length, 28);
    assert.equal(model.actualMinutes, 17);
    assert.deepEqual(model.recentDays.at(-1), { date: '2027-11-08', completedMinutes: 30, actualMinutes: 17, totalMinutes: 120, ratio: .25, status: 'partial' });
    assert.equal(model.completed, false);
    assert.ok(fullHistorySorts <= 1, `full history sorted ${fullHistorySorts} times for one view`);
  } finally { Array.prototype.sort = originalSort; }
});
