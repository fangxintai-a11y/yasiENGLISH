import {
  buildDayPlan,
  selectLatestBaseline,
  todayInTimeZone,
  type DayBlock,
} from "./planEngine";
import { missionTaskId, selectMission } from "./missionRecords";
import { bundledRules } from "./planData";
import { latestAssessment, scoreView } from "./scoresModel";
import type { Revision } from "./protocol";
export interface PracticeContext {
  date: string;
  day: number;
  taskId: string;
  plannedMinutes: number;
  block: DayBlock | null;
  requiresFull: boolean;
}
export function resolvePracticeContext(
  plan: Revision,
  records: readonly Revision[],
  route: { date?: string; day?: number; task?: string },
  skill: "listening" | "reading",
  now = Date.now(),
): PracticeContext {
  const date =
    route.date ?? todayInTimeZone(now, String(plan.payload.timeZone));
  const scores = scoreView(
    latestAssessment(records, plan.id)?.payload ?? {},
  ).effectiveScores;
  const dayPlan = buildDayPlan(
    bundledRules,
    plan.payload,
    date,
    selectLatestBaseline(records, plan.id),
    { scores },
  );
  if (route.day !== undefined && route.day !== dayPlan.day)
    throw new Error("任务日期与计划日不一致，请从今日任务重新进入。");
  const selected = route.task
    ? dayPlan.blocks.find(
        (block) => missionTaskId(dayPlan.day, block.id) === route.task,
      )
    : dayPlan.blocks.find((block) => block.skill === skill);
  if (
    route.task &&
    (!selected ||
      (selected.skill !== skill &&
        !["timed-section", "weak-skill"].includes(selected.id)))
  )
    throw new Error("这不是当天的听读任务，请从今日任务重新进入。");
  if (!selected)
    return {
      date,
      day: dayPlan.day,
      taskId: "",
      plannedMinutes: 0,
      block: null,
      requiresFull: false,
    };
  const taskId = missionTaskId(dayPlan.day, selected.id);
  const mission = selectMission(records, plan.id, date, taskId);
  const plannedMinutes = Number(
    mission?.payload.plannedMinutes ?? selected.minutes,
  );
  return {
    date,
    day: dayPlan.day,
    taskId,
    plannedMinutes,
    requiresFull: plannedMinutes >= (skill === "reading" ? 60 : 30),
    block: { ...selected, skill, minutes: plannedMinutes },
  };
}
