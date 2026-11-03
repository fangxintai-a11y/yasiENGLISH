import { useEffect, useState } from "react";
import { exportRecordings, importRecordings, listRecordingBackups, useLearning, type RecordingBackupInfo } from "../repository";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function RecordingsBackup() {
  const learning = useLearning();
  const [items, setItems] = useState<RecordingBackupInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setItems([]); setSelected(new Set());
    if (learning.ready) void listRecordingBackups().then((records) => {
      if (!active) return;
      records.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      setItems(records); setSelected(new Set(records.map((item) => item.recordingId)));
    }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "暂时无法读取录音。"); });
    return () => { active = false; };
  }, [learning.ready, learning.userId, learning.recordingsVersion, reload]);
  useEffect(() => { setMessage(null); }, [learning.ready, learning.userId]);

  if (!learning.ready) return learning.error ? <section className="panel" aria-label="学习录音备份">
    <h3 className="eyebrow">学习录音备份</h3><p role="status">{learning.error} 原有数据未被清除。</p>
  </section> : null;
  const day = today(), date = new Date(`${day}T00:00:00Z`);
  const monday = new Date(date); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const hasCalibration = date.getUTCDay() === 0 && learning.records.some((record) => record.kind === "assessment"
    && record.payload.kind === "weekly-calibration" && record.payload.source === "human"
    && typeof record.payload.date === "string" && record.payload.date >= monday.toISOString().slice(0, 10) && record.payload.date <= day);
  const selectedBytes = items.filter((item) => selected.has(item.recordingId)).reduce((sum, item) => sum + item.bytes, 0);
  const download = async () => {
    setBusy(true); setMessage(null);
    try {
      const blob = await exportRecordings([...selected]);
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `bandgalaxy-recordings-${day}.zip`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("录音ZIP已生成。请确认文件已保存；它包含原始音频和题目、转写清单。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "未能导出，原录音仍保存在本机。"); }
    finally { setBusy(false); }
  };
  const restore = async (file: File) => {
    setBusy(true); setMessage(null);
    try {
      const result = await importRecordings(file);
      setReload((value) => value + 1);
      setMessage(`已恢复 ${result.imported} 段录音，跳过 ${result.duplicate} 段相同录音。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "导入失败，原录音未被覆盖。"); }
    finally { setBusy(false); }
  };
  return <section className="panel" aria-label="学习录音备份">
    <h3 className="eyebrow">学习录音备份</h3>
    <p className="muted">{learning.userId ? "当前账号" : "访客"}在这台设备保存了 {items.length} 段录音。录音不会随文字同步，请自行保存ZIP备份；导入只恢复到本机，不上传音频。</p>
    {hasCalibration && items.length > 0 && <p role="status">本周已有真人校准记录。今天是周日，建议把录音导出备份。</p>}
    {items.length > 0 && <details>
      <summary>选择要备份的录音（已选 {selected.size} 段，{size(selectedBytes)}）</summary>
      <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(new Set(items.map((item) => item.recordingId)))}>全选录音</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => setSelected(new Set())}>清空选择</button>
      <ul className="muted">{items.map((item) => <li key={item.recordingId}>
        <label><input type="checkbox" disabled={busy} checked={selected.has(item.recordingId)} onChange={() => setSelected((current) => {
          const next = new Set(current); next.has(item.recordingId) ? next.delete(item.recordingId) : next.add(item.recordingId); return next;
        })} /> {item.date ?? "日期未知"} · {item.prompt.slice(0, 70) || item.recordingId} · {size(item.bytes)}</label>
      </li>)}</ul>
    </details>}
    <div className="data-actions">
      <button className="btn btn-ghost" disabled={busy || !selected.size} onClick={() => { void download(); }}>导出录音ZIP</button>
      <label className="btn btn-ghost">导入录音ZIP<input aria-label="选择录音ZIP备份" type="file" accept=".zip,application/zip" disabled={busy} hidden onChange={(event) => {
        const input = event.currentTarget, file = input.files?.[0];
        if (file) void restore(file).finally(() => { input.value = ""; });
      }} /></label>
    </div>
    <p className="muted">单段最多50 MB，每个ZIP最多256 MB；录音较多时可分批选择。相同ID且音频不同会拒绝导入，不覆盖原件。</p>
    {message && <p className="muted" role="status">{message}</p>}
  </section>;
}
