import { materialQualifiedRecords } from './materialSource';
import { useEffect, useMemo, useState } from "react";
import { bundledRules } from "./planData";
import { buildDayPlan, selectLatestBaseline, todayInTimeZone, type DayPlan } from "./planEngine";
import { selectActivePlan } from "./planRecords";
import { useLearning } from "./repository";
import { latestAssessment, scoreView } from "./scoresModel";

/** Repository state already belongs to exactly one current account or guest. */
export function useActivePlan() {
  const learning = useLearning();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const plan = useMemo(() => learning.ready ? selectActivePlan(learning.records) : null, [learning.ready, learning.records]);
  const result = useMemo<{ dayPlan: DayPlan | null; error: string | null }>(() => {
    if (!plan) return { dayPlan: null, error: null };
    try {
      const baseline = selectLatestBaseline(materialQualifiedRecords(learning.records, plan.id), plan.id);
      const today = todayInTimeZone(now, String(plan.payload.timeZone));
      const scores = scoreView(latestAssessment(learning.records, plan.id)?.payload ?? {}, learning.records).effectiveScores;
      return { dayPlan: buildDayPlan(bundledRules, plan.payload, today, baseline, { scores }), error: null };
    } catch (error) {
      return { dayPlan: null, error: `暂时无法显示此计划：${error instanceof Error ? error.message : "请检查计划日期与时区。"}历史记录已保留。` };
    }
  }, [learning.records, plan, now]);
  return { learning, plan, ...result };
}
