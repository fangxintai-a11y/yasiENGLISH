import { useEffect, useRef, useState, type FormEvent } from "react";
import { bundledRules } from "../planData";
import { todayInTimeZone } from "../planEngine";
import { enablePlan } from "../planRecords";
import { GATE_TARGETS, SECTION_TARGETS } from "../protocol";
import { getLearningState, saveRecord } from "../repository";

export function PlanSetup({ userId }: { userId: string | null }) {
  const defaultZone = bundledRules.calendarPolicy.timeZone;
  const [timeZone, setTimeZone] = useState(defaultZone);
  const [startDate, setStartDate] = useState(() => todayInTimeZone(Date.now(), defaultZone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editedDate = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const changeZone = (zone: string) => {
    setTimeZone(zone);
    if (!editedDate.current) {
      try { setStartDate(todayInTimeZone(Date.now(), zone)); } catch { /* Validate the complete form on save. */ }
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await enablePlan({ startDate, timeZone, rules: bundledRules }, {
        records: () => {
          const state = getLearningState();
          if (!state.ready || state.userId !== userId) throw new Error("账号已经切换，请在当前账号重新开启计划。");
          return state.records;
        }, save: saveRecord,
      });
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : "暂时未能保存计划，请重试。");
    } finally { if (alive.current) setBusy(false); }
  };

  return <section className="panel" aria-label="开启 8.0 计划">
    <p className="eyebrow">365天学习计划</p>
    <h2>开启 {GATE_TARGETS.G4.overall.toFixed(1)} 计划</h2>
    <p>每天 {bundledRules.goal.dailyMinutes} 分钟，坚持 {bundledRules.goal.durationDays} 天。</p>
    <p>目标总分 {GATE_TARGETS.G4.overall.toFixed(1)}：听 {SECTION_TARGETS.listening.toFixed(1)} · 读 {SECTION_TARGETS.reading.toFixed(1)} · 写 {SECTION_TARGETS.writing.toFixed(1)} · 说 {SECTION_TARGETS.speaking.toFixed(1)}。</p>
    <form onSubmit={(event) => { void submit(event); }}>
      <label className="field"><span>开始日期<small>默认今天即可开始；训练按每7个计划日的节奏推进，不必等到周一。</small></span>
        <input aria-label="开始日期" type="date" required value={startDate} disabled={busy}
          onChange={(event) => { editedDate.current = true; setStartDate(event.target.value); }} />
      </label>
      <label className="field"><span>计划时区<small>按这个时区的日期安排每天任务。</small></span>
        <input aria-label="计划时区" required value={timeZone} disabled={busy} onChange={(event) => changeZone(event.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "正在保存计划…" : "开启 8.0 计划"}</button>
      <p className="muted">计划和学习记录保存在本机；登录同步账号后，可在手机和电脑继续。</p>
    </form>
  </section>;
}
