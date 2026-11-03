import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ContentCatalogSchema } from '../../src/study365/contentSchemas.ts';
import { mp3Info } from './validate-content.mjs';
const catalog = JSON.parse(await readFile(new URL('../../public/curriculum365/v1/samples.json', import.meta.url), 'utf8'));
const audio = await readFile(new URL('../../public/curriculum365/v1/audio/listening-sample-01.mp3', import.meta.url));
const provenance = JSON.parse(await readFile(new URL('../../public/curriculum365/v1/audio/provenance.json', import.meta.url), 'utf8'));
test('the checked-in listening sample uses compressed audio', () => {
  assert.match(catalog.materials.find((item) => item.skill === 'listening').audio.path, /\.mp3$/);
});
test('Node frame parser recognizes mono 24k MPEG-2 Layer III speech', () => {
  const info = mp3Info(audio, provenance.durationSeconds);
  assert.equal(info.rate, 24000); assert.equal(info.channels, 1); assert.equal(info.bitrateKbps, 48);
  assert.ok(info.signalFrames > 100); assert.ok(info.durationSeconds > 270);
});
test('compressed audio over 3 MB is rejected', () => { assert.throws(() => mp3Info(Buffer.alloc(3 * 1024 * 1024 + 1)), /3 MB/); });
test('a duration difference of 0.1 seconds is rejected', () => {
  const { durationSeconds } = mp3Info(audio);
  assert.throws(() => mp3Info(audio, durationSeconds + 0.10001), /0.1秒/);
});
test('truncated encoded audio is rejected', () => { assert.throws(() => mp3Info(audio.subarray(0, audio.length - 20)), /帧不完整/); });
test('zero sample placeholder is rejected', () => { assert.throws(() => mp3Info(Buffer.alloc(144)), /MPEG/); });
test('a PCM resource path is not accepted for the published sample', () => {
  const value = structuredClone(catalog);
  value.materials.find((item) => item.skill === 'listening').audio.path = 'audio/listening-sample-01' + '.wav';
  const result = ContentCatalogSchema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'materials.0.audio.path'));
});
