import { bundledRules } from "./planData";
import type { DayBlock } from "./planEngine";
import { isIdentifier, validatePayload, type LearningPayload, type Revision } from "./protocol";

export type MissionStatus = "not_started" | "in_progress" | "completed" | "partial" | "minimum" | "skipped";
export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  not_started: "未开始", in_progress: "进行中", completed: "已完成", partial: "部分完成", minimum: "最低练习量", skipped: "已跳过",
};
export function missionTaskId(day: number, blockId: string): string {
  if (!Number.isInteger(day) || day < 1 || day > bundledRules.goal.durationDays || !isIdentifier(blockId)) throw new Error("学习任务日期或标识无效。");
  return `d${day}-${blockId}`;
}
export async function missionRecordId(planId: string, day: number, blockId: string): Promise<string> {
  if (!isIdentifier(planId)) throw new Error("学习计划标识无效。");
  const bytes = new TextEncoder().encode(`${planId}\0${missionTaskId(day, blockId)}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `mission-${Array.from(hash, value => value.toString(16).padStart(2, "0")).join("")}`;
}
const newestFirst = (a: Revision, b: Revision) => b.createdAt - a.createdAt || b.seq - a.seq || b.revisionId.localeCompare(a.revisionId);
function currentMissions(records: readonly Revision[], planId: string): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(newestFirst)) if (!heads.has(record.id)) heads.set(record.id, record);
  const tasks = new Map<string, Revision>();
  for (const record of heads.values()) {
    if (record.kind !== "mission" || record.planId !== planId || record.deleted || record.conflict) continue;
    try { validatePayload("mission", record.payload); } catch { continue; }
    const key = `${record.payload.date}:${record.payload.taskId ?? record.payload.missionId}`;
    if (!tasks.has(key)) tasks.set(key, record);
  }
  return [...tasks.values()];
}
export function selectMission(records: readonly Revision[], planId: string, date: string, taskId: string): Revision | undefined {
  return currentMissions(records, planId).find(record => record.payload.date === date && (record.payload.taskId ?? record.payload.missionId) === taskId);
}
interface MissionInput {
  planId: string; day: number; date: string; block: DayBlock; status: MissionStatus;
  actualMinutes?: number; timeSource: "manual" | "timer"; expectedUserId?: string | null;
}
interface MissionPort {
  records(): readonly Revision[];
  save(input: { id: string; kind: "mission"; payload: LearningPayload }): Promise<Revision>;
}
export async function saveMission(input: MissionInput, suppliedPort?: MissionPort): Promise<Revision> {
  const port = suppliedPort ?? await (async (): Promise<MissionPort> => {
    const repository = await import("./repository");
    const checkAccount = () => {
      const state = repository.getLearningState();
      if (!state.ready || input.expectedUserId !== undefined && state.userId !== input.expectedUserId) throw new Error("账号已经切换，请在当前账号重新操作。");
      return state;
    };
    return { records: () => checkAccount().records, save: request => { checkAccount(); return repository.saveRecord(request); } };
  })();
  const taskId = missionTaskId(input.day, input.block.id);
  const existing = selectMission(port.records(), input.planId, input.date, taskId);
  const actualMinutes = input.actualMinutes ?? Number(existing?.payload.actualMinutes ?? 0);
  if (!Number.isFinite(actualMinutes) || actualMinutes < 0 || actualMinutes > 1440) throw new Error("实际分钟须在0至1440之间。");
  const payload: LearningPayload = { planId: input.planId, date: input.date, day: input.day, taskId,
    ...(input.block.skill === null ? {} : { skill: input.block.skill }), status: input.status,
    plannedMinutes: existing?.payload.plannedMinutes ?? input.block.minutes, actualMinutes, timeSource: input.timeSource };
  validatePayload("mission", payload);
  const id = existing?.id ?? await missionRecordId(input.planId, input.day, input.block.id);
  return port.save({ id, kind: "mission", payload });
}
function completionFromMissions(current: readonly Revision[], date: string) {
  const missions = current.filter(record => record.payload.date === date);
  const completedMinutes = missions.reduce((sum, record) => sum + (record.payload.status === "completed" ? Number(record.payload.plannedMinutes ?? 0) : 0), 0);
  const actualMinutes = missions.reduce((sum, record) => sum + Number(record.payload.actualMinutes ?? 0), 0);
  const totalMinutes = bundledRules.goal.dailyMinutes;
  const ratio = Math.min(1, completedMinutes / totalMinutes);
  const status = ratio >= 1 ? "completed" as const : missions.some(record => record.payload.status !== "not_started" || Number(record.payload.actualMinutes) > 0) ? "partial" as const : "not_started" as const;
  return { completedMinutes, actualMinutes, totalMinutes, ratio, status };
}
export function dayCompletion(records: readonly Revision[], planId: string, date: string) {
  return completionFromMissions(currentMissions(records, planId), date);
}
/** Reuse one exact head projection for a multi-day view; keep task and revision rules shared. */
export function missionProgress(records: readonly Revision[], planId: string, dates: readonly string[]) {
  const missions = currentMissions(records, planId);
  return {
    actualMinutes: missions.reduce((sum, record) => sum + Number(record.payload.actualMinutes ?? 0), 0),
    recentDays: dates.map(date => ({ date, ...completionFromMissions(missions, date) })),
  };
}
export function totalActualMinutes(records: readonly Revision[], planId: string): number {
  return currentMissions(records, planId).reduce((sum, record) => sum + Number(record.payload.actualMinutes ?? 0), 0);
}
function shiftDate(date: string, delta: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new Error("学习日期无效。");
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}
export function editableDates(today: string, startDate: string): string[] {
  return Array.from({ length: 8 }, (_, offset) => shiftDate(today, -offset)).filter(date => date >= startDate);
}
export function missionStreak(records: readonly Revision[], planId: string, today: string): number {
  let cursor = dayCompletion(records, planId, today).ratio >= .8 ? today : shiftDate(today, -1);
  let result = 0;
  while (result < bundledRules.goal.durationDays && dayCompletion(records, planId, cursor).ratio >= .8) {
    result++; cursor = shiftDate(cursor, -1);
  }
  return result;
}
