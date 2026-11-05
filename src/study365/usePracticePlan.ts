import { useEffect, useState } from "react";
import { bundledRules } from "./planData";
import { todayInTimeZone } from "./planEngine";
import { createPlanPayload, PLAN_RECORD_ID, selectActivePlan, type PlanPort } from "./planRecords";
import { getLearningContextEpoch, getLearningState, saveRecord } from "./repository";
import type { Revision } from "./protocol";
import { useActivePlan } from "./useActivePlan";

export interface PracticePlanState {
  ready: boolean;
  userId: string | null;
  records: readonly Revision[];
  epoch: number;
}
export interface PracticePlanPort {
  read(): PracticePlanState;
  save(input: Parameters<PlanPort["save"]>[0], expectedUserId: string | null): Promise<Revision>;
}
const repositoryPort: PracticePlanPort = {
  read: () => ({ ...getLearningState(), epoch: getLearningContextEpoch() }),
  save: (input, expectedUserId) => saveRecord(input, expectedUserId),
};
const pendingByPort = new WeakMap<PracticePlanPort, Map<string, Promise<Revision>>>();

/** Four practice pages can open together; only a missing account-local plan is created. */
export function ensurePracticePlanToday(
  userId: string | null,
  port: PracticePlanPort = repositoryPort,
  now = Date.now(),
): Promise<Revision> {
  const initial = port.read();
  if (!initial.ready || initial.userId !== userId)
    return Promise.reject(new Error("账号已经切换，请在当前账号重新打开练习。"));
  const existing = selectActivePlan(initial.records);
  if (existing) return Promise.resolve(existing);
  let pending = pendingByPort.get(port);
  if (!pending) { pending = new Map(); pendingByPort.set(port, pending); }
  const key = JSON.stringify([userId, initial.epoch]);
  const shared = pending.get(key);
  if (shared) return shared;
  const operation = Promise.resolve().then(() => {
    const current = port.read();
    if (!current.ready || current.userId !== userId || current.epoch !== initial.epoch)
      throw new Error("账号已经切换，请在当前账号重新打开练习。");
    const found = selectActivePlan(current.records);
    if (found) return found;
    const timeZone = bundledRules.calendarPolicy.timeZone;
    return port.save({ id: PLAN_RECORD_ID, kind: "plan", baseRevision: null,
      payload: createPlanPayload({ startDate: todayInTimeZone(now, timeZone), timeZone, rules: bundledRules }),
    }, userId);
  }).finally(() => {
    if (pending.get(key) === operation) pending.delete(key);
  });
  pending.set(key, operation);
  return operation;
}

/** Practice entry prepares a plan; the homepage continues to use explicit plan setup. */
export function usePracticePlan() {
  const active = useActivePlan();
  const epoch = getLearningContextEpoch();
  const [creationError, setCreationError] = useState<{ userId: string | null; epoch: number; message: string } | null>(null);
  const currentError = creationError?.userId === active.learning.userId && creationError.epoch === epoch ? creationError.message : null;
  useEffect(() => {
    if (!active.learning.ready || active.plan) return;
    let alive = true;
    setCreationError(null);
    void ensurePracticePlanToday(active.learning.userId).catch(error => {
      if (alive) setCreationError({ userId: active.learning.userId, epoch,
        message: error instanceof Error ? error.message : "练习暂未准备好，请重新打开此页；已有记录保留。" });
    });
    return () => { alive = false; };
  }, [active.learning.ready, active.learning.userId, active.plan, epoch]);
  const creating = active.learning.ready && !active.plan && !currentError;
  return { ...active, error: active.error ?? currentError, creating };
}
