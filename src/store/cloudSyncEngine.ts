import { mergeSnapshots, type SyncSnapshot } from "./syncMerge";

export type CloudUser = { id: string; username: string };
export type CloudState = {
  status: "checking" | "local" | "syncing" | "synced" | "offline" | "error" | "auth";
  user: CloudUser | null;
  message: string;
  lastSync: number | null;
  pending: boolean;
};
export type SyncMeta = {
  base: SyncSnapshot | null;
  pending?: { commitId: string; revision: number; snapshot: SyncSnapshot; localAtSend: SyncSnapshot };
  application?: { stamp: string; before: SyncSnapshot; after: SyncSnapshot };
};
type Remote = { revision: number; snapshot: SyncSnapshot | null; applied: boolean };
export class CloudError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}
export type CloudPort = {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  snapshot(): SyncSnapshot | null;
  apply(snapshot: SyncSnapshot, stamp?: string): void;
  appliedStamp(): string | null;
  load(user: CloudUser, dataset: string): SyncMeta | Promise<SyncMeta>;
  save(user: CloudUser, dataset: string, meta: SyncMeta): void | Promise<void>;
  exclusive?(task: () => Promise<void>): Promise<void>;
  remember(user: CloudUser | null): void;
  decode(value: unknown, dataset: string): SyncSnapshot | null;
  uuid(): string;
  changed(state: CloudState): void;
};

export function sameSnapshot(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  };
  return canonical(a) === canonical(b);
}

/** One outstanding commit per browser. A durable receipt resolves lost HTTP responses. */
export class CloudSyncEngine {
  state: CloudState = { status: "checking", user: null, message: "正在连接同步服务…", lastSync: null, pending: false };
  private epoch = 0;
  private running: Promise<void> | null = null;
  constructor(private readonly port: CloudPort) {}

  private update(patch: Partial<CloudState>) {
    this.state = { ...this.state, ...patch };
    this.port.changed(this.state);
  }

  async connect() {
    const epoch = this.epoch;
    try {
      const result = await this.port.request("GET", "/api/auth/session") as { user: CloudUser | null };
      if (epoch !== this.epoch) return;
      this.port.remember(result.user);
      this.update({ user: result.user, status: result.user ? "syncing" : "local", message: result.user ? "正在合并学习进度…" : "登录后，手机和电脑会自动同步。" });
      if (result.user) await this.sync();
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.update({ status: "offline", message: this.failure(e) });
    }
  }

  restoreUser(user: CloudUser | null) {
    this.update({ user });
  }

  async login(username: string, password: string, setupToken = "", create = false) {
    if (this.running) await this.running;
    const result = await this.port.request("POST", create ? "/api/auth/register" : "/api/auth/login", { username, password, ...(create ? { setupToken } : {}) }) as { user: CloudUser };
    this.epoch++;
    this.port.remember(result.user);
    this.update({ user: result.user, status: "syncing", pending: true, lastSync: null, message: "正在合并已有学习进度…" });
    await this.sync();
  }

  async logout() {
    if (this.running) await this.running;
    await this.port.request("POST", "/api/auth/logout", {});
    this.epoch++;
    this.port.remember(null);
    this.update({ user: null, status: "local", message: "已退出同步，本机学习记录仍然保留。", lastSync: null, pending: false });
  }

  markChanged() {
    if (this.state.user) this.update({ pending: true });
  }

  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = (this.port.exclusive ? this.port.exclusive(() => this.perform()) : this.perform()).finally(() => { this.running = null; });
    return this.running;
  }

  private remote(value: unknown, dataset: string): Remote {
    const v = value as Partial<Remote>;
    if (!v || !Number.isSafeInteger(v.revision) || v.revision! < 0 || !("snapshot" in v)) throw new CloudError("同步服务返回了无效的数据。");
    return { revision: v.revision!, snapshot: this.port.decode(v.snapshot, dataset), applied: v.applied === true };
  }

  private failure(e: unknown) {
    return e instanceof CloudError && e.status ? e.message : "同步服务暂时未连接，学习记录已留在本机，联网后会重试。";
  }

  private async checkpoint(user: CloudUser, dataset: string, base: SyncSnapshot, before: SyncSnapshot, after: SyncSnapshot): Promise<SyncMeta> {
    const application = { stamp: this.port.uuid(), before, after };
    await this.port.save(user, dataset, { base, application });
    if (this.port.snapshot()?.progress.datasetId !== dataset) return { base, application };
    // Answers may arrive while the IndexedDB journal is being committed.
    this.port.apply(mergeSnapshots(before, this.port.snapshot()!, after), application.stamp);
    const meta = { base };
    await this.port.save(user, dataset, meta);
    return meta;
  }

  private async perform() {
    const user = this.state.user;
    if (!user || !this.port.snapshot()) return;
    const epoch = this.epoch;
    const dataset = this.port.snapshot()!.progress.datasetId;
    const active = () => epoch === this.epoch && this.port.snapshot()?.progress.datasetId === dataset;
    this.update({ status: "syncing", message: "正在同步学习进度…" });
    try {
      let meta = await this.port.load(user, dataset);
      if (!active()) return;
      if (meta.application) {
        const { stamp, before, after } = meta.application;
        if (this.port.appliedStamp() !== stamp) this.port.apply(mergeSnapshots(before, this.port.snapshot()!, after), stamp);
        meta = { base: meta.base };
        await this.port.save(user, dataset, meta);
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const query = meta.pending ? `?commitId=${encodeURIComponent(meta.pending.commitId)}` : "";
        let remote = this.remote(await this.port.request("GET", `/api/sync/${encodeURIComponent(dataset)}${query}`), dataset);
        if (!active()) return;
        if (meta.pending && !remote.applied) {
          // A timed-out request may still be running on the server. Only retrying the
          // SAME revision and commitId yields a definitive receipt or CAS rejection.
          const pending = meta.pending;
          try {
            remote = this.remote(await this.port.request("PUT", `/api/sync/${encodeURIComponent(dataset)}`, {
              revision: pending.revision, snapshot: pending.snapshot, commitId: pending.commitId,
            }), dataset);
          } catch (e) {
            if (!(e instanceof CloudError && e.status === 409)) throw e;
            if (!active()) return;
            meta = { base: meta.base };
            await this.port.save(user, dataset, meta);
            continue;
          }
          if (!active()) return;
        }
        let local = this.port.snapshot()!;
        if (meta.pending && remote.applied) {
          // The last PUT committed, even if its response never reached this device.
          local = mergeSnapshots(meta.pending.localAtSend, local, meta.pending.snapshot);
          const base = meta.pending.snapshot;
          meta = await this.checkpoint(user, dataset, base, this.port.snapshot()!, local);
          if (!active()) return;
          local = this.port.snapshot()!;
        }
        const merged = mergeSnapshots(meta.base, local, remote.snapshot);
        if (sameSnapshot(merged, remote.snapshot)) {
          meta = await this.checkpoint(user, dataset, merged, local, merged);
          if (!active()) return;
          const pending = !sameSnapshot(this.port.snapshot(), merged);
          this.update({ status: pending ? "syncing" : "synced", lastSync: Date.now(), pending, message: pending ? "正在同步新的答题记录…" : "学习进度已同步。" });
          return;
        }
        const pending = { commitId: this.port.uuid(), revision: remote.revision, snapshot: merged, localAtSend: local };
        meta = { base: meta.base, pending };
        // Must succeed before sending: a lost response needs this durable transaction journal.
        await this.port.save(user, dataset, meta);
        if (!active()) return;
        let accepted: Remote;
        try {
          accepted = this.remote(await this.port.request("PUT", `/api/sync/${encodeURIComponent(dataset)}`, { revision: remote.revision, snapshot: merged, commitId: pending.commitId }), dataset);
        } catch (e) {
          if (e instanceof CloudError && e.status === 409) {
            if (!active()) return;
            meta = { base: meta.base };
            await this.port.save(user, dataset, meta);
            continue;
          }
          throw e;
        }
        if (!active()) return;
        const current = this.port.snapshot()!;
        // Keep answers entered while the request was in flight.
        const next = mergeSnapshots(local, current, accepted.snapshot ?? merged);
        meta = await this.checkpoint(user, dataset, accepted.snapshot ?? merged, current, next);
        if (!active()) return;
        if (sameSnapshot(this.port.snapshot(), meta.base)) {
          this.update({ status: "synced", lastSync: Date.now(), pending: false, message: "学习进度已同步。" });
          return;
        }
      }
      this.update({ status: "offline", pending: true, message: "另一台设备也在学习，稍后会继续合并同步。" });
    } catch (e) {
      if (!active()) return;
      if (e instanceof CloudError && e.status === 401) {
        this.update({ user: null, status: "auth", pending: true, message: "登录已过期，请重新登录以继续同步。本机记录已保留。" });
      } else {
        this.update({ status: e instanceof CloudError && e.status ? "error" : "offline", pending: true, message: this.failure(e) });
      }
    }
  }
}
