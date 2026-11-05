#!/usr/bin/env node
/** Local-only, isolated guest contexts. All learner writes use the UI.
 * Self-authored fixtures test scheduling, not IELTS content quality or exam bands.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const origin = process.env.BAND_AUTO_PLAN_E2E_ORIGIN || 'http://localhost:5188';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const withHash = material => ({ ...material, contentHash: sha(canonical(material)) });
const recipe = JSON.parse(await fs.readFile(new URL('./fixtures/r4-e2e-materials.json', import.meta.url), 'utf8'));
const audioFiles = new Map();
function wav(seed) {
  const samples = 8000, result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
  for (let i=0;i<samples;i++) result.writeInt16LE(Math.round(100 * Math.sin(i * seed / 20)), 44+i*2);
  return result;
}
const materials = recipe.materials.map(original => {
  const item = structuredClone(original);
  if (item.skill === 'listening') {
    const bytes = wav(1); audioFiles.set('audio/r4-test.wav', bytes);
    item.audio = { ...item.audio, durationSeconds: 1, sha256: sha(bytes) };
    item.questions.forEach(q => { q.evidence.startSeconds = 0; q.evidence.endSeconds = 0.5; });
  }
  return withHash(item);
});
const fullReading = structuredClone(recipe.materials.find(m => m.skill === 'reading' && m.scope === 'section'));
Object.assign(fullReading, { id: 'auto-plan-reading-full', title: 'Self-authored full reading scheduling fixture', scope: 'full', pool: 'holdout', examId: 'fixture-full-reading' });
fullReading.paragraphs[0].text += ' This separate fictional paper is reserved for scheduling checks.';
fullReading.passage = fullReading.paragraphs.map(p=>p.text).join(' ');
fullReading.questions = Array.from({length:40}, (_,i) => ({ ...structuredClone(fullReading.questions[i % 4]), id:`auto-read-${i+1}`, number:i+1 }));
materials.push(withHash(fullReading));
for (let section=1;section<=4;section++) {
  const item = structuredClone(recipe.materials.find(m => m.skill === 'listening'));
  const bytes = wav(section+1), audioPath=`audio/auto-part-${section}.wav`;
  audioFiles.set(audioPath,bytes);
  Object.assign(item,{ id:`auto-plan-listening-part-${section}`, title:`Self-authored listening scheduling fixture Part ${section}`, examId:'fixture-full-listening', section, pool:'holdout',
    audio:{path:audioPath,durationSeconds:1,sha256:sha(bytes)} });
  item.transcript += ` Separate fictional section ${section} for scheduling checks.`;
  item.questions=Array.from({length:10},(_,i)=>{
    const q={...structuredClone(item.questions[i%2]),id:`auto-listen-${section}-${i+1}`,number:(section-1)*10+i+1};
    q.evidence.startSeconds=0; q.evidence.endSeconds=0.5; return q;
  });
  materials.push(withHash(item));
}

const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || chromium.executablePath(),headless:true,args:['--mute-audio']});
const checks=[],errors=[],evidence={};
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
await context.route('**/local-bank/**', route=>{
  const relative=new URL(route.request().url()).pathname.slice('/local-bank/'.length);
  if(relative==='manifest.json') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({materials:materials.map(m=>({id:m.id,version:m.version,contentHash:m.contentHash,path:`/local-bank/${m.skill}/${m.id}.json`}))})});
  const item=materials.find(m=>relative===`${m.skill}/${m.id}.json`);
  if(item)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(item)});
  if(relative==='prompts.json') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({importVersion:1,prompts:[]})});
  if(audioFiles.has(relative)) return route.fulfill({status:200,contentType:'audio/wav',body:audioFiles.get(relative)});
  return route.fulfill({status:404,body:'No real private materials used by this test'});
});
await context.addInitScript(()=>{if(!localStorage.getItem('word-atlas:settings'))localStorage.setItem('word-atlas:settings',JSON.stringify({onboarded:true,splash:false,autoplay:false,sfx:false,ambience:'off',dailyNew:0}));});
const page=await context.newPage();
page.on('pageerror',e=>errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-11-05T12:00:00+08:00'));
async function wait(fn,why){const end=Date.now()+45000;while(Date.now()<end){assert.deepEqual(errors,[]);if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error(why);}
async function heads(){return page.evaluate(()=>new Promise((resolve,reject)=>{
  const request=indexedDB.open('band-learning-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{
    const db=request.result,tx=db.transaction('scopes','readonly'),read=tx.objectStore('scopes').getAll();let values=[];
    read.onsuccess=()=>{values=read.result};tx.oncomplete=()=>{db.close();resolve(values.flatMap(v=>Object.values(v.heads??{})))};tx.onerror=()=>reject(tx.error);
  };
}));}
async function noOverflow(){const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.equal(size.scroll,size.width,JSON.stringify(size));return size;}
async function enter(skill){await page.goto(`${origin}/#/${skill}?mode=practice`,{waitUntil:'networkidle'});const bench=page.getByTestId('lr-workbench');await bench.waitFor();await wait(()=>bench.getByRole('button',{name:'开始限时首答',exact:true}).isEnabled(),'independent start must be available');assert.equal(await bench.getByLabel('练习材料',{exact:true}).isVisible(),false,'material picker is optional');await noOverflow();return bench;}
async function readAnswers(bench,values){const area=bench.getByRole('region',{name:'作答题目',exact:true});for(const [i,value]of values.entries()){const input=area.getByLabel(`第${i+1}题`,{exact:true});if(await input.evaluate(el=>el.tagName==='SELECT'))await input.selectOption(value);else await input.fill(value);}}

try{
  await page.goto(`${origin}/#/`,{waitUntil:'networkidle'});
  const setup=page.getByRole('region',{name:'开启 8.0 计划',exact:true});await setup.waitFor();
  assert.equal(await setup.getByLabel('开始日期',{exact:true}).inputValue(),'2026-11-05','today is default, not Monday');
  await setup.getByLabel('开始日期',{exact:true}).fill('2026-11-09');await setup.getByRole('button',{name:'开启 8.0 计划',exact:true}).click();
  await page.getByText('距计划开始倒数 4 天。',{exact:true}).waitFor();
  const original=(await heads()).find(r=>r.kind==='plan');assert.equal(original.payload.startDate,'2026-11-09');
  checks.push('any weekday defaults today; future setup saved through UI');

  const listen=await enter('listening');await listen.getByRole('button',{name:'开始限时首答',exact:true}).click();
  const audio=page.getByTestId('listening-audio');await audio.waitFor({state:'attached'});await wait(()=>audio.evaluate(a=>a.readyState>=1),'free listening metadata');
  await page.reload({waitUntil:'networkidle'});await page.getByRole('timer').first().waitFor();
  assert.match(await page.getByTestId('lr-workbench').innerText(),/已恢复本机未提交答案/);
  checks.push('before start: listening auto selects, starts and restores its original draft without manual selection');
  const reading=await enter('reading');await reading.getByRole('button',{name:'开始限时首答',exact:true}).click();
  await reading.getByRole('button',{name:'提交首答',exact:true}).click();
  await wait(async()=> (await heads()).some(r=>r.kind==='attempt'),'free reading saved');
  const free=(await heads()).find(r=>r.kind==='attempt');assert.equal(free.payload.date,'2026-11-05');assert.equal(free.payload.day,undefined);assert.equal(free.payload.taskId,'practice-reading-2026-11-05');assert.equal((await heads()).filter(r=>r.kind==='mission').length,0);
  checks.push('before start: reading saves a real date, no fabricated day and no course completion');

  await page.goto(`${origin}/#/`,{waitUntil:'networkidle'});await page.getByRole('button',{name:'从今天开始，自动安排',exact:true}).click();
  await page.getByRole('region',{name:'今天怎么学',exact:true}).waitFor();
  const current=(await heads()).find(r=>r.kind==='plan');assert.equal(current.id,original.id);assert.equal(current.payload.startDate,'2026-11-05');assert.notEqual(current.revisionId,original.revisionId);
  assert.ok((await heads()).some(r=>r.id===free.id),'free work retained');
  const first=page.getByRole('link',{name:'开始下一项任务',exact:true});await first.waitFor();assert.match(await first.getAttribute('href'),/listening\?.*task=/);
  await first.click();const course=page.getByTestId('lr-workbench');await course.getByRole('region',{name:'本节自动安排',exact:true}).waitFor();
  assert.equal(await course.getByLabel('练习材料',{exact:true}).isVisible(),false);assert.match(await course.innerText(),/独立检查/);
  await course.getByRole('button',{name:'开始限时首答',exact:true}).click();
  const sequenceAudio=page.getByTestId('listening-sequence-audio');await sequenceAudio.waitFor({state:'attached'});await wait(()=>sequenceAudio.evaluate(a=>a.readyState>=1),'assigned full sequence metadata');
  await noOverflow();checks.push('start today preserves ID/history/free work; next task auto opens the exact heldout full listening');

  await page.goto(`${origin}/#/`,{waitUntil:'networkidle'});
  const readLink=page.locator('[data-task-id]').filter({has:page.getByRole('link',{name:'开始本节阅读',exact:true})}).getByRole('link',{name:'开始本节阅读',exact:true});
  await readLink.click();const rb=page.getByTestId('lr-workbench');await rb.getByRole('region',{name:'本节自动安排',exact:true}).waitFor();
  assert.match(await rb.innerText(),/题型热身/);
  await rb.getByRole('button',{name:'开始限时首答',exact:true}).click();await page.getByRole('button',{name:'查看题目',exact:true}).click();
  await readAnswers(rb,['TRUE','record']);await rb.getByRole('button',{name:'提交首答',exact:true}).click();
  const review=page.getByTestId('lr-review');await review.waitFor();
  await review.getByRole('button',{name:'保存A轮，查看答案',exact:true}).click();await review.getByRole('button',{name:'完成B轮复盘',exact:true}).click();
  await review.getByRole('status').filter({hasText:'复盘已保存'}).waitFor();
  const next=rb.getByRole('link',{name:'继续本节下一份材料',exact:true});await next.waitFor();assert.match(await next.getAttribute('href'),/auto-plan-reading-full/);
  await next.click();await wait(()=>page.getByRole('button',{name:'开始限时首答',exact:true}).isEnabled(),'full reading follows drill');
  assert.match(await page.getByTestId('lr-workbench').innerText(),/Self-authored full reading scheduling fixture/);await noOverflow();
  checks.push('Day1 reading: official-type warmup A-B review leads directly to the scheduled full paper');

  await page.goto(`${origin}/#/`,{waitUntil:'networkidle'});await page.getByRole('button',{name:'选择加练20个新词',exact:true}).click();await page.getByRole('button',{name:/再认识\s*20\s*个新词/}).click();
  await page.getByRole('button',{name:'暂停并返回',exact:true}).waitFor();
  await wait(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('word-atlas:v2:word-atlas-open')||'{}').session?.newIds?.length===20),'optional vocabulary extra starts');
  checks.push('Day1 without a vocabulary course still permits a selected20-word extra batch');

  await page.clock.setFixedTime(new Date('2027-11-06T12:00:00+08:00'));
  for(const skill of ['reading','listening']){const b=await enter(skill);await b.getByRole('button',{name:'开始限时首答',exact:true}).click();if(skill==='reading'){await b.getByRole('button',{name:'提交首答',exact:true}).click();await wait(async()=>(await heads()).some(r=>r.payload.taskId==='practice-reading-2027-11-06'),'post-course free reading save');const last=(await heads()).find(r=>r.payload.taskId==='practice-reading-2027-11-06');assert.equal(last.payload.day,undefined);}}
  checks.push('after Day365: both subjects can still start, and reading saves without a fictional course day');
  await page.goto(`${origin}/#/reading`,{waitUntil:'networkidle'});
  await page.locator(`[data-attempt-id="${free.id}"]`).getByRole('link',{name:'查看作答',exact:true}).click();
  await page.getByRole('button',{name:'再来一份自动练习',exact:true}).click();
  const historyNext=page.getByTestId('lr-workbench');
  await historyNext.getByRole('button',{name:'开始限时首答',exact:true}).click();
  await historyNext.getByRole('button',{name:'提交首答',exact:true}).click();
  await wait(async()=>(await heads()).filter(r=>r.kind==='attempt'&&r.payload.taskId==='practice-reading-2027-11-06').length>=2,'new practice from history uses current date');
  assert.deepEqual((await heads()).find(r=>r.id===free.id),free);
  checks.push('viewing an older attempt then starting another practice saves today and preserves the old work');
  evidence.mobile=await noOverflow();assert.deepEqual(errors,[]);
  const screenshot=path.resolve('local-content/test-artifacts/auto-daily-plan-listening.png');await fs.mkdir(path.dirname(screenshot),{recursive:true});await page.screenshot({path:screenshot,animations:'disabled'});
  console.log(JSON.stringify({success:true,checks,pageErrors:errors,evidence,screenshot},null,2));
}catch(error){console.error(JSON.stringify({success:false,checks,pageErrors:errors,error:String(error)},null,2));console.error((await page.locator('body').innerText()).slice(-7000));process.exitCode=1;}finally{await browser.close();}
