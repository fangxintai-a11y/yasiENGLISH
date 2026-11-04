import assert from 'node:assert/strict';
import test from 'node:test';
import { speakingRecordingLocation } from './speakingMedia';
const work=(fields:Record<string,unknown>={})=>({payload:{recordingId:'voice-a',recordingStatus:'local',recordingDevice:'设备 原设备',...fields}});
test('actual local bytes are playable regardless of the original device after ZIP import',()=>{
 const found=speakingRecordingLocation(work(),true,'设备 新设备');
 assert.equal(found.state,'local');assert.match(found.message,/这台设备/);assert.doesNotMatch(found.message,/上传/);
});
test('another device without bytes identifies the source device and ZIP transfer boundary',()=>{
 const missing=speakingRecordingLocation(work(),false,'设备 新设备');
 assert.equal(missing.state,'remote');assert.match(missing.message,/录音在另一台设备上（设备 原设备）/);assert.match(missing.message,/ZIP/);
});
test('cleared local data and old missing device metadata are never treated as uploaded audio',()=>{
 for(const value of [work(),work({recordingDevice:null})]){
  const missing=speakingRecordingLocation(value,false,'设备 原设备');assert.equal(missing.state,'missing');assert.match(missing.message,/未找到/);assert.doesNotMatch(missing.message,/已上传/);
 }
});
test('text-only work has no missing-remote claim, while an invalid local reference stays missing',()=>{
 assert.equal(speakingRecordingLocation(work({recordingId:null,recordingStatus:'none'}),false,'设备 新设备').state,'none');
 assert.equal(speakingRecordingLocation(work({recordingId:null}),false,'设备 新设备').state,'missing');
});
