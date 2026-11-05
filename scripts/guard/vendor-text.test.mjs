import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanRepository } from './vendor-text.mjs';
const name = String.fromCharCode(67, 108, 97, 117, 100, 101);
const sdk = '@' + String.fromCharCode(97, 110, 116, 104, 114, 111, 112, 105, 99) + '-ai/sdk';
async function fixture(t, text, file = 'src/probe.ts') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'band-text-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
  return root;
}
test('vendor product token fails', async (t) => { assert.equal((await scanRepository(await fixture(t, name)))[0].rule, 'vendor'); });
test('vendor SDK identifier fails', async (t) => { assert.equal((await scanRepository(await fixture(t, sdk)))[0].rule, 'vendor'); });
test('whole natural vocabulary words pass', async (t) => { assert.deepEqual(await scanRepository(await fixture(t, 'claudere philanthropic misanthropic')), []); });
test('allowed words cannot hide a longer product identifier', async (t) => { assert.equal((await scanRepository(await fixture(t, 'claudere' + 'Product')))[0].rule, 'vendor'); });
test('conditional training slogan fails', async (t) => { assert.equal((await scanRepository(await fixture(t, '不接 ' + 'AI 也能练')))[0].rule, 'wording'); });
test('raw third party sources are excluded', async (t) => { assert.deepEqual(await scanRepository(await fixture(t, name, 'data/sources/raw.txt')), []); });
test('build output is checked after compilation', async (t) => { assert.equal((await scanRepository(await fixture(t, name, 'dist/assets/chunk.js'), { dist: true }))[0].rule, 'vendor'); });
for (const file of ['public/local-bank/reading/source.json', 'local-content/source.txt', 'dist/local-bank/listening/source.json']) {
  test(`private imported material is excluded at ${file}`, async (t) => {
    assert.deepEqual(await scanRepository(await fixture(t, name, file), { dist: true }), []);
  });
}
test('local material exclusion does not hide UI code, default materials or similarly named paths', async (t) => {
  const paths = ['src/local-bank/view.tsx', 'public/local-bank-ui.json', 'public/curriculum365/v1/samples.json', 'dist/assets/local-bank-controller.js'];
  const root = await fixture(t, name, paths[0]);
  for (const file of paths.slice(1)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), name); }
  assert.deepEqual((await scanRepository(root, { dist: true })).map(issue => issue.file), [...paths].sort());
});
test('the actual repository passes its text policy', async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  assert.deepEqual(await scanRepository(root), []);
});
