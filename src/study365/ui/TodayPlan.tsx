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
    <section className="panel" aria-label="订正与复测入口"><h3>订正与复测</h3><p>待订正 {learning.records.filter(r => r.kind === 'correction' && r.planId === plan.id && !r.conflict).reduce((sum,r) => sum + (Array.isArray(r.payload.items) ? r.payload.items.filter(item => !!item && typeof item === 'object' && 'status' in item && item.status === 'open').length : 0), 0)} 项；订正使用当天已有复盘块，排不下的顺延。</p><a className="btn btn-ghost" href="#/review">打开订正与复测</a></section>
    {dayPlan.blocks.some(block => block.id === "human-calibration-handoff") && <section className="panel" aria-label="本周校准入口"><h3>本周校准与待决建议</h3><p>使用当天原有校准交付／登记15分钟，复核同稿偏差、错因与证据后逐条决定。</p><a className="btn btn-ghost" href="#/review?tab=weekly">查看本周校准</a></section>}
    {dayPlan.blocks.map((block, index) => <MissionCard key={`${learning.userId ?? "guest"}:${plan.id}:${date}:${block.id}`} plan={plan} dayPlan={dayPlan} block={block} index={index} userId={learning.userId} pendingWritingReviews={pendingReviews}
      mission={selectMission(learning.records, plan.id, date, missionTaskId(dayPlan.day, block.id))} onRegister={skill => setRegistration({ blockId: block.id, skill, date })} />)}
    <ExtensivePractice key={`${learning.userId ?? 'guest'}:${plan.id}:${date}`} plan={plan} dayPlan={dayPlan} userId={learning.userId} />
    {registrationBlock && registration && <div ref={registrationRef}><TaskRegistration key={`${learning.userId ?? 'guest'}:${plan.id}:${date}:${registrationBlock.id}:${registration.skill}`} plan={plan} dayPlan={dayPlan} block={registrationBlock} selectedSkill={registration.skill}
      mission={selectMission(learning.records, plan.id, date, missionTaskId(dayPlan.day, registrationBlock.id))} onClose={() => setRegistration(null)} /></div>}
  </div>;
}

export function TodayPlan() {
  const { learning, plan, dayPlan, error } = useActivePlan();
  if (!learning.ready) return <section className="panel" aria-label="365天学习计划"><p role="status">正在读取学习计划…</p></section>;
  if (!plan) return <PlanSetup key={learning.userId ?? "guest"} userId={learning.userId} />;
  const resources = bundledInventory.externalReferences.filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
  return <section className="panel study365-plan" aria-label="365天学习计划">
    <p className="eyebrow">365天学习计划</p>
    <h2>{String(plan.payload.title || "8.0 计划")}</h2>
    <p>目标总分 {GATE_TARGETS.G4.overall.toFixed(1)} · 听 {SECTION_TARGETS.listening.toFixed(1)} · 读 {SECTION_TARGETS.reading.toFixed(1)} · 写 {SECTION_TARGETS.writing.toFixed(1)} · 说 {SECTION_TARGETS.speaking.toFixed(1)}</p>
    <p className="muted">每天 {bundledRules.goal.dailyMinutes} 分钟 · 开始日期 {String(plan.payload.startDate)} · {String(plan.payload.timeZone)}</p>
    {error && <p role="alert">{error}</p>}
    {dayPlan?.state === "before" && <>
      <p role="status">距计划开始倒数 {dayPlan.daysUntilStart} 天。</p>
      <h3>开始前准备</h3>
      <p>准备合法购买或借阅的剑桥雅思 20 或同等完整真题，确认选中的整套题没有做过；已做过就另选未见材料。</p>
      <ul>{resources.map((resource) => <li key={resource.id}><a href={resource.url} target="_blank" rel="noreferrer">{resource.resourceTitle}</a><p className="muted">{resource.accessRequirement}</p></li>)}</ul>
    </>}
    {dayPlan?.state === "active" && <ActiveTasks key={`${learning.userId ?? "guest"}:${plan.id}`} plan={plan} today={dayPlan} learning={learning} />}
    {dayPlan?.state === "after" && <p role="status">365天计划日历已结束，学习记录将继续保留。是否达成目标以正式成绩为准。</p>}
  </section>;
}
