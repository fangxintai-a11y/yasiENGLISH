import { LearningApiError } from "./api";
import { canonical, decodeRevision, isObject, type LearningScope, type QueuedMutation, type Revision, type SyncStatus } from "./protocol";

export interface LearningSyncPort {
  /** An engine belongs to one account and dataset for its whole lifetime. */
  userId: string | null;
  datasetId: string;
  read(): Promise<LearningScope>;
  update(change: (scope: LearningScope) => LearningScope): Promise<LearningScope>;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  changed(state: { syncStatus: SyncStatus; error?: string | null }): void;
  active(): boolean;
  exclusive?(task: () => Promise<void>): Promise<void>;
}

class InactiveScope extends Error {}
const invalid = (message = "学习服务返回了无效的数据，已保留本机待同步内容。") => new LearningApiError(502, message, "invalid_response");

/** Store every revision, but never turn a conflict copy into a current record. */
function receive(scope: LearningScope, items: Revision[], datasetId: string): LearningScope {
  const heads = { ...scope.heads };
  const revisions = { ...scope.revisions };
  const pending = new Set(scope.outbox.map((mutation) => mutation.recordId));
  for (const item of items) {
    if (item.datasetId !== datasetId) continue;
    revisions[item.revisionId] = item;
    if (item.conflict || pending.has(item.id)) continue;
    const previous = heads[item.id];
    if (!previous || item.seq >= previous.seq) heads[item.id] = item;
  }
  return { ...scope, heads, revisions };
}

/** Durable outbox with revision CAS. HTTP retries keep the original request IDs. */
export class LearningSyncEngine {
  private running: Promise<void> | null = null;

  constructor(private readonly port: LearningSyncPort) {}

  sync(): Promise<void> {
    if (this.running) return this.running;
    const task = () => this.perform();
    this.running = Promise.resolve()
      .then(() => this.port.exclusive ? this.port.exclusive(task) : task())
      .catch((error: unknown) => this.failed(error))
      .finally(() => { this.running = null; });
    return this.running;
  }

  private ensureActive() {
    if (!this.port.active()) throw new InactiveScope();
  }

  private async read() {
    this.ensureActive();
    const scope = await this.port.read();
    this.ensureActive();
    return scope;
  }

  private async update(change: (scope: LearningScope) => LearningScope) {
    this.ensureActive();
    // Account/dataset switches can happen while waiting for the local write lock.
    const scope = await this.port.update((current) => this.port.active() ? change(current) : current);
    this.ensureActive();
    return scope;
  }

  private async request(method: string, path: string, body?: unknown) {
    this.ensureActive();
    try {
      const result = await this.port.request(method, path, body);
      this.ensureActive();
      return result;
    } catch (error) {
      this.ensureActive();
      if (error instanceof LearningApiError) throw error;
      throw new LearningApiError(0, "暂时无法连接学习服务，本机内容和待上传记录已保留。", "network_error");
    }
  }

  private revision(value: unknown): Revision {
    try { return decodeRevision(value); }
    catch { throw invalid(); }
  }

  private async pull() {
    // Bound pathological servers without discarding already committed pagination progress.
    for (let page = 0; page < 1000; page++) {
      const before = await this.read();
      const response = await this.request("GET", `/api/learning/v1/changes?after=${before.cursor}&limit=100`);
      if (!isObject(response) || !Array.isArray(response.items) || !Number.isSafeInteger(response.nextCursor)
        || typeof response.hasMore !== "boolean") throw invalid();
      const items = response.items.map((item) => this.revision(item));
      let last = before.cursor;
      for (const item of items) {
        if (item.seq <= last) throw invalid("学习同步分页顺序异常，未跳过任何未保存记录。");
        last = item.seq;
      }
      if (response.nextCursor !== last || (response.hasMore && !items.length)) throw invalid("学习同步游标异常，未跳过任何未保存记录。");
      await this.update((current) => {
        // Another tab may already have committed this page. Keep its newer cursor and edits.
        const merged = receive(current, items, this.port.datasetId);
        return { ...merged, cursor: Math.max(current.cursor, last) };
      });
      if (!response.hasMore) return;
    }
    throw invalid("学习记录分页较多，已保存当前进度，请再次同步继续。");
  }

  private checkAcknowledged(item: Revision, mutation: QueuedMutation) {
    // Text hashes are the feedback binding. Other kinds hash JSON, whose numeric
    // spelling can differ between Python and JS despite equivalent parsed values.
    const textRecord = item.kind === "essay" || item.kind === "speaking";
    if (item.id !== mutation.recordId || item.revisionId !== mutation.body.revisionId
      || item.datasetId !== this.port.datasetId || item.planId !== mutation.local.planId || item.kind !== mutation.body.kind
      || item.baseRevision !== mutation.body.baseRevision || item.deleted !== !!mutation.body.deleted
      || (textRecord && item.contentHash !== mutation.local.contentHash) || canonical(item.payload) !== canonical(mutation.body.payload))
      throw invalid("服务器回执与待上传内容不一致，原请求仍已保留。");
  }

  private async upload(mutation: QueuedMutation) {
    if (mutation.local.datasetId !== this.port.datasetId || mutation.local.id !== mutation.recordId
      || mutation.local.revisionId !== mutation.body.revisionId) throw invalid("本机待上传记录的归属不匹配，已停止同步。");
    let response: unknown;
    let conflicting = false;
    try {
      response = await this.request("PUT", `/api/learning/v1/records/${encodeURIComponent(mutation.recordId)}`, mutation.body);
    } catch (error) {
      if (!(error instanceof LearningApiError) || error.status !== 409 || error.code !== "revision_conflict") throw error;
      response = error.body;
      conflicting = true;
    }
    if (!isObject(response) || response.applied !== !conflicting) throw invalid();
    const submitted = this.revision(conflicting ? response.conflict : response.record);
    this.checkAcknowledged(submitted, mutation);
    if (submitted.conflict !== conflicting) throw invalid();
    const current = conflicting ? this.revision(response.record) : submitted;
    if (current.id !== mutation.recordId || current.datasetId !== this.port.datasetId || current.conflict) throw invalid();
    await this.update((scope) => {
      const queued = scope.outbox.find((item) => item.body.mutationId === mutation.body.mutationId);
      if (queued && (queued.recordId !== mutation.recordId || canonical(queued.body) !== canonical(mutation.body)))
        throw invalid("待上传请求在发送后被修改，已保留本机内容并停止同步。");
      // Remove only the request whose receipt was verified, never a subsequent edit.
      const outbox = scope.outbox.filter((item) => item.body.mutationId !== mutation.body.mutationId);
      return receive({ ...scope, outbox }, [submitted, current], this.port.datasetId);
    });
  }

  private async perform() {
    this.ensureActive();
    if (!this.port.userId) {
      this.port.changed({ syncStatus: "signed-out", error: "登录后可同步这些学习记录，本机内容仍已保留。" });
      return;
    }
    this.port.changed({ syncStatus: "syncing", error: null });
    const session = await this.request("GET", "/api/auth/session");
    if (!isObject(session) || !("user" in session)) throw invalid();
    if (session.user === null) throw new LearningApiError(401, "请重新登录，本机内容仍已保留。");
    if (!isObject(session.user) || session.user.id !== this.port.userId)
      throw new LearningApiError(403, "登录账号已变更，请重新连接后再同步。", "account_changed");
    const capability = await this.request("GET", "/api/capabilities");
    if (!isObject(capability) || capability.learningRecords !== 1)
      throw new LearningApiError(503, "当前服务器暂不支持学习记录同步，本机内容仍已保留。", "unavailable");
    await this.pull();
    if (capability.learningWriteEnabled !== true) {
      this.ensureActive();
      this.port.changed({ syncStatus: "unavailable", error: "云端学习记录暂时只读，本机待上传内容已保留。" });
      return;
    }
    while (true) {
      const scope = await this.read();
      if (!scope.outbox.length) break;
      await this.upload(scope.outbox[0]);
    }
    await this.pull();
    const remaining = await this.read();
    this.port.changed({ syncStatus: remaining.outbox.length ? "local" : "synced", error: null });
  }

  private failed(error: unknown) {
    if (error instanceof InactiveScope || !this.port.active()) return;
    const problem = error instanceof LearningApiError ? error : new LearningApiError(507, error instanceof Error ? error.message : "本机保存失败，已暂停同步。");
    const signedOut = problem.status === 401 || (problem.status === 403 && problem.code === "account_changed");
    const unavailable = problem.status === 404 || problem.code === "unavailable" || problem.code === "learning_write_disabled";
    this.port.changed({ syncStatus: signedOut ? "signed-out" : unavailable ? "unavailable" : problem.status === 0 ? "offline" : "error", error: problem.message });
  }
}
