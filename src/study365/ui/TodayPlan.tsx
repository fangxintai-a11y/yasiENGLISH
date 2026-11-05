import { useEffect, useMemo, useRef, useState } from "react";
import { dayCompletion, editableDates, missionStreak, missionTaskId, selectMission } from "../missionRecords";
import { bundledInventory, bundledRules } from "../planData";
import { buildDayPlan, selectLatestBaseline, type DayPlan } from "../planEngine";
import { GATE_TARGETS, SECTION_TARGETS, type Revision } from "../protocol";
import type { LearningState } from "../repository";
import { useActivePlan } from "../useActivePlan";
import { MissionCard } from "./MissionCard";
import { PlanSetup } from "./PlanSetup";
import { TaskRegistration } from "./TaskRegistration";
import { pendingWritingHandoffs } from "../writingCalibration";
import { latestAssessment, scoreView } from "../scoresModel";
import { materialQualifiedRecords } from "../materialSource";
import { ExtensivePractice } from "./reading/ExtensivePractice";
import { startPlanToday } from "../planRecords";
import { getLearningState, saveRecord } from "../repository";
import { useDailyMaterialLibrary } from "../useDailyMaterialLibrary";
import { buildDailyMaterialPlan } from "../dailyMaterialPlan";

const weekdays: Record<string, string> = { monday: "一", tuesday: "二", wednesday: "三", thursday: "四", friday: "五", saturday: "六", sunday: "日" };

function ActiveTasks({ plan, today, learning }: { plan: Revision; today: DayPlan; learning: LearningState }) {
  const [selectedDate, setSelectedDate] = useState(today.date);
  const [registration, setRegistration] = useState<{ blockId: string; skill: DayPlan['blocks'][number]['skill']; date: string } | null>(null);
  const registrationRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (registration) registrationRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [registration]);
  const dates = editableDates(today.date, String(plan.payload.startDate));
  const date = dates.includes(selectedDate) ? selectedDate : today.date;
  const dayPlan = useMemo(() => date === today.date ? today : buildDayPlan(bundledRules, plan.payload, date, selectLatestBaseline(materialQualifiedRecords(learning.records, plan.id), plan.id), { scores: scoreView(latestAssessment(learning.records, plan.id)?.payload ?? {}, learning.records).effectiveScores }), [date, today, plan, learning.records]);
  const registrationBlock = registration?.date === date ? dayPlan.blocks.find(block => block.id === registration.blockId) : undefined;
  const completion = dayCompletion(learning.records, plan.id, date);
  const streak = missionStreak(learning.records, plan.id, today.date);
  const pendingReviews = pendingWritingHandoffs(learning.records, plan.id).length;
  const library = useDailyMaterialLibrary(learning.userId, plan.id);
  const automatic = useMemo(() => {
    if (!library.ready) return { value: null, error: "" };
    try { return { value: buildDailyMaterialPlan({ plan, records: learning.records, bank: library.bank, prompts: library.prompts,
      localWorks: library.localWorks, localMaterials: library.localMaterials, throughDay: dayPlan.day }), error: "" }; }
    catch (cause) { return { value: null, error: cause instanceof Error ? cause.message : "材料未能自动安排，请重新打开本页。" }; }
  }, [plan, learning.records, library.ready, library.bank, library.prompts, library.localWorks, library.localMaterials, dayPlan.day]);
  const assignments = automatic.value?.days.at(-1)?.blocks ?? [];
  const firstPending = dayPlan.blocks.find(block => !["completed", "skipped"].includes(String(selectMission(learning.records, plan.id, date, missionTaskId(dayPlan.day, block.id))?.payload.status ?? "not_started")));
  const next = assignments.find(item => item.taskId === (firstPending ? missionTaskId(dayPlan.day, firstPending.id) : ""));
  return <div className="study365-tasks">
    <label className="field"><span>今日与补记<small>可以补记前7天的状态和用时，不改首答与成绩。</small></span>
      <select aria-label="查看学习日期" value={date} onChange={event => { setSelectedDate(event.target.value); setRegistration(null); }}>
        {dates.map(value => <option key={value} value={value}>{value}{value === today.date ? " · 今天" : " · 补记"}</option>)}
      </select>
    </label>
    <h2>第 {dayPlan.day} 天 · {dayPlan.phaseTitle} · 星期{weekdays[dayPlan.weekday] ?? dayPlan.weekday}</h2>
    <p role="status">当天完成度 {Math.round(completion.ratio * 100)}%（{completion.completedMinutes}/{completion.totalMinutes}分钟） · {completion.status === "completed" ? "已完成" : completion.status === "partial" ? "部分完成" : "未开始"}</p>
    <progress aria-label="当天完成度" max={completion.totalMinutes} value={completion.completedMinutes} />
    <p className="muted">实际用时 {completion.actualMinutes} 分钟 · 连续达成80%：{streak}天</p>
    <section className="panel" aria-label="今天怎么学">
      <h3>{firstPending ? `今天先做：${firstPending.title}` : "今天的课程已完成"}</h3>
      <p>按下面编号依次做。题目和材料已由平台选择，不需要先去题库挑选。</p>
      {!library.ready && <p role="status">正在加载本机已有题库并安排今天的材料…</p>}
      {next?.route && <a className="btn btn-primary" href={next.route}>开始下一项任务</a>}
      {automatic.error && <p role="alert">{automatic.error}</p>}
      {library.issues.length > 0 && <details><summary>材料准备提示</summary><ul>{library.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
    </section>
    <section className="panel" aria-label="订正与复测入口"><h3>订正与复测</h3><p>待订正 {learning.records.filter(r => r.kind === 'correction' && r.planId === plan.id && !r.conflict).reduce((sum,r) => sum + (Array.isArray(r.payload.items) ? r.payload.items.filter(item => !!item && typeof item === 'object' && 'status' in item && item.status === 'open').length : 0), 0)} 项；订正使用当天已有复盘块，排不下的顺延。</p><a className="btn btn-ghost" href="#/review">打开订正与复测</a></section>
    {dayPlan.blocks.some(block => block.id === "human-calibration-handoff") && <section className="panel" aria-label="本周校准入口"><h3>本周校准与待决建议</h3><p>使用当天原有校准交付／登记15分钟，复核同稿偏差、错因与证据后逐条决定。</p><a className="btn btn-ghost" href="#/review?tab=weekly">查看本周校准</a></section>}
    {dayPlan.blocks.map((block, index) => <MissionCard key={`${learning.userId ?? "guest"}:${plan.id}:${date}:${block.id}`} plan={plan} dayPlan={dayPlan} block={block} index={index} userId={learning.userId} pendingWritingReviews={pendingReviews}
      assignment={assignments.find(item => item.taskId === missionTaskId(dayPlan.day, block.id))} materialLoading={!library.ready}
      mission={selectMission(learning.records, plan.id, date, missionTaskId(dayPlan.day, block.id))} onRegister={skill => setRegistration({ blockId: block.id, skill, date })} />)}
    <ExtensivePractice key={`${learning.userId ?? 'guest'}:${plan.id}:${date}`} plan={plan} dayPlan={dayPlan} userId={learning.userId} />
    {registrationBlock && registration && <div ref={registrationRef}><TaskRegistration key={`${learning.userId ?? 'guest'}:${plan.id}:${date}:${registrationBlock.id}:${registration.skill}`} plan={plan} dayPlan={dayPlan} block={registrationBlock} selectedSkill={registration.skill}
      mission={selectMission(learning.records, plan.id, date, missionTaskId(dayPlan.day, registrationBlock.id))} onClose={() => setRegistration(null)} /></div>}
  </div>;
}

export function TodayPlan() {
  const { learning, plan, dayPlan, error } = useActivePlan();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const beginToday = async () => {
    if (starting) return;
    setStarting(true); setStartError("");
    try {
      await startPlanToday({ records: () => {
        const current = getLearningState();
        if (!current.ready || current.userId !== learning.userId) throw new Error("账号已经切换，请在当前账号重新开始计划。");
        return current.records;
      }, save: input => saveRecord(input, learning.userId) });
    } catch (cause) { if (alive.current) setStartError(cause instanceof Error ? cause.message : "计划未能开始，请重试。"); }
    finally { if (alive.current) setStarting(false); }
  };
  if (!learning.ready) return <section className="panel" aria-label="365天学习计划"><p role="status">正在读取学习计划…</p></section>;
  if (!plan) return <PlanSetup key={learning.userId ?? "guest"} userId={learning.userId} />;
  const resources = bundledInventory.externalReferences.filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
  return <section className="panel study365-plan" aria-label="365天学习计划">
    <p className="eyebrow">365天学习计划</p>
    <h2>{String(plan.payload.title || "8.0 计划")}</h2>
    <p>目标总分 {GATE_TARGETS.G4.overall.toFixed(1)} · 听 {SECTION_TARGETS.listening.toFixed(1)} · 读 {SECTION_TARGETS.reading.toFixed(1)} · 写 {SECTION_TARGETS.writing.toFixed(1)} · 说 {SECTION_TARGETS.speaking.toFixed(1)}</p>
    <p className="muted">每天 {bundledRules.goal.dailyMinutes} 分钟 · 开始日期 {String(plan.payload.startDate)} · {String(plan.payload.timeZone)}</p>
    <nav aria-label="四科随时练" className="data-actions">
      {([["listening", "听力"], ["reading", "阅读"], ["writing", "写作"], ["speaking", "口语"]] as const).map(([skill, label]) =>
        <a key={skill} className="btn btn-ghost" href={`#/${skill}?mode=practice`}>{label}随时练</a>)}
    </nav>
    <p className="muted">四科随时开放，进入后自动选材；下方课表是今天的推荐安排。</p>
    {error && <p role="alert">{error}</p>}
    {dayPlan?.state === "before" && <>
      <p role="status">距计划开始倒数 {dayPlan.daysUntilStart} 天。</p>
      <p>原定 {String(plan.payload.startDate)} 开始。现在可以从今天开始第1天，平台将按训练节奏自动安排材料，原计划历史仍保留。</p>
      <button className="btn btn-primary" disabled={starting} onClick={() => void beginToday()}>{starting ? "正在开启今天的任务…" : "从今天开始，自动安排"}</button>
      {startError && <p role="alert">{startError}</p>}
      <h3>开始前准备</h3>
      <p>平台会优先使用已有的合法材料并保留独立检查题。四科现在也能从下方“随时练”进入，缺少材料时会明确提示。</p>
      <ul>{resources.map((resource) => <li key={resource.id}><a href={resource.url} target="_blank" rel="noreferrer">{resource.resourceTitle}</a><p className="muted">{resource.accessRequirement}</p></li>)}</ul>
    </>}
    {dayPlan?.state === "active" && <><p>今天按下方顺序学习，材料由平台自动安排；每7个训练日完成一轮，测评日随计划起点顺延。</p><ActiveTasks key={`${learning.userId ?? "guest"}:${plan.id}:${String(plan.payload.startDate)}`} plan={plan} today={dayPlan} learning={learning} /></>}
    {dayPlan?.state === "after" && <p role="status">365天计划日历已结束，学习记录将继续保留。是否达成目标以正式成绩为准。</p>}
  </section>;
}
