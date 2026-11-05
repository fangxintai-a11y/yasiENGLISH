#!/usr/bin/env node
/** Isolated layout regression. The keyboard is a simulated VisualViewport, not a real iPhone keyboard. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.BAND_TYPING_E2E_ORIGIN || 'http://localhost:5188';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const index = JSON.parse(await fs.readFile('public/atlas/index.json', 'utf8'));
const word = index.words.find(row => row[1] === 'accommodation');
assert.ok(word);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true, args: ['--mute-audio'] });
const evidence = [], errors = [];
try {
  for (const kind of ['dictation', 'spell', 'produce']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await context.addInitScript(({ id, kind }) => {
      localStorage.setItem('word-atlas:settings', JSON.stringify({ onboarded: true, splash: false, autoplay: false, sfx: false, ambience: 'off', dailyNew: 0 }));
      localStorage.setItem('word-atlas:v2:word-atlas-open', JSON.stringify({ version: 2, datasetId: 'word-atlas-open', cards: {}, skills: {}, session: { id: `layout-${kind}`, started: Date.now(), steps: [{ id, kind, track: kind === 'dictation' ? 'l' : kind === 'produce' ? 'p' : 'r' }], index: 0, graded: {}, newIds: [], reviewIds: [], skillKeys: [], ms: {}, practice: true, label: 'Isolated mobile layout fixture' } }));
      const viewport = new EventTarget();
      Object.assign(viewport, { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { value: viewport });
      window.__typingViewport = viewport;
    }, { id: word[0], kind });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${kind}: ${error.message}`));
    await page.goto(`${origin}/#/learn`, { waitUntil: 'domcontentloaded' });
    const input = kind === 'dictation' ? page.getByLabel('听写', { exact: true }) : page.getByLabel(/^拼写，/);
    await input.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await input.fill('ac');
    const target = kind === 'dictation' ? page.locator('.dictation-field') : page.locator('.slots');
    const initial = await target.boundingBox();
    await page.evaluate(() => { window.__typingViewport.height = 420; window.__typingViewport.dispatchEvent(new Event('resize')); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const keyboard = await target.boundingBox();
    const value = await input.inputValue();
    const visibleTyped = kind === 'dictation' ? value : (await page.locator('.slot.is-filled').allTextContents()).join('');
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    const shot = path.resolve(`local-content/test-artifacts/mobile-typing-${kind}.png`);
    await fs.mkdir(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
    await input.blur();
    await page.evaluate(() => { window.__typingViewport.height = 844; window.__typingViewport.dispatchEvent(new Event('resize')); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const refocused = await input.evaluate(input => document.activeElement === input);
    evidence.push({ kind, initial, simulatedKeyboard: keyboard, value, visibleTyped, dimensions, refocused, screenshot: shot });
    await context.close();
  }
  console.log(JSON.stringify({ pageErrors: errors, evidence }, null, 2));
  assert.deepEqual(errors, []);
  for (const row of evidence) {
    assert.ok(row.initial.y < 460, `${row.kind}: input should be in the upper page, got ${row.initial.y}`);
    assert.ok(row.simulatedKeyboard.y >= 48 && row.simulatedKeyboard.y + row.simulatedKeyboard.height <= 404, `${row.kind}: typed content is covered by the simulated keyboard`);
    assert.equal(row.visibleTyped, 'ac', `${row.kind}: the visible typed letters must be retained`);
    assert.equal(row.refocused, false, `${row.kind}: viewport changes must not steal focus`);
    assert.equal(row.dimensions.scroll, row.dimensions.width);
  }
  console.log(JSON.stringify({ success: true, checks: 3, viewport: '390x844 with simulated visualViewport height420; not a real device keyboard' }));
} finally { await browser.close(); }
