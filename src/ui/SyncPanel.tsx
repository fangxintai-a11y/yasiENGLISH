import { Cloud, CloudOff, LogIn, LogOut, RefreshCw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { loginCloud, logoutCloud, syncNow, useCloudSync } from "../store/cloudSync";
import "../styles/sync.css";
import { AccountPanel } from "./AccountPanel";

const STATUS_LABELS = {
  checking: "正在连接",
  local: "仅保存在本机",
  syncing: "正在同步",
  synced: "已同步",
  offline: "等待联网",
  error: "同步未完成",
  auth: "请重新登录",
} as const;

/** One personal account keeps the learner's phone and computer together. */
export function SyncPanel() {
  const cloud = useCloudSync();
  const id = useId();
  const [mode, setMode] = useState<"login" | "create">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState<"login" | "sync" | "logout" | null>(null);
  const [error, setError] = useState("");
  const signedIn = !!cloud.user && cloud.status !== "auth";
  const waiting = busy !== null || cloud.status === "checking" || cloud.status === "syncing";
  const errorId = `${id}-error`;
  const noteId = `${id}-note`;
  const usernameHintId = `${id}-username-hint`;
  const date = cloud.lastSync ? new Date(cloud.lastSync) : null;
  const syncedAt = date && Number.isFinite(date.getTime()) ? date : null;

  const changeMode = (next: "login" | "create") => {
    setMode(next);
    setPassword("");
    setSetupToken("");
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (waiting) return;
    setError("");
    setBusy("login");
    try {
      await loginCloud(username.trim(), password, mode === "create" ? setupToken.trim() || undefined : undefined, mode === "create");
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录未完成，请稍后重试。");
    } finally {
      setPassword("");
      setSetupToken("");
      setBusy(null);
    }
  };

  const sync = async () => {
    if (waiting) return;
    setError("");
    setBusy("sync");
    try {
      await syncNow();
    } catch (e) {
      setError(e instanceof Error ? e.message : "同步未完成，请稍后重试。");
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    if (waiting) return;
    setError("");
    setBusy("logout");
    try {
      await logoutCloud();
    } catch (e) {
      setError(e instanceof Error ? e.message : "退出未完成，请稍后重试。");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel sync-panel" aria-labelledby={`${id}-heading`} aria-busy={busy !== null || cloud.status === "syncing"}>
      <div className="panel-head sync-panel-head">
        <h3 className="eyebrow" id={`${id}-heading`}>学习进度同步</h3>
        <span className={`sync-status is-${cloud.status}`} role="status" aria-live="polite">
          {cloud.status === "offline" ? <CloudOff size={15} aria-hidden="true" /> : <Cloud size={15} aria-hidden="true" />}
          {STATUS_LABELS[cloud.status]}
        </span>
      </div>

      {signedIn ? (
        <>
          <div className="sync-account">
            <p>已登录 <b>{cloud.user!.username}</b></p>
            <p className="muted sync-last-time">
              上次同步：{syncedAt ? <time dateTime={syncedAt.toISOString()}>{syncedAt.toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time> : "尚未完成"}
            </p>
          </div>
          <p className="muted">手机和电脑登录同一个账号，学习后会自动同步；离线时继续学习，联网后补传。</p>
          {cloud.pending && <p className="sync-pending" role="status" aria-live="polite">还有本机记录等待同步。</p>}
          <div className="data-actions sync-actions">
            <button type="button" className="btn btn-primary" onClick={() => void sync()} disabled={waiting}>
              <RefreshCw size={17} className={cloud.status === "syncing" || busy === "sync" ? "sync-spinning" : undefined} aria-hidden="true" />
              {cloud.status === "syncing" || busy === "sync" ? "同步中…" : "立即同步"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void logout()} disabled={waiting}>
              <LogOut size={17} aria-hidden="true" />{busy === "logout" ? "退出中…" : "退出同步账号"}
            </button>
          </div>
          <details className="sync-account-management">
            <summary>账号管理</summary>
            <AccountPanel username={cloud.user!.username} />
          </details>
        </>
      ) : (
        <>
          <p className="muted">在手机和电脑上使用同一个同步账号，让学习进度接着走。离线时也能继续学习。</p>
          <div className="segmented sync-mode" role="group" aria-label="同步账号操作">
            <button type="button" className={mode === "login" ? "is-on" : undefined} aria-pressed={mode === "login"} disabled={waiting} onClick={() => changeMode("login")}>登录</button>
            <button type="button" className={mode === "create" ? "is-on" : undefined} aria-pressed={mode === "create"} disabled={waiting} onClick={() => changeMode("create")}>首次设置</button>
          </div>
          <form className="sync-form" onSubmit={(event) => void submit(event)} aria-describedby={noteId}>
            <label className="sync-field" htmlFor={`${id}-username`}>
              <span>账号</span>
              <input id={`${id}-username`} name="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={40} pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{2,39}"} required autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={waiting} aria-describedby={usernameHintId} />
              <small id={usernameHintId}>3–40 位英文字母、数字或 . _ -</small>
            </label>
            <label className="sync-field" htmlFor={`${id}-password`}>
              <span>密码</span>
              <input id={`${id}-password`} name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} maxLength={256} required autoComplete={mode === "create" ? "new-password" : "current-password"} disabled={waiting} aria-describedby={error ? errorId : undefined} />
              {mode === "create" && <small>至少 10 位，请在另一台设备上使用同一账号和密码登录。</small>}
            </label>
            {mode === "create" && (
              <label className="sync-field" htmlFor={`${id}-pairing`}>
                <span>配对码（如有）</span>
                <input id={`${id}-pairing`} name="setup-token" type="password" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} maxLength={256} autoComplete="off" disabled={waiting} />
                <small>如果首次设置时提供了配对码，请填在这里。</small>
              </label>
            )}
            <p className="muted sync-merge-note" id={noteId}>登录后，本机已有的学习进度会与账号中的记录合并。</p>
            <button type="submit" className="btn btn-primary" disabled={waiting}>
              <LogIn size={17} aria-hidden="true" />{busy === "login" ? "连接中…" : mode === "create" ? "创建账号并同步" : "登录并同步"}
            </button>
          </form>
        </>
      )}

      {cloud.message && <p className={cloud.status === "error" || cloud.status === "auth" ? "warn-text sync-message" : "muted sync-message"} role="status" aria-live="polite">{cloud.message}</p>}
      {error && <p id={errorId} className="warn-text sync-message" role="alert">{error}</p>}
      <p className="muted sync-scope">同步学习进度和设置；跟读录音、离线包和外部接口设置保留在各自设备上。</p>
    </section>
  );
}
