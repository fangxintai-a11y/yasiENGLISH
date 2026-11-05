#!/usr/bin/env node
/** User-controlled daily and extra quantities; all settings/progress belong to isolated contexts. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const origin = process.env.BAND_VOCABULARY_E2E_ORIGIN || 'http://localhost:5188';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true, args: ['--mute-audio'] });
const errors = [], checks = [];
async function fresh(extraSettings = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(settings => {
    if (!localStorage.getItem('word-atlas:settings')) localStorage.setItem('word-atlas:settings', JSON.stringify({ onboarded: true, splash: false, autoplay: false, sfx: false, ambience: 'off', ...settings }));
  }, extraSettings);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  return { context, page };
}
async function savedDaily(page) { return page.evaluate(() => JSON.parse(localStorage.getItem('word-atlas:settings')).dailyNew); }
async function savedRound(page, count) {
  const deadline = Date.now() + 10000;
  do {
    assert.deepEqual(errors, []);
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem('word-atlas:v2:word-atlas-open') || '{}').session);
    if (session?.newIds.length === count) return session;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('The learning session did not finish saving');
}
async function width(page) {
  const value = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert.equal(value.content, value.width);
}
async function screenshot(page, name) {
  const file = path.resolve(`local-content/test-artifacts/${name}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, animations: 'disabled' });
}
try {
  const { context, page } = await fresh();
  assert.match(await page.locator('.journey h2').innerText(), /新词\s*20/);
  await page.goto(`${origin}/#/me`, { waitUntil: 'networkidle' });
  const daily = page.getByRole('spinbutton', { name: '每日新词数量', exact: true });
  await daily.fill('17'); await page.getByRole('button', { name: '保存数量', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await savedDaily(page), 17);
  await daily.scrollIntoViewIfNeeded();
  await screenshot(page, 'daily-vocabulary-count');
  for (const value of ['-1', '101', '1.5', '']) {
    await daily.fill(value); await page.getByRole('button', { name: '保存数量', exact: true }).click();
    await page.getByText('请输入0至100之间的整数；0表示只复习。', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await savedDaily(page), 17, `invalid ${value} must not overwrite the last valid choice`);
  }
  await daily.fill('0'); await daily.press('Enter');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await savedDaily(page), 0);
  assert.equal(await daily.inputValue(), '0');
  await width(page);
  checks.push('default20; daily custom17 persists; invalid values do not save; zero means reviews only');

  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  const extra = page.getByRole('spinbutton', { name: '本次加练新词数', exact: true });
  await extra.fill('27');
  await width(page);
  await screenshot(page, 'extra-vocabulary-count');
  await page.getByRole('button', { name: /再认识\s*27\s*个新词/ }).click();
  await page.getByRole('button', { name: '暂停并返回', exact: true }).waitFor();
  const round = await savedRound(page, 27);
  assert.equal(round.newIds.length, 27); assert.equal(new Set(round.newIds).size, 27);
  checks.push('custom extra27 actually starts27 distinct new words through the UI');
  await context.close();

  const second = await fresh({ dailyNew: 0 });
  const input = second.page.getByRole('spinbutton', { name: '本次加练新词数', exact: true });
  for (const value of ['0', '101', '1.5', '']) {
    await input.fill(value);
    assert.equal(await second.page.getByRole('button', { name: /再认识/ }).isDisabled(), true);
  }
  await second.page.getByRole('button', { name: '选择加练20个新词', exact: true }).click();
  assert.equal(await input.inputValue(), '20');
  await width(second.page);
  await second.page.getByRole('button', { name: /再认识\s*20\s*个新词/ }).click();
  await second.page.getByRole('button', { name: '暂停并返回', exact: true }).waitFor();
  const preset = await savedRound(second.page, 20);
  assert.equal(preset.newIds.length, 20);
  checks.push('invalid extra quantities cannot start; preset20 starts20 words; mobile pages fit390px');
  await second.context.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, checks, pageErrors: errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, pageErrors: errors, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally { await browser.close(); }
