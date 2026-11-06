import { correctionContextBlock } from "./correctionContext";
import { materialQualifiedRecords } from "./materialSource";
import { dayDate } from "./calendar";
import samples from "../../public/curriculum365/v1/samples.json";
import { MaterialSchema, type Material } from "./contentSchemas";
import { bundledInventory, bundledRules } from "./planData";
import {
  buildDayPlan,
  selectLatestBaseline,
  todayInTimeZone,
  type DayBlock,
} from "./planEngine";
import { missionTaskId, selectMission } from "./missionRecords";
import { latestAssessment, scoreView } from "./scoresModel";
import type { Revision } from "./protocol";

export type WritingMaterial = Extract<Material, { skill: "writing" }>;
export type WritingMode = "task1" | "task2" | "paragraph" | "pair";
export interface WritingContext {
  date: string;
  day: number;
  taskId: string;
  mode?: "practice" | "course";
  correctionId?: string;
  retestOf?: string;
  plannedMinutes: number;
  block: DayBlock | null;
  defaultMode: WritingMode;
}
export const WRITING_OUTLINE_HINTS = {
  task1: [
    "一句话概括最明显的总体特征。",
    "找出两组值得比较的数据。",
    "只描述图表信息，核对单位和时间。",
  ],
  task2: [
    "先写清你对题目的立场。",
    "列出两个分论点，每点用一个例子支持。",
    "检查有没有回答题目的每一问。",
  ],
} as const;
const materials: WritingMaterial[] = samples.materials
  .filter((item) => item.skill === "writing")
  .map((item) => MaterialSchema.parse(item))
  .filter((item): item is WritingMaterial => item.skill === "writing");
export function availableWritingMaterials(day: number): WritingMaterial[] {
  const ids: readonly string[] =
    bundledInventory.days.find((item) => item.day === day)?.materialIds ?? [];
  return materials.filter((item) => ids.includes(item.id));
}
export function defaultWritingMode(minutes: number): WritingMode {
  return minutes >= 60
    ? "pair"
    : minutes >= 40
      ? "task2"
      : minutes <= 20
        ? "task1"
        : "paragraph";
}
/** A route carries context; the plan and saved mission own its date and budget. */
export function resolveWritingContext(
  plan: Revision,
  records: readonly Revision[],
  route: {
    date?: string;
    day?: number;
    task?: string;
    minutes?: number;
    correctionId?: string;
    retestOf?: string;
    work?: string;
    mode?: "practice";
  },
  now = Date.now(),
): WritingContext {
  if (
    route.mode === "practice" ||
    route.task?.startsWith("practice-writing-") ||
    (!route.task && !route.retestOf && !route.correctionId)
  ) {
    const timeZone = String(
      plan.payload.timeZone ?? bundledRules.calendarPolicy.timeZone,
    );
    if (route.date) dayDate(route.date, timeZone, 1);
    const date = todayInTimeZone(now, timeZone);
    const dayPlan = buildDayPlan(bundledRules, plan.payload, date);
    return {
      date,
      day: dayPlan.day,
      taskId: `practice-writing-${date}`,
      mode: "practice",
      plannedMinutes: 40,
      defaultMode: "task2",
      block: {
        id: "practice-writing",
        title: "自主写作练习",
        skill: "writing",
        minutes: 40,
        guide: "40分钟仅作参考；可随时开始、暂停和保存，不完成课程任务。",
      },
    };
  }
  const date =
    route.date ?? todayInTimeZone(now, String(plan.payload.timeZone));
  const scores = scoreView(
    latestAssessment(records, plan.id)?.payload ?? {},
    records,
  ).effectiveScores;
  const dayPlan = buildDayPlan(
    bundledRules,
    plan.payload,
    date,
    selectLatestBaseline(materialQualifiedRecords(records, plan.id), plan.id),
    { scores },
  );
  if (route.day !== undefined && route.day !== dayPlan.day)
    throw new Error("写作任务日期与计划日不一致，请从今日任务重新进入。");
  const correctionBlock = correctionContextBlock(
    plan,
    records,
    dayPlan,
    route,
    "writing",
  );
  const selected =
    correctionBlock ??
    (route.task
      ? dayPlan.blocks.find(
          (block) => missionTaskId(dayPlan.day, block.id) === route.task,
        )
      : dayPlan.blocks.find((block) => block.skill === "writing"));
  if (
    !correctionBlock &&
    route.task &&
    (!selected ||
      (selected.skill !== "writing" &&
        !["timed-section", "weak-skill"].includes(selected.id)))
  )
    throw new Error("这不是当天的写作任务，请从今日任务重新进入。");
  if (!selected)
    return {
      date,
      day: dayPlan.day,
      taskId: "",
      plannedMinutes: 0,
      block: null,
      defaultMode: "task1",
    };
  const taskId = missionTaskId(dayPlan.day, selected.id);
  const saved = selectMission(records, plan.id, date, taskId);
  const plannedMinutes = Number(
    saved?.payload.plannedMinutes ?? selected.minutes,
  );
  return {
    date,
    day: dayPlan.day,
    taskId,
    mode: "course",
    plannedMinutes,
    correctionId: route.correctionId,
    retestOf: route.retestOf,
    block: correctionBlock
      ? { ...selected, minutes: plannedMinutes }
      : { ...selected, skill: "writing", minutes: plannedMinutes },
    defaultMode: defaultWritingMode(plannedMinutes),
  };
}
export function externalWritingId(date: string, sequence: number): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isInteger(sequence) ||
    sequence < 1
  )
    throw new Error("外部题标识无效。");
  return `external-${date}-${sequence}`;
}
