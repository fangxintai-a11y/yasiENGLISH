import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const motionUrl = new URL('./motion.ts', import.meta.url).href;
function runMotion(method: 'transition' | 'morphFrom', rejected: 'ready' | 'updateCallbackDone' | 'finished' | null, reduced = false, supported = true) {
  const program = `
    import assert from 'node:assert/strict';
    globalThis.matchMedia = () => ({ matches: ${reduced} });
    const el = { style: { viewTransitionName: '' } };
    let calls = 0, starts = 0, observedName;
    const settled = name => name === ${JSON.stringify(rejected)}
      ? Promise.reject(new Error((name === 'ready' ? 'Transition was skipped: ' : 'Update callback failed: ') + name)) : Promise.resolve();
    globalThis.document = ${supported} ? { startViewTransition(callback) {
      starts++; observedName = el.style.viewTransitionName; callback();
      return { ready: settled('ready'), updateCallbackDone: settled('updateCallbackDone'), finished: settled('finished') };
    } } : {};
    const { transition, morphFrom } = await import(${JSON.stringify(motionUrl)});
    ${method === 'transition' ? 'transition(() => calls++);' : 'morphFrom(el, () => calls++);'}
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1, 'the DOM update must still run once');
    assert.equal(starts, ${supported && !reduced ? 1 : 0}, 'animation support/reduced-motion branches stay unchanged');
    assert.equal(el.style.viewTransitionName, '', 'temporary morph name must be removed');
    ${method === 'morphFrom' && supported && !reduced ? "assert.equal(observedName, 'word-art');" : ''}
  `;
  return spawnSync(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10000 });
}

for (const method of ['transition', 'morphFrom'] as const) {
  for (const rejected of ['ready', 'updateCallbackDone', 'finished'] as const) {
    test(`${method} handles a rejected ${rejected} promise without an unhandled rejection`, () => {
      const result = runMotion(method, rejected);
      assert.equal(result.status, 0, result.stderr);
    });
  }
  test(`${method} preserves a supported animation and updates exactly once`, () => {
    const result = runMotion(method, null);
    assert.equal(result.status, 0, result.stderr);
  });
  test(`${method} keeps reduced-motion and unsupported-browser updates synchronous`, () => {
    for (const [reduced, supported] of [[true, true], [false, false]] as const) {
      const result = runMotion(method, null, reduced, supported);
      assert.equal(result.status, 0, result.stderr);
    }
  });
}
