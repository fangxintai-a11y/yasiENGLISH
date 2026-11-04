/** Isolated R2 IndexedDB migration and quota regression, run by storage E2E. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export async function verifyWritingDraftStorage(browser, origin) {
const fixture=JSON.parse(await readFile(new URL('../src/study365/fixtures/r0-records.json', import.meta.url),'utf8')).records[0];
 const context = await browser.newContext({ serviceWorkers: 'block' });
 let page = await context.newPage();
 try {
 await page.goto(origin+'/curriculum365/v1/inventory.json');
 const seeded=await page.evaluate(async fixture=>{
  const protocol=await import('/src/study365/protocol.ts'),r=fixture.request;
  const local={id:fixture.recordId,kind:r.kind,datasetId:r.payload.datasetId,planId:r.payload.planId,revisionId:r.revisionId,baseRevision:r.baseRevision,seq:0,payload:r.payload,contentHash:await protocol.hashPayload(r.kind,r.payload),createdAt:11,conflict:false,deleted:false,payloadVersion:2};
  const mutation={recordId:local.id,body:r,local,createdAt:11};const scope={heads:{[local.id]:local},revisions:{[local.revisionId]:local},outbox:[mutation],quarantine:[],cursor:17};
  const db=await new Promise((res,rej)=>{const q=indexedDB.open('band-learning-v1',2);q.onupgradeneeded=()=>{for(const n of ['scopes','recordings','recordingMetadata'])q.result.createObjectStore(n)};q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
  await new Promise((res,rej)=>{const t=db.transaction(['scopes','recordings','recordingMetadata'],'readwrite');t.objectStore('scopes').put(scope,'account:user-a');t.objectStore('recordings').put(new Blob([new Uint8Array([0,15,128,255])]),['account:user-a','audio-a']);t.oncomplete=res;t.onabort=rej});db.close();return JSON.stringify(scope);
 },fixture);
 const result=await page.evaluate(async()=>{
  const draft=await import('/src/study365/writingDrafts.ts');
  const value=draft.newWritingDraft({id:'draft-a',planId:'plan-a',taskType:'task1',prompt:'Describe the table.',date:'2026-11-15',text:'Original text',outline:'Overview and comparison',tableDescription:'A table of three towns.',timer:{elapsedSeconds:37,runningSince:1000,limitSeconds:1200,timed:true}});
  await draft.saveWritingDraft(draft.writingScope('user-a'),value);
  const other=await draft.loadWritingDraft(draft.writingScope('user-b'),value.id);
  const db=await new Promise((res,rej)=>{const q=indexedDB.open('band-learning-v1');q.onsuccess=()=>res(q.result);q.onerror=rej});
  const snapshot=await new Promise((res,rej)=>{const t=db.transaction(['scopes','recordings']);const s=t.objectStore('scopes').get('account:user-a'),b=t.objectStore('recordings').get(['account:user-a','audio-a']);t.oncomplete=()=>res({scope:JSON.stringify(s.result),blob:b.result,version:db.version});t.onabort=rej});db.close();
  return {version:snapshot.version,scope:snapshot.scope,audio:Array.from(new Uint8Array(await snapshot.blob.arrayBuffer())),other:other===undefined};
 });
 assert.equal(result.version,3);assert.equal(result.scope,seeded);assert.deepEqual(result.audio,[0,15,128,255]);assert.equal(result.other,true);
 await page.close();page=await context.newPage();await page.goto(origin+'/curriculum365/v1/inventory.json');
 const recovered=await page.evaluate(async()=>{const m=await import('/src/study365/writingDrafts.ts');return m.loadWritingDraft(m.writingScope('user-a'),'draft-a')});
 assert.equal(recovered.outline,'Overview and comparison');assert.equal(recovered.timer.elapsedSeconds,37);assert.equal(recovered.text,'Original text');assert.equal(recovered.tableDescription,'A table of three towns.');
 const failed=await page.evaluate(async()=>{const m=await import('/src/study365/writingDrafts.ts');const old=await m.loadWritingDraft(m.writingScope('user-a'),'draft-a');const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='writingDrafts')throw new DOMException('Synthetic quota failure','QuotaExceededError');return put.apply(this,args)};let message;try{await m.saveWritingDraft(m.writingScope('user-a'),{...old,text:'Unsaved edit'})}catch(e){message=e.message}finally{IDBObjectStore.prototype.put=put}return{message,old:(await m.loadWritingDraft(m.writingScope('user-a'),'draft-a')).text}});
 assert.match(failed.message,/未保存/);assert.equal(failed.old,'Original text');
 return ['R2 v2→v3 adds only user-scoped drafts while exact raw heads/history/outbox/cursor and audio bytes survive', 'R2 close/reopen restores body, outline, table description and timer; another account cannot read the draft', 'R2 quota failure reports 未保存 and retains the last saved text'];
 } finally { await context.close(); }
}
