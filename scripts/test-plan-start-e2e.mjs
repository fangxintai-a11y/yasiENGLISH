#!/usr/bin/env node
/** Focused regression against a running local app; uses an isolated guest browser only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.BAND_PLAN_START_E2E_ORIGIN || 'http://localhost:5188';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a local test app');
const errors = [], checks = [], evidence = {};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
async function visible(locator) {
  const deadline = Date.now() + 60000;
  do {
    assert.deepEqual(errors, [], 'Page must not crash while opening a learning entry');
    if (await locator.isVisible()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Expected visible content: ${locator}`);
}
async function width() {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(dimensions.content <= dimensions.viewport, `Page overflowed: ${JSON.stringify(dimensions)}`);
  return dimensions;
}
async function enter(skill) {
  await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
  await visible(page.getByRole('region', { name: '365天学习计划', exact: true }));
  await page.getByRole('link', { name: `${skill === 'listening' ? '听力' : '阅读'}与听读错题`, exact: true }).click();
  await visible(page.getByTestId('lr-workbench'));
  const select = page.getByLabel('练习材料', { exact: true });
  await visible(select);
  const deadline = Date.now() + 60000;
  while (!(await select.locator('option').count() > 1)) {
    assert.deepEqual(errors, []);
    assert.ok(Date.now() < deadline, 'Actual local bank must load');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const options = await select.locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })));
  const full = options.find(option => skill === 'listening' ? option.value.startsWith('sequence-') : option.value.includes('-reading-full@'));
  assert.ok(full, `Actual full ${skill} material must remain selectable`);
  await select.selectOption(full.value);
  return { full: full.value, width: await width(), button: page.getByRole('button', { name: '开始限时首答', exact: true }) };
}
try {
  await context.addInitScript(() => localStorage.setItem('word-atlas:settings', JSON.stringify({ onboarded: true, splash: false, autoplay: false, sfx: false, ambience: 'off', dailyNew: 0, feedbackMode: 'rules' })));
  await page.clock.setFixedTime(new Date('2026-11-05T12:00:00+08:00'));
  await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
  const setup = page.getByRole('region', { name: '开启 8.0 计划', exact: true });
  await visible(setup);
  await setup.getByLabel('开始日期', { exact: true }).fill('2026-11-09');
  await setup.getByRole('button', { name: '开启 8.0 计划', exact: true }).click();
  await visible(page.getByText('距计划开始倒数 4 天。', { exact: true }));
  for (const skill of ['listening', 'reading']) {
    const result = await enter(skill);
    assert.equal(await result.button.isDisabled(), true, 'Before-start browsing must not start a learning attempt');
    await visible(page.getByText(/计划.*尚未开始/));
    evidence[`before-${skill}`] = { full: result.full, width: result.width };
    checks.push(`future plan: ${skill} opens with real materials and a disabled start`);
  }
  await page.goto(`${origin}/#/review`, { waitUntil: 'domcontentloaded' });
  await visible(page.getByRole('region', { name: '订正任务', exact: true }));
  assert.deepEqual(errors, []);
  checks.push('future plan: correction queue remains accessible');

  await page.clock.setFixedTime(new Date('2026-11-09T12:00:00+08:00'));
  for (const skill of ['listening', 'reading']) {
    const result = await enter(skill);
    assert.equal(await result.button.isEnabled(), true, 'Day 1 must retain the normal start action');
    await result.button.click();
    await page.getByRole('button', { name: '查看题目', exact: true }).click();
    await visible(page.getByRole('region', { name: '作答题目', exact: true }));
    if (skill === 'listening') {
      const audio = page.getByTestId('listening-sequence-audio');
      await audio.waitFor({ state: 'attached' });
      const deadline = Date.now() + 60000;
      while (!(await audio.evaluate(audio => audio.readyState >= 1 && audio.duration > 0))) {
        assert.deepEqual(errors, []);
        assert.ok(Date.now() < deadline, 'First real listening section metadata must load');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    evidence[`day1-${skill}`] = { full: result.full, width: result.width };
    checks.push(`day1: ${skill} starts its real full material and displays the questions`);
  }
  await page.goto(`${origin}/#/listening`, { waitUntil: 'domcontentloaded' });
  await visible(page.getByTestId('lr-workbench'));
  const screenshot = path.resolve('local-content/test-artifacts/plan-start-listening.png');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ success: true, checks, pageErrors: errors, evidence, screenshot }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, pageErrors: errors, evidence, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally { await browser.close(); }
