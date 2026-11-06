import { Download, Pause, Play, Trash2 } from "lucide-react";
import {
  defaultSelection,
  deletePack,
  loadManifest,
  pausePack,
  setSelection,
  startPack,
  usePack,
  type GroupKey,
} from "../lib/offline";
import { formatBytes, formatEta, missingGroups, selectionSize } from "../lib/offlinePack";
import { useStore } from "../store/store";
import { toast } from "./Toast";

const day = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** 「离线包」: one tap stores illustrations and pronunciations in Cache Storage so the installed app works without a network. */
export function OfflinePanel() {
  const pack = usePack();
  const accent = useStore((s) => s.settings.accent);
  const { manifest, done, phase, progress, failed, space } = pack;
  const keys: GroupKey[] = pack.selection ? [...new Set<GroupKey>(["base", ...pack.selection])] : defaultSelection(accent);
  const busy = phase === "running";
  const locked = busy || phase === "paused";
  const total = manifest ? selectionSize(manifest, keys) : null;
  const update = !!done && !!manifest && done.version !== manifest.version;
  const todo = !done || update || (manifest ? missingGroups(manifest, keys, done.groups).length > 0 : false);
  const resuming = phase === "paused" || failed.length > 0 || (pack.cached && !done);
  const pct = progress.bytesTotal ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100) : 0;

  const status = busy
    ? "下载中"
    : phase === "paused"
      ? "已暂停"
      : phase === "error"
        ? "出错了"
        : update
          ? "有更新"
          : done
            ? `已完成（${day(done.at)}${done.limit ? "，测试子集" : ""}）`
            : "未下载";
  const tone = busy ? "run" : phase === "error" ? "bad" : update ? "warn" : done ? "ok" : "";

  const toggle = (k: GroupKey) => setSelection(keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k]);
  const start = (force = false) => void startPack(keys, force);
  const remove = async () => {
    if (!confirm("删除离线包？已下载的插画和发音会被清除，之后需要重新下载（在线时仍可正常使用）。")) return;
    await deletePack();
    toast("离线包已删除");
  };

  return (
    <section className="panel pack-panel">
      <div className="panel-head">
        <h3 className="eyebrow">离线包</h3>
        <span className={`pack-status ${tone ? `is-${tone}` : ""}`} role="status">
          {status}
        </span>
      </div>
      <p className="muted">建议连 Wi-Fi 下载；下载后在 iPhone 上「添加到主屏幕」打开，没网也能学习（AI 功能除外）。</p>

      {manifest ? (
        <>
          <ul className="pack-groups">
            {manifest.groups.map((g) => (
              <li key={g.key}>
                <label className={g.required ? "is-required" : ""}>
                  <input type="checkbox" checked={g.required || keys.includes(g.key)} disabled={g.required || locked} onChange={() => toggle(g.key)} />
                  <span>
                    <b>{g.label}</b>
                    <small>{g.count.toLocaleString()} 个文件</small>
                  </span>
                  <em>{formatBytes(g.bytes)}</em>
                </label>
              </li>
            ))}
          </ul>
          {total && (
            <p className="pack-total">
              已选合计 <b>{formatBytes(total.bytes)}</b>
              <small> · {total.files.toLocaleString()} 个文件</small>
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          {pack.manifestError ?? "正在读取离线包清单…"}{" "}
          {pack.manifestError && (
            <button className="link" onClick={() => void loadManifest()}>
              重试
            </button>
          )}
        </p>
      )}

      {space && (
        <p className="pack-space">
          存储 · 已用 {formatBytes(space.used)} / 配额 {formatBytes(space.quota)}
          {pack.persisted === false && "（浏览器暂未授予持久存储，长期不用可能被清理）"}
        </p>
      )}

      {progress.filesTotal > 0 && (
        <div className="pack-progress">
          <div className="pack-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="离线包下载进度">
            <span style={{ width: `${pct}%` }} />
          </div>
          <p>
            <b>{Math.floor(pct)}%</b>
            <span>
              {progress.filesDone.toLocaleString()} / {progress.filesTotal.toLocaleString()} 个文件
            </span>
            <span>
              {formatBytes(progress.bytesDone)} / {formatBytes(progress.bytesTotal)}
            </span>
            {busy && (
              <span>
                {formatBytes(pack.speed)}/秒 · 剩余 {formatEta(pack.eta)}
              </span>
            )}
          </p>
        </div>
      )}

      {pack.lowSpace && (
        <div className="pack-warn" role="alert">
          <p>
            剩余空间约 {formatBytes(pack.lowSpace.remaining)}，这次还需要约 {formatBytes(pack.lowSpace.needed)}，可能装不下。可以取消勾选一些内容，或者仍然尝试。
          </p>
          <button className="btn btn-ghost" onClick={() => start(true)}>
            仍然下载
          </button>
        </div>
      )}
      {pack.message && <p className={phase === "error" ? "warn-text" : "muted"}>{pack.message}</p>}

      <div className="data-actions">
        {busy ? (
          <button className="btn btn-ghost" onClick={pausePack}>
            <Pause size={18} /> 暂停
          </button>
        ) : (
          (todo || phase === "paused" || failed.length > 0) && (
            <button className="btn btn-primary" onClick={() => start()} disabled={!manifest}>
              {resuming ? <Play size={18} /> : <Download size={18} />}
              {resuming ? "继续" : update ? "更新" : "下载"}
            </button>
          )
        )}
        {(done || pack.cached) && !busy && (
          <button className="btn btn-ghost btn-danger" onClick={() => void remove()}>
            <Trash2 size={18} /> 删除离线包
          </button>
        )}
      </div>
      {update && !busy && <p className="muted">词库有更新：点「更新」只会补下载缺少的文件。</p>}

      {failed.length > 0 && !busy && (
        <details className="pack-failed">
          <summary>{failed.length} 个文件下载失败</summary>
          <ul>
            {failed.slice(0, 50).map((u) => (
              <li key={u}>{decodeURI(u.replace(location.origin, ""))}</li>
            ))}
            {failed.length > 50 && <li>…另有 {failed.length - 50} 个</li>}
          </ul>
        </details>
      )}
    </section>
  );
}
