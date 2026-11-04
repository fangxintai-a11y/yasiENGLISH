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
  const html = renderToStaticMarkup(createElement(MissionCard, { plan, dayPlan, block, userId: null, index: 0 }));
  assert.match(html, /开始写作/);
  assert.match(html, /#\/writing\?task=d4-writing&amp;date=2026-11-12&amp;day=4&amp;minutes=20/);
  assert.match(html, /外部完成后登记/);
});
