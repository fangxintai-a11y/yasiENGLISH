import { missionTaskId, selectMission } from "./missionRecords";
import type { DayPlan } from "./planEngine";
import type { Revision } from "./protocol";

/** Corrections consume an existing review block. They never create or borrow minutes. */
export function reviewBudget(
  dayPlan: DayPlan,
  records: readonly Revision[],
  planId: string,
) {
  const block =
    dayPlan.state === "active"
      ? (dayPlan.blocks.find((item) => item.id === "review") ?? null)
      : null;
  const taskId = block ? missionTaskId(dayPlan.day, block.id) : "";
  const used = block
    ? Number(
        selectMission(records, planId, dayPlan.date, taskId)?.payload
          .actualMinutes ?? 0,
      )
    : 0;
  return {
    block,
    taskId,
    minutes: block?.minutes ?? 0,
    used,
    remaining: Math.max(0, (block?.minutes ?? 0) - used),
    canStart: !!block && used < block.minutes,
  };
}
