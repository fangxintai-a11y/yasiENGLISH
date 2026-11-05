import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const origin = 'https://r6-offline.test';
const privatePaths = ['/api/auth/session', '/private/manifest.json', '/private/audio/test.m4a', '/login', '/local-bank/manifest.json', '/local-bank/audio/test.mp3', '/local/catalog.json', '/local/media/image/1'];
function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const initial = ['/', '/assets/self-authored-fixture.js', '/atlas/audio/word-us/1.mp3', ...privatePaths];
  const stores = new Map<string, Set<string>>([
    ['band-v5-shell', new Set(initial.map(path => origin + path))],
    ['band-pack-fixture', new Set(initial.map(path => origin + path))],
  ]);
  let intercepted = 0;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async () => undefined,
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Set());
      const entries = stores.get(name)!;
      return { keys: async () => [...entries].map(url => new Request(url)), delete: async (request: Request) => entries.delete(request.url) };
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler), clients: { claim: async () => undefined }, skipWaiting: () => undefined, registration: { scope: origin + '/' } },
    caches, URL, Request, Response, location: { origin }, fetch: async () => new Response('Self-authored network fixture'),
  });
  return { handlers, stores, intercept: () => intercepted++, intercepted: () => intercepted };
}
test('R6: activating the real worker preserves the existing shell cache and removes private responses from every retained cache', async () => {
  const w = worker();
  let pending: Promise<unknown> = Promise.resolve();
  w.handlers.get('activate')!({ waitUntil(value: Promise<unknown>) { pending = value; } });
  await pending;
  assert.ok(w.stores.has('band-v5-shell'), 'existing production shell contract remains available offline');
  for (const entries of w.stores.values()) {
    assert.ok(entries.has(origin + '/atlas/audio/word-us/1.mp3'));
    for (const path of privatePaths) assert.equal(entries.has(origin + path), false, path);
  }
});
test('R6: private and legacy local-material requests bypass the actual worker cache interception', () => {
  const w = worker();
  for (const path of [...privatePaths, '/private', '/local-bank', '/local']) {
    w.handlers.get('fetch')!({ request: new Request(origin + path), respondWith: () => w.intercept(), waitUntil: () => undefined });
  }
  assert.equal(w.intercepted(), 0, 'all sensitive requests must reach the authenticated network, never a global cache');
});
