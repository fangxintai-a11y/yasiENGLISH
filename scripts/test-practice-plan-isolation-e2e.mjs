#!/usr/bin/env node
/** Actual repository race checks in a fresh context; account identities are fixtures, not real logins. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const origin = process.env.BAND_PRACTICE_PLAN_E2E_ORIGIN || 'http://localhost:5188';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true });
const errors = [];
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/api/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Isolated test has no server account.' }) }));
  await context.addInitScript(() => localStorage.setItem('word-atlas:settings', JSON.stringify({ onboarded: true, splash: false, autoplay: false, sfx: false, ambience: 'off', dailyNew: 0 })));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  const evidence = await page.evaluate(async () => {
    const resource = path => performance.getEntriesByType('resource').map(entry => entry.name).find(url => new URL(url).origin === location.origin && new URL(url).pathname === path) || path;
    const repository = await import(resource('/src/study365/repository.ts'));
    const cloud = await import(resource('/src/store/cloudSync.ts'));
    const appStore = await import(resource('/src/store/store.ts'));
    const plans = await import(resource('/src/study365/planRecords.ts'));
    const data = await import(resource('/src/study365/planData.ts'));
    const db = await import(resource('/src/study365/db.ts'));
    const practice = await import(resource('/src/study365/usePracticePlan.ts'));
    repository.startLearningRecords();
    const wait = async check => {
      const end = Date.now() + 15000;
      while (!check()) { if (Date.now() > end) throw new Error('Isolated account state did not become ready'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    await wait(() => repository.getLearningState().ready);
    const payload = plans.createPlanPayload({ startDate: '2026-11-05', timeZone: 'Asia/Shanghai', rules: data.bundledRules });
    const mismatchId = 'isolated-mismatch-plan';
    const mismatch = await repository.saveRecord({ id: mismatchId, kind: 'plan', payload, baseRevision: null }, 'other-account')
      .then(() => null, error => error.message);
    const afterMismatch = await db.readScope('guest');
    if (!mismatch || afterMismatch.heads[mismatchId]) throw new Error('Expected-account precondition failed');

    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release, holding = true;
    crypto.subtle.digest = function (...args) {
      if (!holding) return originalDigest(...args);
      holding = false;
      return new Promise((resolve, reject) => { release = () => originalDigest(...args).then(resolve, reject); });
    };
    let race;
    const initialEpoch = repository.getLearningContextEpoch();
    try {
      const pending = repository.saveRecord({ id: 'isolated-racing-plan', kind: 'plan', payload, baseRevision: null }, null);
      await wait(() => !!release);
      // Simulate a synchronous identity notification without making any server account.
      cloud.getCloudState().user = { id: 'isolated-account-b', username: 'test' };
      appStore.store.settings({});
      await wait(() => repository.getLearningState().ready && repository.getLearningState().userId === 'isolated-account-b');
      cloud.getCloudState().user = null;
      appStore.store.settings({});
      await wait(() => repository.getLearningState().ready && repository.getLearningState().userId === null);
      release();
      race = await pending.then(() => null, error => error.message);
    } finally { crypto.subtle.digest = originalDigest; }
    const guest = await db.readScope('guest'), account = await db.readScope('account:isolated-account-b');
    if (!race || guest.heads['isolated-racing-plan'] || account.heads['isolated-racing-plan']) throw new Error('Race wrote a plan into an account');
    const requests = Array.from({ length: 4 }, () => practice.ensurePracticePlanToday(null));
    const shared = requests.every(request => request === requests[0]);
    await Promise.all(requests);
    const created = await db.readScope('guest');
    const planCount = Object.values(created.heads).filter(record => record.kind === 'plan' && !record.deleted).length;
    if (!shared || planCount !== 1 || created.outbox.length !== 1) throw new Error('Practice plan initialization was not idempotent');
    return { expectedAccountRejected: mismatch, raceRejected: race, initialEpoch, finalEpoch: repository.getLearningContextEpoch(),
      noCrossScopeWrites: true, strictModeSharedPromise: shared, planCount, outbox: created.outbox.length,
      fixtureBoundary: 'Fresh browser; server API blocked; user identities are explicit fixtures; actual repository/IDB/hash code runs.' };
  });
  assert.deepEqual(errors, []);
  assert.ok(evidence.finalEpoch > evidence.initialEpoch);
  console.log(JSON.stringify({ success: true, checks: 3, pageErrors: errors, evidence }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, pageErrors: errors, error: String(error) }, null, 2)); process.exitCode = 1;
} finally { await browser.close(); }
