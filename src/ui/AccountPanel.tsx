import { LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { accountRequest } from "../account/api";
import "../styles/account.css";

type LoginSession = {
  id: string;
  device: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  current: boolean;
};

function ActivityTime({ value }: { value: number }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <>暂无记录</>;
  return <time dateTime={date.toISOString()}>{date.toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>;
}

/** Personal credentials and device sessions; account creation lives in SyncPanel. */
export function AccountPanel({ username }: { username: string }) {
  const id = useId();
  const [sessions, setSessions] = useState<LoginSession[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const sequence = useRef(0);
  const waiting = busy !== null || loading;
  const otherCount = sessions?.filter((session) => !session.current).length ?? 0;

  const loadSessions = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await accountRequest<{ sessions: LoginSession[] }>("GET", "/api/account/sessions");
      if (mounted.current && request === sequence.current) setSessions(result.sessions);
    } catch (e) {
      if (mounted.current && request === sequence.current) setError(e instanceof Error ? e.message : "暂时无法读取登录设备，请稍后重试。");
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadSessions();
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [loadSessions]);

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (waiting) return;
    setError("");
    setMessage("");
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致，请重新确认。");
      return;
    }
    if (newPassword === currentPassword) {
      setError("新密码需要与当前密码不同。");
      return;
    }
    setBusy("password");
    try {
      await accountRequest<{ ok: true }>("POST", "/api/account/password", { currentPassword, newPassword });
      if (!mounted.current) return;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setMessage("密码已修改。其他设备需要使用新密码重新登录。");
      await loadSessions();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "密码未修改，请稍后重试。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const revoke = async (sessionId?: string) => {
    if (waiting) return;
    setError("");
    setMessage("");
    setBusy(sessionId ? `session:${sessionId}` : "others");
    try {
      await accountRequest<{ ok: true }>("POST", sessionId ? "/api/account/sessions/revoke" : "/api/account/sessions/revoke-others", sessionId ? { id: sessionId } : {});
      if (!mounted.current) return;
      setMessage(sessionId ? "该设备已退出，下次使用需要重新登录。" : "其他设备已退出，当前设备保持登录。");
      await loadSessions();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "设备未退出，请稍后重试。");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const refresh = () => {
    if (waiting) return;
    setError("");
    void loadSessions();
  };

  return (
    <div className="account-panel" aria-busy={waiting}>
      <p className="account-username">当前账号 <b>{username}</b></p>
      <form className="account-password-form" onSubmit={(event) => void changePassword(event)} aria-labelledby={`${id}-password-heading`}>
        <h4 id={`${id}-password-heading`}>修改密码</h4>
        <label className="sync-field" htmlFor={`${id}-current-password`}>
          <span>当前密码</span>
          <input id={`${id}-current-password`} name="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" minLength={10} maxLength={256} required disabled={waiting} />
        </label>
        <label className="sync-field" htmlFor={`${id}-new-password`}>
          <span>新密码</span>
          <input id={`${id}-new-password`} name="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={10} maxLength={256} required disabled={waiting} aria-describedby={`${id}-password-hint`} />
          <small id={`${id}-password-hint`}>至少 10 位。修改后，其他设备需要重新登录。</small>
        </label>
        <label className="sync-field" htmlFor={`${id}-confirm-password`}>
          <span>再输入一次新密码</span>
          <input id={`${id}-confirm-password`} name="confirm-new-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={10} maxLength={256} required disabled={waiting} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={waiting}>
          <ShieldCheck size={17} aria-hidden="true" />{busy === "password" ? "修改中…" : "修改密码"}
        </button>
      </form>

      <div className="account-devices" aria-labelledby={`${id}-devices-heading`}>
        <div className="account-device-heading">
          <h4 id={`${id}-devices-heading`}>登录设备</h4>
          <button type="button" className="link account-refresh" onClick={refresh} disabled={waiting}>
            <RefreshCw size={14} className={loading ? "sync-spinning" : undefined} aria-hidden="true" />{loading ? "读取中…" : "刷新"}
          </button>
        </div>
        {sessions ? (
          sessions.length > 0 ? (
            <ul className="account-device-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <div className="account-device-info">
                    <p className="account-device-name"><b>{session.device || "未命名设备"}</b>{session.current && <span className="account-current-device">当前设备</span>}</p>
                    <p className="account-device-time">最近活动：<ActivityTime value={session.lastSeenAt} /></p>
                  </div>
                  {!session.current && (
                    <button type="button" className="btn btn-ghost account-revoke" disabled={waiting} onClick={() => void revoke(session.id)} aria-label={`退出 ${session.device || "未命名设备"}`}>
                      {busy === `session:${session.id}` ? "退出中…" : "退出"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : <p className="muted">暂无登录设备记录。</p>
        ) : <p className="muted" role="status">{loading ? "正在读取登录设备…" : "设备列表暂不可用，点击刷新重试。"}</p>}
        <button type="button" className="btn btn-ghost account-revoke-others" disabled={waiting || otherCount === 0} onClick={() => void revoke()}>
          <LogOut size={17} aria-hidden="true" />{busy === "others" ? "退出中…" : `退出其他设备${otherCount ? `（${otherCount}）` : ""}`}
        </button>
        <p className="muted account-device-note">退出后，该设备仍能离线学习，重新登录后才能同步。当前设备可在上方退出同步账号。</p>
      </div>

      {message && <p className="account-message" role="status" aria-live="polite">{message}</p>}
      {error && <p className="warn-text account-message" role="alert">{error}</p>}
    </div>
  );
}
