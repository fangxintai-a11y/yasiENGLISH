import { bundledInventory, bundledRules } from "../planData";
import { GATE_TARGETS, SECTION_TARGETS } from "../protocol";
import { useActivePlan } from "../useActivePlan";
import { PlanSetup } from "./PlanSetup";

export function TodayPlan() {
  const { learning, plan, dayPlan, error } = useActivePlan();
  if (!learning.ready) return <section className="panel" aria-label="365天学习计划"><p role="status">正在读取学习计划…</p></section>;
  if (!plan) return <PlanSetup key={learning.userId ?? "guest"} userId={learning.userId} />;
  const resources = bundledInventory.externalReferences.filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
  return <section className="panel" aria-label="365天学习计划">
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
    {dayPlan?.state === "active" && <p role="status">第 {dayPlan.day} 天 · {dayPlan.phaseTitle} · 计划已开启。</p>}
    {dayPlan?.state === "after" && <p role="status">365天计划日历已结束，学习记录将继续保留。是否达成目标以正式成绩为准。</p>}
  </section>;
}
