import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MissionCard } from './ui/MissionCard';
import { buildDayPlan } from './planEngine';
import { bundledRules } from './planData';
import type { Revision } from './protocol';
const plan = { id:'plan-a',payload:{planId:'plan-a',startDate:'2026-11-09',timeZone:'Asia/Shanghai'} } as unknown as Revision;
test('today speaking entry carries the task context and retains external registration',()=>{
 const dayPlan=buildDayPlan(bundledRules,plan.payload,'2026-11-12');const block=dayPlan.blocks.find(item=>item.skill==='speaking')!;
 const html=renderToStaticMarkup(createElement(MissionCard,{plan,dayPlan,block,userId:null,index:0}));
 assert.match(html,/开始口语/);assert.match(html,/#\/speaking\?task=d4-speaking&amp;date=2026-11-12&amp;day=4&amp;minutes=15/);assert.match(html,/外部完成后登记/);
});
