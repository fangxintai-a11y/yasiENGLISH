import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LearningApiError } from "./api";
import { canonical, emptyScope, validatePayload, type LearningKind, type LearningPayload, type LearningScope, type QueuedMutation, type Revision, type SyncStatus, type WriteRequest } from "./protocol";
import { LearningSyncEngine, type LearningSyncPort } from "./syncEngine";

const clone = <T>(value: T): T => structuredClone(value);
const USER = "learner-one";
const DATASET = "word-atlas-open";
let identifier = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++identifier).padStart(12, "0")}`;
const fingerprint = (kind: LearningKind, payload: LearningPayload) => createHash("sha256").update(kind === "essay" ? String(payload.text ?? "") : kind === "speaking" ? String(payload.transcript ?? "") : canonical(payload)).digest("hex");
function queued(id: string, text: string, baseRevision: string | null = null): QueuedMutation {
  const payload = { datasetId: DATASET, planId: "plan-one", taskType: "task2", text };
  const revisionId = uuid();
  const local: Revision = { id, kind: "essay", datasetId: DATASET, planId: "plan-one", payloadVersion: 2, revisionId, baseRevision, seq: 0, payload, contentHash: fingerprint("essay", payload), createdAt: Date.now(), conflict: false, deleted: false };
  return { recordId: id, local, body: { schemaVersion: 2, revisionId, mutationId: uuid(), baseRevision, kind: "essay", payload }, createdAt: Date.now() };
}
function remote(id: string, text: string, seq: number, options: Partial<Revision> = {}): Revision {
  const q = queued(id, text);
  const result = { ...q.local, seq, ...options };
  if (!options.payload && options.datasetId) result.payload = { ...result.payload, datasetId: options.datasetId };
  return result;
}

class Server {
  userId: string | null = USER;
  available = true;
  writable = true;
  pageSize = 100;
  revisions: Revision[] = [];
  heads = new Map<string, Revision>();
  receipts = new Map<string, { request: string; status: number; body: unknown }>();
  puts = 0;
  hash = fingerprint;

  seed(...items: Revision[]) {
    for (const item of items) {
      this.revisions.push(clone(item));
      if (!item.conflict) this.heads.set(item.id, clone(item));
    }
    this.revisions.sort((a, b) => a.seq - b.seq);
  }

  async request(method: string, path: string, value?: unknown): Promise<unknown> {
    if (path === "/api/auth/session") return { user: this.userId ? { id: this.userId, username: "learner" } : null };
    if (path === "/api/capabilities") {
      if (!this.available) throw new LearningApiError(404, "旧版服务没有此能力。", "not_found");
      return { vocabSnapshot: 2, learningRecords: 2, learningWriteEnabled: this.writable };
    }
    if (!this.userId) throw new LearningApiError(401, "请先登录。");
    if (!this.available) throw new LearningApiError(404, "学习接口不存在。", "not_found");
    const url = new URL(path, "https://example.test");
    if (method === "GET") {
      const after = Number(url.searchParams.get("after"));
      const left = this.revisions.filter((r) => r.seq > after);
      const items = clone(left.slice(0, this.pageSize));
      return { items, nextCursor: items.at(-1)?.seq ?? after, hasMore: items.length < left.length };
    }
    assert.equal(method, "PUT");
    if (!this.writable) throw new LearningApiError(503, "学习暂时只读。", "learning_write_disabled");
    const body = value as WriteRequest;
    this.puts++;
    const id = decodeURIComponent(path.split("/").at(-1)!);
    const receipt = this.receipts.get(body.mutationId);
    const request = canonical({ id, body });
    if (receipt) {
      assert.equal(receipt.request, request, "a retry must keep the entire original request");
      if (receipt.status === 409) throw new LearningApiError(409, "两份均已保存。", "revision_conflict", clone(receipt.body));
      return clone(receipt.body);
    }
    validatePayload(body.kind, body.payload, body.deleted);
    const head = this.heads.get(id) ?? null;
    const conflict = (head?.revisionId ?? null) !== body.baseRevision;
    const item: Revision = { id, kind: body.kind, datasetId: body.deleted ? head?.datasetId ?? null : typeof body.payload.datasetId === "string" ? body.payload.datasetId : null,
      planId: body.deleted ? head?.planId ?? null : String(body.payload.planId), payloadVersion: 2, revisionId: body.revisionId, baseRevision: body.baseRevision,
      seq: (this.revisions.at(-1)?.seq ?? 0) + 1, payload: clone(body.payload), contentHash: this.hash(body.kind, body.payload), createdAt: Date.now(), conflict, deleted: !!body.deleted };
    this.revisions.push(item);
    if (!conflict) this.heads.set(id, item);
    const result = conflict ? { record: clone(head), conflict: clone(item), applied: false } : { record: clone(item), applied: true };
    this.receipts.set(body.mutationId, { request, status: conflict ? 409 : 200, body: clone(result) });
    if (conflict) throw new LearningApiError(409, "两份均已保存。", "revision_conflict", result);
    return result;
  }
}

class Device implements LearningSyncPort {
  userId: string | null = USER;
  datasetId = DATASET;
  scope = emptyScope();
  alive = true;
  clock = 0;
  states: { syncStatus: SyncStatus; error?: string | null }[] = [];
  requests: { method: string; path: string; body: unknown }[] = [];
  beforeRequest?: (method: string, path: string, body: unknown) => void | Promise<void>;
  afterRequest?: (method: string, path: string, result: unknown) => void | Promise<void>;
  failUpdateOnce = false;
  readonly engine = new LearningSyncEngine(this);
  constructor(readonly server: Server) {}
  active() { return this.alive; }
  now() { return this.clock; }
  changed(state: { syncStatus: SyncStatus; error?: string | null }) { this.states.push(clone(state)); }
  async read() { return clone(this.scope); }
  async update(change: (scope: LearningScope) => LearningScope) {
    if (this.failUpdateOnce) { this.failUpdateOnce = false; throw new Error("IndexedDB transaction aborted"); }
    this.scope = clone(change(clone(this.scope)));
    return clone(this.scope);
  }
  async request(method: string, path: string, body?: unknown) {
    this.requests.push({ method, path, body: clone(body) });
    await this.beforeRequest?.(method, path, body);
    // learningRequest sends X-Learning-User; a switched Cookie must not change the owner.
    if (path.startsWith("/api/learning/") && this.server.userId !== this.userId)
      throw new LearningApiError(403, "账号已变更。", "account_changed");
    const result = await this.server.request(method, path, body);
    await this.afterRequest?.(method, path, result);
    return result;
  }
  edit(mutation: QueuedMutation) {
    this.scope.heads[mutation.recordId] = clone(mutation.local);
    this.scope.revisions[mutation.local.revisionId] = clone(mutation.local);
    this.scope.outbox.push(clone(mutation));
  }
  get status() { return this.states.at(-1)?.syncStatus; }
}

test("a lost success response retries exactly once without duplicate revisions or IDs", async () => {
  const server = new Server();
  const device = new Device(server);
  const edit = queued("essay-one", "My first draft.");
  device.edit(edit);
  let lose = true;
  device.afterRequest = (method) => { if (method === "PUT" && lose) { lose = false; throw new TypeError("response lost"); } };
  await device.engine.sync();
  assert.equal(server.revisions.length, 1);
  assert.equal(device.scope.outbox.length, 1);
  assert.equal(device.status, "offline");
  assert.deepEqual(device.scope.outbox[0].body, edit.body);
  await device.engine.sync();
  assert.equal(server.revisions.length, 1);
  assert.equal(server.puts, 2);
  assert.equal(device.scope.outbox.length, 0);
  assert.equal(device.scope.heads[edit.recordId].revisionId, edit.body.revisionId);
  assert.equal(device.scope.heads[edit.recordId].seq, 1);
  assert.equal(device.status, "synced");
});

test("two offline editors preserve the rejected draft as a durable conflict copy", async () => {
  const server = new Server();
  const initial = remote("essay-one", "Original.", 1);
  server.seed(initial);
  const phone = new Device(server), desktop = new Device(server);
  await phone.engine.sync(); await desktop.engine.sync();
  const a = queued(initial.id, "Changed first paragraph on phone.", initial.revisionId);
  const b = queued(initial.id, "Changed last paragraph on desktop.", initial.revisionId);
  phone.edit(a); desktop.edit(b);
  await phone.engine.sync();
  await desktop.engine.sync();
  assert.equal(desktop.scope.outbox.length, 0);
  assert.equal(desktop.scope.heads[initial.id].revisionId, a.local.revisionId);
  assert.equal(desktop.scope.revisions[b.local.revisionId].conflict, true);
  assert.equal(desktop.scope.revisions[b.local.revisionId].payload.text, b.local.payload.text);
  assert.equal(server.revisions.length, 3);
  await phone.engine.sync();
  assert.equal(phone.scope.revisions[b.local.revisionId].conflict, true);
});

test("pagination resumes after only the page committed to local storage", async () => {
  const server = new Server(); server.pageSize = 1;
  server.seed(remote("one", "One.", 1), remote("two", "Two.", 2), remote("three", "Three.", 3));
  const device = new Device(server);
  let lose = true;
  device.beforeRequest = (_method, path) => {
    if (path.includes("changes?after=1") && lose) { lose = false; throw new TypeError("offline"); }
  };
  await device.engine.sync();
  assert.equal(device.scope.cursor, 1);
  assert.deepEqual(Object.keys(device.scope.heads), ["one"]);
  await device.engine.sync();
  assert.equal(device.scope.cursor, 3);
  assert.equal(Object.keys(device.scope.heads).length, 3);
  assert.equal(device.status, "synced");
  assert.equal(device.requests.filter((r) => r.path.includes("changes?after=1")).length, 2);
});

test("a late receipt cannot replace a newer edit entered while the upload was pending", async () => {
  const server = new Server(), device = new Device(server);
  const first = queued("essay-one", "First draft.");
  const second = queued("essay-one", "New input while first upload is running.", first.local.revisionId);
  device.edit(first);
  let added = false;
  device.afterRequest = (method) => { if (method === "PUT" && !added) { added = true; device.edit(second); } };
  device.beforeRequest = (method, _path, body) => {
    if (method === "PUT" && (body as WriteRequest).revisionId === second.local.revisionId)
      assert.equal(device.scope.heads[first.recordId].revisionId, second.local.revisionId);
  };
  await device.engine.sync();
  assert.equal(device.scope.outbox.length, 0);
  assert.equal(device.scope.heads[first.recordId].revisionId, second.local.revisionId);
  assert.equal(server.heads.get(first.recordId)?.payload.text, second.local.payload.text);
  assert.equal(server.revisions.length, 2);
});

test("concurrent sync calls share one in-flight operation", async () => {
  const server = new Server(), device = new Device(server);
  device.edit(queued("essay-one", "Only one upload."));
  const first = device.engine.sync(), second = device.engine.sync();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(server.puts, 1);
  assert.equal(device.status, "synced");
});

test("missing capability does not erase records or consume the outbox", async () => {
  const server = new Server(); server.available = false;
  const device = new Device(server); device.edit(queued("essay-one", "Keep offline."));
  const before = clone(device.scope);
  await device.engine.sync();
  assert.deepEqual(device.scope, before);
  assert.equal(device.status, "unavailable");
  assert.equal(server.puts, 0);
});

test("an account changed before or after session verification cannot receive queued writes", async () => {
  for (const midway of [false, true]) {
    const server = new Server(), device = new Device(server);
    device.edit(queued("essay-one", "Private to learner one."));
    if (midway) device.afterRequest = (_method, path) => { if (path === "/api/capabilities") server.userId = "learner-two"; };
    else server.userId = "learner-two";
    const before = clone(device.scope);
    await device.engine.sync();
    assert.equal(device.status, "signed-out");
    assert.deepEqual(device.scope, before);
    assert.equal(server.puts, 0);
  }
});

test("leaving the account scope during a pull suppresses the late response", async () => {
  const server = new Server(); server.seed(remote("essay-one", "Do not apply to another account.", 1));
  const device = new Device(server);
  device.afterRequest = (_method, path) => { if (path.includes("/changes?")) device.alive = false; };
  await device.engine.sync();
  assert.deepEqual(device.scope, emptyScope());
  assert.notEqual(device.status, "synced");
});

test("global sequence advances across other datasets, conflict copies and deletion tombstones", async () => {
  const server = new Server();
  const initial = remote("essay-one", "Before delete.", 1);
  server.seed(initial, remote("other-dataset", "Private dataset.", 2, { datasetId: "another-atlas" }),
    remote(initial.id, "Concurrent copy.", 3, { conflict: true }),
    remote(initial.id, "", 4, { deleted: true, payload: {}, contentHash: fingerprint("essay", {}) }));
  const device = new Device(server);
  await device.engine.sync();
  assert.equal(device.scope.cursor, 4);
  assert.equal(device.scope.heads[initial.id].deleted, true);
  assert.equal(device.scope.revisions[server.revisions[2].revisionId].conflict, true);
  assert.equal(device.scope.heads["other-dataset"].payload.text, "Private dataset.");
  assert.equal(Object.values(device.scope.revisions).length, 4);
});

test("an aborted local transaction does not advance the cursor or lose the replayable page", async () => {
  const server = new Server(); server.seed(remote("essay-one", "Persist me.", 1));
  const device = new Device(server); device.failUpdateOnce = true;
  await device.engine.sync();
  assert.deepEqual(device.scope, emptyScope());
  assert.equal(device.status, "error");
  await device.engine.sync();
  assert.equal(device.scope.cursor, 1);
  assert.equal(device.scope.heads["essay-one"].payload.text, "Persist me.");
});

test("a server cursor that skips omitted revisions is rejected before local commit", async () => {
  const server = new Server(); server.seed(remote("essay-one", "Only returned row.", 1));
  const device = new Device(server);
  device.request = async (method, path, body) => {
    const result = await server.request(method, path, body);
    return path.includes("/changes?") ? { ...(result as object), nextCursor: 99 } : result;
  };
  await device.engine.sync();
  assert.deepEqual(device.scope, emptyScope());
  assert.equal(device.status, "error");
});

test("read-only service still pulls revisions without removing pending local writes", async () => {
  const server = new Server(); server.writable = false; server.seed(remote("remote-one", "Read this.", 1));
  const device = new Device(server); const edit = queued("essay-one", "Pending write."); device.edit(edit);
  await device.engine.sync();
  assert.equal(device.scope.heads["remote-one"].payload.text, "Read this.");
  assert.equal(device.scope.outbox[0].body.mutationId, edit.body.mutationId);
  assert.equal(device.status, "unavailable");
  assert.equal(server.puts, 0);
});

test("an incomplete conflict receipt never removes the original request", async () => {
  const server = new Server(), device = new Device(server);
  const edit = queued("essay-one", "Must keep this."); device.edit(edit);
  device.beforeRequest = (method) => { if (method === "PUT") throw new LearningApiError(409, "Conflict.", "revision_conflict", { applied: false, record: null }); };
  await device.engine.sync();
  assert.equal(device.scope.outbox.length, 1);
  assert.deepEqual(device.scope.outbox[0].body, edit.body);
  assert.equal(device.status, "error");
});

test("a request body changed while in flight is kept rather than mistaken for its old receipt", async () => {
  const server = new Server(), device = new Device(server);
  const edit = queued("essay-one", "Original request."); device.edit(edit);
  device.afterRequest = (method) => {
    if (method === "PUT") device.scope.outbox[0].body.payload.text = "Different content illegally reused the ID.";
  };
  await device.engine.sync();
  assert.equal(device.scope.outbox.length, 1);
  assert.equal(device.status, "error");
  assert.equal(server.revisions.length, 1);
});

test("a non-text receipt accepts the server hash when JSON number spellings differ", async () => {
  const server = new Server(), device = new Device(server);
  const edit = queued("mission-one", "");
  const payload = { datasetId: DATASET, planId: "plan-one", missionId: "listening-one", status: "in_progress", actualMinutes: 1e-7 };
  edit.body.kind = "mission"; edit.body.payload = payload;
  edit.local.kind = "mission"; edit.local.payload = payload;
  edit.local.contentHash = fingerprint("mission", payload);
  // Python emits 1e-07 where JS emits 1e-7; both parse back to the same number.
  server.hash = (_kind, value) => createHash("sha256").update(canonical(value).replace("1e-7", "1e-07")).digest("hex");
  assert.notEqual(server.hash("mission", payload), edit.local.contentHash);
  device.edit(edit);
  await device.engine.sync();
  assert.equal(device.status, "synced");
  assert.equal(device.scope.outbox.length, 0);
  assert.equal(device.scope.heads[edit.recordId].contentHash, server.hash("mission", payload));
});

test("a text receipt still requires the exact original UTF-8 content hash", async () => {
  const server = new Server(), device = new Device(server);
  const edit = queued("essay-one", "Original text hash must match.");
  device.edit(edit);
  server.hash = () => "b".repeat(64);
  await device.engine.sync();
  assert.equal(device.status, "error");
  assert.equal(device.scope.outbox.length, 1);
});

test("a successful deletion retains the current tombstone and its original receipt", async () => {
  const server = new Server();
  const initial = remote("essay-one", "Delete only after saving this revision.", 1); server.seed(initial);
  const device = new Device(server); await device.engine.sync();
  const deletion = queued(initial.id, "", initial.revisionId);
  deletion.body.deleted = true; deletion.body.payload = {};
  deletion.local.deleted = true; deletion.local.payload = {};
  deletion.local.contentHash = fingerprint("essay", {});
  device.edit(deletion);
  await device.engine.sync();
  assert.equal(device.status, "synced");
  assert.equal(device.scope.outbox.length, 0);
  assert.equal(device.scope.heads[initial.id].deleted, true);
  assert.equal(device.scope.revisions[initial.revisionId].payload.text, initial.payload.text);
});

test("a rejected record is quarantined and later records still upload", async () => {
  const server = new Server(), device = new Device(server);
  const bad = queued("bad", "Keep the rejected original."), goodOne = queued("good-one", "One."), goodTwo = queued("good-two", "Two.");
  [bad, goodOne, goodTwo].forEach((item) => device.edit(item));
  device.beforeRequest = (method, path) => {
    if (method === "PUT" && path.endsWith("/bad")) throw new LearningApiError(400, "这条记录的字段需要修正。", "invalid_learning_record");
  };
  await device.engine.sync();
  assert.deepEqual([...server.heads.keys()].sort(), ["good-one", "good-two"]);
  assert.equal(device.scope.outbox.length, 0);
  assert.equal(device.scope.quarantine.length, 1);
  assert.equal(device.scope.quarantine[0].code, "invalid_learning_record");
  assert.deepEqual(device.scope.quarantine[0].body, bad.body);
  assert.equal(device.scope.heads.bad.payload.text, bad.local.payload.text);
  assert.equal(device.status, "partial");
});

test("an oversized permanently rejected record cannot block later work", async () => {
  const server = new Server(), device = new Device(server);
  const bad = queued("oversized", "Preserve this original."), good = queued("next-work", "Independent work.");
  [bad, good].forEach((item) => device.edit(item));
  device.beforeRequest = (method, path) => {
    if (method === "PUT" && path.endsWith("/oversized")) throw new LearningApiError(413, "内容超过上限。", "invalid_learning_record");
  };
  await device.engine.sync();
  assert.ok(server.heads.has(good.recordId));
  assert.deepEqual(device.scope.quarantine.map((item) => item.body), [bad.body]);
  assert.equal(device.status, "partial");
});

test("a missing plan blocks only its dependants while an independent plan continues", async () => {
  const server = new Server(), device = new Device(server);
  const missing = queued("missing-work", "Missing plan."), dependent = queued("same-plan", "Also depends on it."), independent = queued("another-plan", "Independent.");
  independent.body.payload.planId = "independent-plan";
  independent.local.planId = "independent-plan";
  independent.local.contentHash = fingerprint("essay", independent.body.payload);
  [missing, dependent, independent].forEach((item) => device.edit(item));
  device.beforeRequest = (method, path) => {
    if (method === "PUT" && path.endsWith("/missing-work"))
      throw new LearningApiError(422, "所属计划尚未同步。", "missing_dependency", { missingPlanId: "plan-one" });
  };
  await device.engine.sync();
  assert.ok(server.heads.has(independent.recordId));
  assert.equal(device.scope.quarantine.length, 2);
  assert.deepEqual(device.scope.quarantine.map((item) => item.code), ["missing_dependency", "dependency_blocked"]);
  assert.equal(device.requests.filter((item) => item.method === "PUT" && item.path.endsWith("/same-plan")).length, 0);
  assert.equal(device.status, "partial");
});

test("a missing work revision does not block an unrelated essay in the same plan", async () => {
  const server = new Server(), device = new Device(server);
  const missing = queued("missing-draft", "Its parent has not arrived."), feedback = queued("dependent-feedback", ""), independent = queued("independent-draft", "This one is ready.");
  const payload = { datasetId: DATASET, planId: "plan-one", workId: missing.recordId, workRevisionId: missing.body.revisionId,
    inputHash: missing.local.contentHash, rubricVersion: "test-v2", source: "self", text: "Keep the feedback." };
  feedback.body.kind = "feedback"; feedback.body.payload = payload;
  feedback.local.kind = "feedback"; feedback.local.payload = payload; feedback.local.contentHash = fingerprint("feedback", payload);
  [missing, feedback, independent].forEach((item) => device.edit(item));
  device.beforeRequest = (method, path) => {
    if (method === "PUT" && path.endsWith("/missing-draft"))
      throw new LearningApiError(422, "原稿尚未同步。", "missing_dependency", { missingRevisionId: uuid() });
  };
  await device.engine.sync();
  assert.deepEqual([...server.heads.keys()], ["independent-draft"]);
  assert.equal(device.scope.quarantine.length, 2);
  assert.equal(device.requests.filter((item) => item.method === "PUT" && item.path.endsWith("/dependent-feedback")).length, 0);
  assert.equal(device.status, "partial");
});

test("quarantined originals survive a new engine and retry with the unchanged request IDs", async () => {
  const server = new Server(), device = new Device(server), original = queued("retry-me", "My rejected original.");
  device.edit(original);
  device.beforeRequest = (method) => { if (method === "PUT") throw new LearningApiError(400, "暂不接受此字段。", "invalid_learning_record"); };
  await device.engine.sync();
  assert.deepEqual(device.scope.quarantine[0].body, original.body);
  device.beforeRequest = undefined;
  const reopened = new LearningSyncEngine(device);
  await reopened.sync();
  assert.equal(server.puts, 0, "quarantine must not be silently retried or deleted on restart");
  assert.equal(device.scope.quarantine.length, 1);
  assert.equal(device.status, "partial");
  const item = device.scope.quarantine[0];
  device.scope.outbox.push({ recordId: item.recordId, body: item.body, local: item.local, createdAt: item.createdAt });
  device.scope.quarantine = [];
  await reopened.sync();
  assert.equal(server.revisions.length, 1);
  assert.equal(server.revisions[0].revisionId, original.body.revisionId);
  assert.ok(server.receipts.has(original.body.mutationId));
  assert.equal(device.status, "synced");
});

test("a later cloud revision cannot replace a quarantined original on the device", async () => {
  const server = new Server(), device = new Device(server);
  const initial = remote("essay-one", "Initial cloud draft.", 1);
  server.seed(initial);
  await device.engine.sync();
  const rejected = queued(initial.id, "The original that must remain recoverable.", initial.revisionId);
  device.edit(rejected);
  device.beforeRequest = (method) => { if (method === "PUT") throw new LearningApiError(400, "请修正字段。", "invalid_learning_record"); };
  await device.engine.sync();
  const newer = remote(initial.id, "A later edit from another device.", 2, { baseRevision: initial.revisionId });
  server.seed(newer);
  await new LearningSyncEngine(device).sync();
  assert.equal(device.scope.cursor, 2);
  assert.equal(device.scope.heads[initial.id].revisionId, rejected.local.revisionId);
  assert.equal(device.scope.revisions[newer.revisionId].payload.text, newer.payload.text);
  assert.deepEqual(device.scope.quarantine[0].body, rejected.body);
  assert.equal(device.status, "partial");
});

for (const [status, code, expected] of [[0, "network_error", "offline"], [401, "signed_out", "signed-out"], [503, "temporary_failure", "error"]] as const) {
  test(`a ${status} failure pauses the complete queue without quarantining retryable work`, async () => {
    const server = new Server(), device = new Device(server);
    const original = queued("first", "Keep first."), later = queued("second", "Keep second.");
    [original, later].forEach((item) => device.edit(item));
    device.beforeRequest = (method) => { if (method === "PUT") throw new LearningApiError(status, "暂时不可用。", code); };
    await device.engine.sync();
    assert.deepEqual(device.scope.outbox.map((item) => item.body), [original.body, later.body]);
    assert.deepEqual(device.scope.quarantine, []);
    assert.equal(device.status, expected);
    assert.equal(device.requests.filter((item) => item.method === "PUT").length, 1);
  });
}

test("idle synchronization reuses verification for ten minutes and makes only one pull per minute", async () => {
  const device = new Device(new Server());
  await device.engine.sync();
  assert.equal(device.requests.length, 3, "first sync verifies session/capability and pulls once");
  device.clock = 60000;
  const beforeMinute = device.requests.length;
  await device.engine.sync();
  assert.equal(device.requests.length - beforeMinute, 1);
  assert.equal(device.requests.filter((item) => item.path === "/api/auth/session").length, 1);
  device.clock = 600000;
  await device.engine.sync();
  assert.equal(device.requests.filter((item) => item.path === "/api/auth/session").length, 2);
  assert.equal(device.requests.filter((item) => item.path === "/api/capabilities").length, 2);
});

test("an explicit resume re-verifies immediately and a failed request invalidates verification", async () => {
  const server = new Server(), device = new Device(server);
  await device.engine.sync();
  await device.engine.sync({ verify: true });
  assert.equal(device.requests.filter((item) => item.path === "/api/auth/session").length, 2);
  device.beforeRequest = (_method, path) => { if (path.includes("/changes?")) throw new LearningApiError(401, "登录已失效。"); };
  await device.engine.sync();
  assert.equal(device.status, "signed-out");
  device.beforeRequest = undefined;
  await device.engine.sync();
  assert.equal(device.requests.filter((item) => item.path === "/api/auth/session").length, 3);
});

test("a changed vocabulary bank does not hide records or stop queued work in the same account", async () => {
  const server = new Server();
  server.seed(remote("old-bank-work", "Keep my learning history.", 1));
  const device = new Device(server), edit = queued("queued-before-switch", "Made with the original bank.");
  device.edit(edit);
  device.datasetId = "a-new-vocabulary-bank";
  await device.engine.sync();
  assert.equal(device.scope.heads["old-bank-work"].payload.text, "Keep my learning history.");
  assert.equal(device.scope.heads[edit.recordId].payload.datasetId, DATASET);
  assert.equal(device.scope.outbox.length, 0);
  assert.equal(device.status, "synced");
});
