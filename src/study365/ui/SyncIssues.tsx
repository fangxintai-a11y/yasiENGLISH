import { useEffect, useState } from "react";
import type { QuarantinedMutation } from "../protocol";
import { exportSyncIssues, getSyncIssues, retrySyncIssues, useLearning } from "../repository";

const titles: Record<string, string> = {
  plan: "学习计划", mission: "学习任务", attempt: "练习记录", essay: "作文", speaking: "口语记录", feedback: "反馈", assessment: "测评记录",
};

/** Failed writes remain available for retry/export instead of blocking unrelated work. */
export function SyncIssues() {
  const learning = useLearning();
  const [issues, setIssues] = useState<QuarantinedMutation[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIssues([]);
    setMessage(null);
    if (learning.ready && learning.quarantined) {
      void getSyncIssues().then((items) => { if (active) setIssues(items); })
        .catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "未能读取待处理记录。"); });
    }
    return () => { active = false; };
  }, [learning.ready, learning.userId, learning.quarantined, learning.pending, learning.syncStatus]);

  if (!learning.ready || !learning.quarantined) return null;

  const retry = async () => {
    setBusy(true); setMessage(null);
    try {
      await retrySyncIssues();
      setMessage("已重新尝试同步；仍未成功的记录会继续保留。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "暂时未能重试，请先导出原文。"); }
    finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true); setMessage(null);
    try {
      const blob = await exportSyncIssues();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bandgalaxy-unsynced-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setMessage(error instanceof Error ? error.message : "未能导出，原文仍保存在本机。"); }
    finally { setBusy(false); }
  };

  return <section className="panel" aria-label="未能同步的学习记录">
    <h3 className="eyebrow">学习记录同步</h3>
    <p role="status">有 {learning.quarantined} 条记录未能同步，原文已保存在本机。其他记录可以继续同步。</p>
    {issues.length > 0 && <ul className="muted">
      {issues.slice(0, 5).map((item) => <li key={item.body.mutationId}>
        {titles[item.body.kind] ?? "学习记录"}：{item.error}
      </li>)}
      {issues.length > 5 && <li>另有 {issues.length - 5} 条，导出备份中包含全部原文与错误说明。</li>}
    </ul>}
    <div className="data-actions">
      <button className="btn btn-ghost" disabled={busy} onClick={() => { void retry(); }}>重试同步</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => { void download(); }}>导出未同步原文</button>
    </div>
    {message && <p className="muted" role="status">{message}</p>}
  </section>;
}
