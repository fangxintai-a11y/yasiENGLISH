import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MissionCard } from './ui/MissionCard';
import { buildDayPlan } from './planEngine';
import { bundledRules } from './planData';
import type { Revision } from './protocol';
const plan = { id: 'plan-a', payload: { planId: 'plan-a', startDate: '2026-11-09', timeZone: 'Asia/Shanghai' } } as unknown as Revision;
test('today writing entry carries the exact task and keeps paper registration', () => {
  const dayPlan = buildDayPlan(bundledRules, plan.payload, '2026-11-12');
  const block = dayPlan.blocks.find(item => item.skill === 'writing')!;
  const html = renderToStaticMarkup(createElement(MissionCard, { plan, dayPlan, block, userId: null, index: 0,
    assignment: { day: 4, date: dayPlan.date, taskId: "d4-writing", blockId: "writing", skill: "writing", minutes: 20,
      status: "assigned", materials: [], checkpoint: false, notice: "Exact automatic assignment",
      route: "#/writing?task=d4-writing&date=2026-11-12&day=4&minutes=20&material=test-exact-source" } }));
  assert.match(html, /开始本节写作/);
  assert.match(html, /#\/writing\?task=d4-writing&amp;date=2026-11-12&amp;day=4&amp;minutes=20/);
  assert.match(html, /外部完成后登记/);
  assert.match(html, /material=test-exact-source/);
});
test('Sunday human handoff task shows work awaiting review without manufacturing a score', () => {
  const dayPlan = buildDayPlan(bundledRules, plan.payload, '2026-11-15');
  const block = dayPlan.blocks.find(item => item.id === 'human-calibration-handoff')!;
  const html = renderToStaticMarkup(createElement(MissionCard, { plan, dayPlan, block, userId: null, index: 0, pendingWritingReviews: 2 }));
  assert.match(html,/写作待评阅：2篇/); assert.match(html,/#\/writing/); assert.doesNotMatch(html,/真人分数：0/);
});

test('a missing automatic source is explicit and does not offer a falsely prepared lesson', () => {
  const dayPlan = buildDayPlan(bundledRules, plan.payload, '2026-11-12');
  const block = dayPlan.blocks.find(item => item.skill === 'writing')!;
  const html = renderToStaticMarkup(createElement(MissionCard, { plan, dayPlan, block, userId: null, index: 0,
    assignment: { day: 4, date: dayPlan.date, taskId: 'd4-writing', blockId: 'writing', skill: 'writing', minutes: 20,
      status: 'missing', materials: [], checkpoint: false, notice: 'No unseen source', route: null } }));
  assert.match(html, /本节材料待补齐/);
  assert.doesNotMatch(html, /开始本节写作/);
  assert.match(html, /外部完成后登记/);
});
