import { useEffect, useRef, useState } from "react";
import { MISSION_STATUS_LABELS, missionTaskId, saveMission, type MissionStatus } from "../missionRecords";
import type { DayBlock, DayPlan } from "../planEngine";
import type { Revision } from "../protocol";
import { taskTitle } from "../taskGuides";
import type { BlockMaterialAssignment } from "../dailyMaterialPlan";

const skills = { listening: "听力", reading: "阅读", writing: "写作", speaking: "口语" };

export function MissionCard({ plan, dayPlan, block, mission, userId, index, onRegister, pendingWritingReviews = 0, assignment, materialLoading = false }: {
  plan: Revision; dayPlan: DayPlan; block: DayBlock; mission?: Revision; userId: string | null; index: number; onRegister?: (skill: DayBlock['skill']) => void; pendingWritingReviews?: number;
  assignment?: BlockMaterialAssignment; materialLoading?: boolean;
}) {
  const [actual, setActual] = useState(String(mission?.payload.actualMinutes ?? 0));
  const [skill, setSkill] = useState(assignment?.skill ?? block.skill);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setActual(String(mission?.payload.actualMinutes ?? 0));
    setSkill(typeof mission?.payload.skill === "string" && Object.hasOwn(skills, mission.payload.skill) ? mission.payload.skill as keyof typeof skills : assignment?.skill ?? block.skill);
  }, [mission?.revisionId, block.skill, assignment?.skill]);
  const status = (mission?.payload.status ?? "not_started") as MissionStatus;
  const planned = Number(mission?.payload.plannedMinutes ?? block.minutes);
  const title = taskTitle(block.id, skill);
  const save = async (status: MissionStatus) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await saveMission({ planId: plan.id, day: dayPlan.day, date: dayPlan.date, block: { ...block, skill },
        status, actualMinutes: actual.trim() === "" ? NaN : Number(actual), timeSource: "manual", expectedUserId: userId });
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : "任务暂时未能保存，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  };
  const material = block.material;
  const courseSkill = assignment?.skill ?? block.skill;
  const courseLabel = courseSkill && Object.hasOwn(skills, courseSkill) ? skills[courseSkill as keyof typeof skills] : courseSkill === "vocabulary" ? "词汇" : "复盘";
  const needsMaterial = !!courseSkill && Object.hasOwn(skills, courseSkill);
  const fallbackRoute = !needsMaterial ? block.route ?? (block.id.includes("review") || block.id.includes("calibration") ? "#/review" : null) : null;
  const primaryRoute = assignment?.route ?? fallbackRoute;
  const gapRoute = needsMaterial && !primaryRoute && !materialLoading
    ? `#/${courseSkill}?${new URLSearchParams({ date: dayPlan.date, day: String(dayPlan.day), task: missionTaskId(dayPlan.day, block.id), minutes: String(planned) })}` : null;
  return <article className="study365-task" aria-label={`任务 ${title}`} data-task-id={missionTaskId(dayPlan.day, block.id)}>
    <h3>{index + 1}. {title} · {planned} 分钟</h3>
    <p>{block.guide}</p>
    {needsMaterial && materialLoading && <p role="status">平台正在安排本节{courseLabel}材料…</p>}
    {assignment && needsMaterial && <section aria-label="平台安排的材料" data-material-status={assignment.status}>
      <h4>{assignment.status === "missing" ? "本节材料待补齐" : assignment.status === "partial" ? "本节材料 · 部分待补齐" : "本节材料 · 已自动安排"}</h4>
      {assignment.materials.length > 0 && <ol>{assignment.materials.map(item => <li key={`${item.id}:${item.version}:${item.contentHash}`}>
        <strong>{item.title}</strong>{item.completed ? " · 已完成" : item.role === "assessment" ? " · 测评" : item.role === "calibration" ? " · 题型热身" : ""}
      </li>)}</ol>}
      {assignment.notice && <p className="muted">{assignment.notice}</p>}
    </section>}
    {primaryRoute && (!needsMaterial || !materialLoading) ? <p><a className="btn btn-primary" href={primaryRoute}>
      {assignment?.materials.length && assignment.materials.every(item => item.completed) ? `查看本节${courseLabel}` : `开始本节${courseLabel}`}
    </a></p> : needsMaterial && !materialLoading && <p role="status">本节材料待补齐，平台保留这项任务，不用旧题充数。</p>}
    {gapRoute && <p><a className="btn btn-ghost" href={gapRoute}>查看本节材料缺口</a></p>}
    {block.id === "human-calibration-handoff" && pendingWritingReviews > 0 && <p role="status">写作待评阅：{pendingWritingReviews}篇 · <a href="#/writing">查看交出的作品</a></p>}
    {material && <details className="study365-material">
      <summary>材料与准备：{material.title}</summary>
      {material.materials.length > 0 && <ul>{material.materials.map(item => <li key={item.id}>{item.title} <small>（自编材料 · 待人工审校）</small></li>)}</ul>}
      {material.externalReferences.length > 0 && <ul>{material.externalReferences.map(item => <li key={item.id}>
        <a href={item.url} target="_blank" rel="noreferrer">{item.resourceTitle} · {item.resourceLocator}</a>
        <p className="muted">{item.accessRequirement}</p>
        <a href={item.formatPracticeUrl} target="_blank" rel="noreferrer">官方题型练习入口</a>
      </li>)}</ul>}
      {material.missingRequirements.length > 0 && <><p>仍需准备：</p><ul>{material.missingRequirements.map(item => <li key={item}>{item}</li>)}</ul></>}
      {!material.materials.length && !material.externalReferences.length && <p>外部材料：请使用合法取得、适合当天任务的练习材料。</p>}
    </details>}
    <p>{block.route ? <a className="btn btn-ghost" href={block.route}>进入词汇学习</a> :
      <button type="button" className="btn btn-ghost" onClick={() => onRegister ? onRegister(skill) : input.current?.focus()}>外部完成后登记</button>}</p>
    {["timed-section", "weak-skill"].includes(block.id) && <label className="field"><span>练习科目</span>
      <select aria-label={`${title}练习科目`} disabled={busy} value={skill ?? "writing"} onChange={event => setSkill(event.target.value as keyof typeof skills)}>
        {Object.entries(skills).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>}
    <p role="status">状态：{MISSION_STATUS_LABELS[status]}</p>
    <p className="muted">以下用于外部练习或手动补记；在App内完成作答后，会保存对应进度。</p>
    <label className="field"><span>实际分钟<small>填真实用时；点击完成不会自动计入计划分钟。</small></span>
      <input ref={input} aria-label={`${title}实际分钟`} type="number" min="0" max="1440" step="0.5" value={actual} disabled={busy} onChange={event => setActual(event.target.value)} />
    </label>
    <div className="data-actions">
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { void save("in_progress"); }}>开始</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void save("completed"); }}>完成</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { void save("partial"); }}>部分完成</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { void save("skipped"); }}>跳过</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { void save(status); }}>保存用时</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </article>;
}
