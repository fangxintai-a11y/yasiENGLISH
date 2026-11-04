import { useMemo, useState } from "react";
import { dayCompletion, editableDates, missionStreak, missionTaskId, selectMission } from "../missionRecords";
import { bundledInventory, bundledRules } from "../planData";
import { buildDayPlan, selectLatestBaseline, type DayPlan } from "../planEngine";
import { GATE_TARGETS, SECTION_TARGETS, type Revision } from "../protocol";
import type { LearningState } from "../repository";
import { useActivePlan } from "../useActivePlan";
import { MissionCard } from "./MissionCard";
import { PlanSetup } from "./PlanSetup";

const weekdays: Record<string, string> = { monday: "一", tuesday: "二", wednesday: "三", thursday: "四", friday: "五", saturday: "六", sunday: "日" };

function ActiveTasks({ plan, today, learning }: { plan: Revision; today: DayPlan; learning: LearningState }) {
  const [selectedDate, setSelectedDate] = useState(today.date);
  const dates = editableDates(today.date, String(plan.payload.startDate));
  const date = dates.includes(selectedDate) ? selectedDate : today.date;
  const dayPlan = useMemo(() => date === today.date ? today : buildDayPlan(bundledRules, plan.payload, date, selectLatestBaseline(learning.records, plan.id)), [date, today, plan, learning.records]);
  const completion = dayCompletion(learning.records, plan.id, date);
  const streak = missionStreak(learning.records, plan.id, today.date);
  return <div className="study365-tasks">
    <label className="field"><span>今日与补记<small>可以补记前7天的状态和用时，不改首答与成绩。</small></span>
      <select aria-label="查看学习日期" value={date} onChange={event => setSelectedDate(event.target.value)}>
        {dates.map(value => <option key={value} value={value}>{value}{value === today.date ? " · 今天" : " · 补记"}</option>)}
      </select>
    </label>
    <h2>第 {dayPlan.day} 天 · {dayPlan.phaseTitle} · 星期{weekdays[dayPlan.weekday] ?? dayPlan.weekday}</h2>
    <p role="status">当天完成度 {Math.round(completion.ratio * 100)}%（{completion.completedMinutes}/{completion.totalMinutes}分钟） · {completion.status === "completed" ? "已完成" : completion.status === "partial" ? "部分完成" : "未开始"}</p>
    <progress aria-label="当天完成度" max={completion.totalMinutes} value={completion.completedMinutes} />
    <p className="muted">实际用时 {completion.actualMinutes} 分钟 · 连续达成80%：{streak}天</p>
    {dayPlan.blocks.map((block, index) => <MissionCard key={`${learning.userId ?? "guest"}:${plan.id}:${date}:${block.id}`} plan={plan} dayPlan={dayPlan} block={block} index={index} userId={learning.userId}
      mission={selectMission(learning.records, plan.id, date, missionTaskId(dayPlan.day, block.id))} />)}
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
