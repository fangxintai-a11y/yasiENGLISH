import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, emptyProgress } from "./store";
import { mergeSnapshots, type SyncSnapshot } from "./syncMerge";
import { CloudError, CloudSyncEngine, sameSnapshot, type CloudPort, type CloudState, type CloudUser, type SyncMeta } from "./cloudSyncEngine";

const clone = <T>(v: T): T => structuredClone(v);
const user: CloudUser = { id: "11111111111111111111111111111111", username: "learner" };
const snapshot = (): SyncSnapshot => ({ progress: emptyProgress("word-atlas-open"), settings: { ...defaultSettings } });
const day = (r: number) => ({ n: r, r, c: r, t: r * 10 });
const card = (at: number) => ({ due: at + 100, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2 as const, last: at, seen: at });

class FakeServer {
  revision = 0;
  snapshot: SyncSnapshot | null = null;
  receipts = new Set<string>();
  authorized = true;
  conflicts = 0;
  puts = 0;

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (path === "/api/auth/session") return { user: this.authorized ? clone(user) : null };
    if (!this.authorized) throw new CloudError("请先登录。", 401);
    if (method === "POST") return { user: clone(user) };
    const url = new URL(path, "http://example.test");
    if (method === "GET") return clone({ revision: this.revision, snapshot: this.snapshot, applied: this.receipts.has(url.searchParams.get("commitId") ?? "") });
    const payload = body as { revision: number; snapshot: SyncSnapshot; commitId: string };
    this.puts++;
    if (this.receipts.has(payload.commitId)) return clone({ revision: this.revision, snapshot: this.snapshot, applied: true });
    if (payload.revision !== this.revision) {
      this.conflicts++;
      throw new CloudError("版本冲突。", 409);
    }
    this.snapshot = clone(payload.snapshot);
    this.revision++;
    this.receipts.add(payload.commitId);
    return clone({ revision: this.revision, snapshot: this.snapshot, applied: true });
  }
}

class FakeDevice implements CloudPort {
  local: SyncSnapshot | null = snapshot();
  metadata = new Map<string, SyncMeta>();
  states: CloudState[] = [];
  requests: { method: string; path: string; body?: unknown }[] = [];
  remembered: CloudUser | null = null;
  beforeRequest?: (method: string, path: string, body: unknown) => Promise<void> | void;
  afterRequest?: (method: string, path: string, result: unknown) => Promise<void> | void;
  afterSave?: (meta: SyncMeta, count: number) => Promise<void> | void;
  failSaveAt = 0;
  saves = 0;
  failApplyAt = 0;
  applies = 0;
  localStamp: string | null = null;
  private id = 0;
  readonly engine: CloudSyncEngine;

  constructor(readonly server: FakeServer, readonly name: string) {
    this.engine = new CloudSyncEngine(this);
    this.engine.restoreUser(clone(user));
  }
  async request(method: string, path: string, body?: unknown) {
    this.requests.push({ method, path, body: clone(body) });
    await this.beforeRequest?.(method, path, body);
    const result = await this.server.request(method, path, body);
    await this.afterRequest?.(method, path, result);
    return result;
  }
  snapshot() { return clone(this.local); }
  appliedStamp() { return this.localStamp; }
  apply(value: SyncSnapshot, stamp?: string) {
    this.applies++;
    if (this.applies === this.failApplyAt) throw new Error("local progress write failed");
    this.local = clone(value);
    if (stamp) this.localStamp = stamp;
  }
  load(who: CloudUser, dataset: string) { return clone(this.metadata.get(`${who.id}:${dataset}`) ?? { base: null }); }
  async save(who: CloudUser, dataset: string, meta: SyncMeta) {
    this.saves++;
    if (this.saves === this.failSaveAt) throw new Error("metadata storage failed");
    this.metadata.set(`${who.id}:${dataset}`, clone(meta));
    await this.afterSave?.(clone(meta), this.saves);
  }
  remember(who: CloudUser | null) { this.remembered = clone(who); }
  decode(value: unknown, dataset: string) {
    if (value === null) return null;
    const snap = clone(value as SyncSnapshot);
    if (snap.progress.datasetId !== dataset) throw new CloudError("词库不匹配。", 400);
    return snap;
  }
  uuid() { return `${this.name}-${++this.id}`; }
  changed(state: CloudState) { this.states.push(clone(state)); }
  seed(base: SyncSnapshot) {
    this.local = clone(base);
    this.metadata.set(`${user.id}:${base.progress.datasetId}`, { base: clone(base) });
  }
  study(id: string, at: number) {
    const p = this.local!.progress;
    p.cards[id] = card(at);
    p.days["2026-11-02"] = day((p.days["2026-11-02"]?.r ?? 0) + 1);
    this.engine.markChanged();
  }
}

test("two offline devices resolve a real CAS conflict and converge without losing reviews", async () => {
  const server = new FakeServer();
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  server.snapshot = clone(base);
  server.revision = 1;
  const phone = new FakeDevice(server, "phone");
  const desktop = new FakeDevice(server, "desktop");
  phone.seed(base);
  desktop.seed(base);
  phone.study("phone-word", 20);
  desktop.study("desktop-word", 30);
  await Promise.all([phone.engine.sync(), desktop.engine.sync()]);
  await Promise.all([phone.engine.sync(), desktop.engine.sync()]);
  assert.ok(server.conflicts >= 1, "the fake API exercised its 409 path");
  assert.deepEqual(Object.keys(server.snapshot!.progress.cards).sort(), ["desktop-word", "phone-word"]);
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 12);
  assert.deepEqual(phone.local, server.snapshot);
  assert.deepEqual(desktop.local, server.snapshot);
  assert.equal(phone.engine.state.status, "synced");
  assert.equal(desktop.engine.state.pending, false);
});

test("answers entered during an upload are included in the next commit", async () => {
  const server = new FakeServer();
  const base = snapshot();
  server.snapshot = clone(base);
  server.revision = 1;
  const device = new FakeDevice(server, "phone");
  device.seed(base);
  device.study("before-send", 20);
  let entered = false;
  device.beforeRequest = (method) => {
    if (method === "PUT" && !entered) {
      entered = true;
      device.study("during-upload", 30);
    }
  };
  await device.engine.sync();
  assert.equal(server.puts, 2);
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 2);
  assert.deepEqual(Object.keys(server.snapshot!.progress.cards).sort(), ["before-send", "during-upload"]);
  assert.deepEqual(device.local, server.snapshot);
});

test("answers entered during asynchronous journal and checkpoint writes are preserved", async () => {
  const server = new FakeServer();
  const base = snapshot();
  server.snapshot = clone(base);
  server.revision = 1;
  const device = new FakeDevice(server, "phone");
  device.seed(base);
  device.study("before-send", 20);
  device.afterSave = async (_meta, count) => {
    await Promise.resolve();
    if (count === 1) device.study("during-pending-write", 30);
    if (count === 2) device.study("during-application-write", 40);
    if (count === 3) device.study("during-cleanup-write", 50);
  };
  await device.engine.sync();
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 4);
  assert.equal(Object.keys(server.snapshot!.progress.cards).length, 4);
  assert.deepEqual(device.local, server.snapshot);
  assert.equal(device.engine.state.pending, false);
});

test("a lost PUT response followed by another device's commit recovers from its durable receipt", async () => {
  const server = new FakeServer();
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  server.snapshot = clone(base);
  server.revision = 1;
  const phone = new FakeDevice(server, "phone");
  phone.seed(base);
  phone.study("phone-offline", 20);
  let lost = false;
  phone.afterRequest = (method) => {
    if (method === "PUT" && !lost) {
      lost = true;
      throw new Error("response lost after server commit");
    }
  };
  await phone.engine.sync();
  assert.equal(phone.engine.state.status, "offline");
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 11);
  assert.ok(phone.load(user, "word-atlas-open").pending);

  const desktop = new FakeDevice(server, "desktop");
  desktop.seed(server.snapshot!);
  desktop.study("desktop-new", 30);
  await desktop.engine.sync();
  phone.study("phone-continued", 40);
  await phone.engine.sync();
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 13);
  assert.deepEqual(Object.keys(server.snapshot!.progress.cards).sort(), ["desktop-new", "phone-continued", "phone-offline"]);
  assert.equal(phone.load(user, "word-atlas-open").pending, undefined);
  assert.deepEqual(phone.local, server.snapshot);
});

test("a negative receipt lookup cannot retire an original request that commits late", async () => {
  const server = new FakeServer();
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  server.snapshot = clone(base);
  server.revision = 1;
  const phone = new FakeDevice(server, "phone");
  const desktop = new FakeDevice(server, "desktop");
  phone.seed(base);
  desktop.seed(base);
  desktop.study("desktop-word", 30);
  await desktop.engine.sync();
  phone.study("phone-word", 20);
  let delayedBody: unknown;
  phone.beforeRequest = (method, _path, body) => {
    if (method === "PUT" && delayedBody === undefined) {
      delayedBody = clone(body);
      throw new Error("HTTP timeout while the original request remains queued on the server");
    }
  };
  await phone.engine.sync();
  assert.equal(phone.engine.state.status, "offline");
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 11);
  phone.beforeRequest = undefined;
  let committedLate = false;
  phone.afterRequest = async (method, path) => {
    if (method === "GET" && path.includes("?commitId=") && !committedLate) {
      committedLate = true;
      // The lookup already returned applied:false. The first request commits before
      // that stale negative answer reaches the client.
      await server.request("PUT", "/api/sync/word-atlas-open", delayedBody);
    }
  };
  await phone.engine.sync();
  assert.ok(committedLate);
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 12);
  assert.deepEqual(Object.keys(server.snapshot!.progress.cards).sort(), ["desktop-word", "phone-word"]);
  assert.deepEqual(phone.local, server.snapshot);
  const attempts = phone.requests.filter((request) => request.method === "PUT").map((request) => request.body as { commitId: string; revision: number });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].commitId, attempts[0].commitId, "a retry retains the original idempotency key");
  assert.equal(attempts[1].revision, attempts[0].revision, "a retry retains the original CAS revision");
});

test("an expired login retains local answers and reports reauthentication", async () => {
  const server = new FakeServer();
  const device = new FakeDevice(server, "phone");
  device.study("local-only", 20);
  const before = clone(device.local);
  server.authorized = false;
  await device.engine.sync();
  assert.equal(device.engine.state.status, "auth");
  assert.equal(device.engine.state.user, null);
  assert.equal(device.engine.state.pending, true);
  assert.deepEqual(device.local, before);
  assert.equal(server.puts, 0);
});

test("a failed metadata write prevents any PUT before a durable journal exists", async () => {
  const server = new FakeServer();
  const device = new FakeDevice(server, "phone");
  device.study("local-only", 20);
  device.failSaveAt = 1;
  await device.engine.sync();
  assert.equal(server.puts, 0);
  assert.equal(device.engine.state.pending, true);
  assert.equal(device.local!.progress.cards["local-only"].last, 20);
  device.failSaveAt = 0;
  await device.engine.sync();
  assert.equal(server.puts, 1);
  assert.deepEqual(device.local, server.snapshot);
});

test("switching datasets while GET is in flight does not apply the old dataset or send a PUT", async () => {
  const server = new FakeServer();
  server.snapshot = snapshot();
  const device = new FakeDevice(server, "phone");
  device.study("old-dataset", 20);
  device.afterRequest = (method) => {
    if (method === "GET") {
      device.local = snapshot();
      device.local.progress.datasetId = "another-dataset";
    }
  };
  await device.engine.sync();
  assert.equal(device.local!.progress.datasetId, "another-dataset");
  assert.equal(server.puts, 0);
  assert.equal(device.load(user, "word-atlas-open").base, null);
});

test("a failed metadata checkpoint after applying a receipt must not count the receipt twice", async () => {
  const server = new FakeServer();
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  const localAtSend = clone(base);
  localAtSend.progress.cards.phone = card(20);
  localAtSend.progress.days["2026-11-02"] = day(11);
  const remoteAtSend = clone(base);
  remoteAtSend.progress.cards.desktop = card(30);
  remoteAtSend.progress.days["2026-11-02"] = day(12);
  const accepted = mergeSnapshots(base, localAtSend, remoteAtSend);
  server.snapshot = clone(accepted);
  server.revision = 2;
  server.receipts.add("lost-commit");
  const device = new FakeDevice(server, "phone");
  device.local = clone(localAtSend);
  device.metadata.set(`${user.id}:word-atlas-open`, {
    base: clone(base), pending: { commitId: "lost-commit", revision: 1, snapshot: accepted, localAtSend },
  });
  device.failSaveAt = 1;
  await device.engine.sync();
  device.failSaveAt = 0;
  await device.engine.sync();
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 13);
  assert.equal(device.local!.progress.days["2026-11-02"].r, 13);
});

test("a failed journal cleanup after local apply is recovered using the atomic applied stamp", async () => {
  const server = new FakeServer();
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  const localAtSend = clone(base);
  localAtSend.progress.cards.phone = card(20);
  localAtSend.progress.days["2026-11-02"] = day(11);
  const remoteAtSend = clone(base);
  remoteAtSend.progress.cards.desktop = card(30);
  remoteAtSend.progress.days["2026-11-02"] = day(12);
  const accepted = mergeSnapshots(base, localAtSend, remoteAtSend);
  server.snapshot = clone(accepted);
  server.revision = 2;
  server.receipts.add("lost-commit");
  const device = new FakeDevice(server, "phone");
  device.local = clone(localAtSend);
  device.metadata.set(`${user.id}:word-atlas-open`, {
    base: clone(base), pending: { commitId: "lost-commit", revision: 1, snapshot: accepted, localAtSend },
  });
  device.failSaveAt = 2;
  await device.engine.sync();
  assert.equal(device.local!.progress.days["2026-11-02"].r, 13);
  assert.ok(device.localStamp, "the applied stamp was atomically saved with progress");
  device.study("after-checkpoint-failure", 40);
  device.failSaveAt = 0;
  await device.engine.sync();
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 14);
  assert.equal(device.local!.progress.days["2026-11-02"].r, 14);
});

test("a failed local apply after a committed PUT recovers its durable application journal", async () => {
  const server = new FakeServer();
  const base = snapshot();
  base.progress.days["2026-11-02"] = day(10);
  server.snapshot = clone(base);
  server.revision = 1;
  const device = new FakeDevice(server, "phone");
  device.seed(base);
  device.study("before-upload", 20);
  device.failApplyAt = 1;
  await device.engine.sync();
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 11);
  device.study("after-apply-failure", 30);
  device.failApplyAt = 0;
  await device.engine.sync();
  assert.equal(server.snapshot!.progress.days["2026-11-02"].r, 12);
  assert.equal(device.local!.progress.days["2026-11-02"].r, 12);
  assert.deepEqual(Object.keys(server.snapshot!.progress.cards).sort(), ["after-apply-failure", "before-upload"]);
});

test("canonical snapshot equality ignores map insertion order", () => {
  assert.equal(sameSnapshot({ cards: { a: card(10), b: card(20) } }, { cards: { b: card(20), a: card(10) } }), true);
});
