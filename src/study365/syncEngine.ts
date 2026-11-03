import { LearningApiError } from "./api";
import { canonical, decodeRevision, isObject, type LearningScope, type QueuedMutation, type QuarantinedMutation, type Revision, type SyncStatus } from "./protocol";

export interface LearningSyncPort {
  /** An engine belongs to one account for its whole lifetime; a vocabulary bank is only provenance. */
  userId: string | null;
  datasetId?: string | null;
  read(): Promise<LearningScope>;
  update(change: (scope: LearningScope) => LearningScope): Promise<LearningScope>;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  changed(state: { syncStatus: SyncStatus; error?: string | null }): void;
  active(): boolean;
  exclusive?(task: () => Promise<void>): Promise<void>;
  now?(): number;
}

class InactiveScope extends Error {}
const invalid = (message = "学习服务返回了无效的数据，已保留本机待同步内容。") => new LearningApiError(502, message, "invalid_response");

/** Store every revision, but never turn a conflict copy into a current record. */
function receive(scope: LearningScope, items: Revision[]): LearningScope {
  const heads = { ...scope.heads };
  const revisions = { ...scope.revisions };
  const pending = new Set([...scope.outbox, ...(scope.quarantine ?? [])].map((mutation) => mutation.recordId));
  for (const item of items) {
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
  private verified: { at: number; writable: boolean } | null = null;

  constructor(private readonly port: LearningSyncPort) {}

  invalidateVerification(): void { this.verified = null; }

  sync(options: { verify?: boolean } = {}): Promise<void> {
    if (options.verify) this.invalidateVerification();
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
    return { ...scope, quarantine: scope.quarantine ?? [] };
  }

  private async update(change: (scope: LearningScope) => LearningScope) {
    this.ensureActive();
    // Account switches can happen while waiting for the local write lock.
    const scope = await this.port.update((current) => this.port.active() ? change({ ...current, quarantine: current.quarantine ?? [] }) : current);
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
      const response = await this.request("GET", `/api/learning/v2/changes?after=${before.cursor}&limit=100`);
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
        const merged = receive(current, items);
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
      || item.planId !== mutation.local.planId || item.kind !== mutation.body.kind
      || item.baseRevision !== mutation.body.baseRevision || item.deleted !== !!mutation.body.deleted
      || (textRecord && item.contentHash !== mutation.local.contentHash) || canonical(item.payload) !== canonical(mutation.body.payload))
      throw invalid("服务器回执与待上传内容不一致，原请求仍已保留。");
  }

  private async upload(mutation: QueuedMutation) {
    if (mutation.local.id !== mutation.recordId
      || mutation.local.revisionId !== mutation.body.revisionId) throw invalid("本机待上传记录的归属不匹配，已停止同步。");
    let response: unknown;
    let conflicting = false;
    try {
      response = await this.request("PUT", `/api/learning/v2/records/${encodeURIComponent(mutation.recordId)}`, mutation.body);
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
    if (current.id !== mutation.recordId || current.kind !== mutation.body.kind || current.planId !== mutation.local.planId || current.conflict) throw invalid();
    await this.update((scope) => {
      const queued = scope.outbox.find((item) => item.body.mutationId === mutation.body.mutationId);
      if (queued && (queued.recordId !== mutation.recordId || canonical(queued.body) !== canonical(mutation.body)))
        throw invalid("待上传请求在发送后被修改，已保留本机内容并停止同步。");
      // Remove only the request whose receipt was verified, never a subsequent edit.
      const outbox = scope.outbox.filter((item) => item.body.mutationId !== mutation.body.mutationId);
      return receive({ ...scope, outbox }, [submitted, current]);
    });
  }

  private async quarantine(mutation: QueuedMutation, problem: LearningApiError) {
    await this.update((scope) => {
      const queued = scope.outbox.find((item) => item.body.mutationId === mutation.body.mutationId);
      if (!queued) return scope;
      if (queued.recordId !== mutation.recordId || canonical(queued.body) !== canonical(mutation.body))
        throw invalid("待上传请求在发送后被修改，原文已保留，无法将不同请求混作同一条错误。");
      const item: QuarantinedMutation = { ...queued, error: problem.message, code: problem.code ?? "invalid_learning_record", at: this.now() };
      return { ...scope,
        outbox: scope.outbox.filter((entry) => entry.body.mutationId !== mutation.body.mutationId),
        quarantine: [...scope.quarantine.filter((entry) => entry.body.mutationId !== mutation.body.mutationId), item],
      };
    });
  }

  private now() { return this.port.now?.() ?? Date.now(); }

  private async verify() {
    const now = this.now();
    if (this.verified && now >= this.verified.at && now - this.verified.at < 10 * 60 * 1000) return this.verified;
    const session = await this.request("GET", "/api/auth/session");
    if (!isObject(session) || !("user" in session)) throw invalid();
    if (session.user === null) throw new LearningApiError(401, "请重新登录，本机内容仍已保留。");
    if (!isObject(session.user) || session.user.id !== this.port.userId)
      throw new LearningApiError(403, "登录账号已变更，请重新连接后再同步。", "account_changed");
    const capability = await this.request("GET", "/api/capabilities");
    if (!isObject(capability) || capability.learningRecords !== 2)
      throw new LearningApiError(503, "当前服务器暂不支持新版学习记录同步，本机内容仍已保留。", "unavailable");
    this.verified = { at: now, writable: capability.learningWriteEnabled === true };
    return this.verified;
  }

  private async perform() {
    this.ensureActive();
    if (!this.port.userId) {
      this.port.changed({ syncStatus: "signed-out", error: "登录后可同步这些学习记录，本机内容仍已保留。" });
      return;
    }
    this.port.changed({ syncStatus: "syncing", error: null });
    const capability = await this.verify();
    await this.pull();
    if (!capability.writable) {
      this.ensureActive();
      this.port.changed({ syncStatus: "unavailable", error: "云端学习记录暂时只读，本机待上传内容已保留。" });
      return;
    }
    const blockedPlans = new Set<string>(), blockedRecords = new Set<string>(), blockedRevisions = new Set<string>();
    let uploaded = false;
    while (true) {
      const scope = await this.read();
      if (!scope.outbox.length) break;
      const mutation = scope.outbox[0], payload = mutation.body.payload;
      const planId = typeof payload.planId === "string" ? payload.planId : mutation.local.planId;
      const references = [mutation.body.baseRevision, payload.workRevisionId, payload.parentRevisionId];
      const blocked = blockedRecords.has(mutation.recordId) || (typeof planId === "string" && blockedPlans.has(planId))
        || (typeof payload.workId === "string" && blockedRecords.has(payload.workId))
        || references.some((value) => typeof value === "string" && blockedRevisions.has(value));
      if (blocked) {
        await this.quarantine(mutation, new LearningApiError(422, "依赖的计划或原稿尚未同步，原文已保留；请先修复依赖后重试。", "dependency_blocked"));
        blockedRecords.add(mutation.recordId); blockedRevisions.add(mutation.body.revisionId);
        if (mutation.body.kind === "plan") blockedPlans.add(mutation.recordId);
        continue;
      }
      try {
        await this.upload(mutation);
        uploaded = true;
      } catch (error) {
        if (!(error instanceof LearningApiError) || !(((error.status === 400 || error.status === 413) && error.code === "invalid_learning_record")
          || (error.status === 422 && error.code === "missing_dependency"))) throw error;
        await this.quarantine(mutation, error);
        blockedRecords.add(mutation.recordId); blockedRevisions.add(mutation.body.revisionId);
        if (mutation.body.kind === "plan") blockedPlans.add(mutation.recordId);
        if (isObject(error.body)) {
          if (typeof error.body.missingPlanId === "string") blockedPlans.add(error.body.missingPlanId);
          if (typeof error.body.missingRevisionId === "string") blockedRevisions.add(error.body.missingRevisionId);
        }
      }
    }
    if (uploaded) await this.pull();
    const remaining = await this.read();
    const count = remaining.quarantine.length;
    this.port.changed({ syncStatus: count ? "partial" : remaining.outbox.length ? "local" : "synced",
      error: count ? `有 ${count} 条记录未能同步，原文已保留，可重试或导出。` : null });
  }

  private failed(error: unknown) {
    if (error instanceof InactiveScope || !this.port.active()) return;
    this.invalidateVerification();
    const problem = error instanceof LearningApiError ? error : new LearningApiError(507, error instanceof Error ? error.message : "本机保存失败，已暂停同步。");
    const signedOut = problem.status === 401 || (problem.status === 403 && problem.code === "account_changed");
    const unavailable = problem.status === 404 || problem.code === "unavailable" || problem.code === "learning_write_disabled";
    this.port.changed({ syncStatus: signedOut ? "signed-out" : unavailable ? "unavailable" : problem.status === 0 ? "offline" : "error", error: problem.message });
  }
}
