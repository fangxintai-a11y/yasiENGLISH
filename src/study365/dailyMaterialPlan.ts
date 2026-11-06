import { dayDate } from "./calendar";
import { bundledRules, type PlanRules } from "./planData";
import {
  buildDayPlan,
  selectLatestBaseline,
  type DayPlan,
  type DayBlock,
} from "./planEngine";
import type { LocalMaterial } from "./localBankSchema";
import type { LocalPrompt } from "./promptBankSchema";
import type { Revision } from "./protocol";
import { missionTaskId } from "./missionRecords";
import { materialQualifiedRecords } from "./materialSource";
import { latestAssessment, scoreView } from "./scoresModel";
import {
  buildListeningReadingSchedule,
  selectReadingForDay,
} from "./listeningReadingSchedule";
import { isListeningSequenceMaterial } from "./listeningSequence";
import {
  ladderNotice,
  listeningSectionForDay,
  preferSection,
  sectionDistance,
} from "./listeningLadder";
import { isHeldOutListeningReading } from "./retestSelection";
import { acceptedMaterialPreferences } from "./weeklyReview";
import { completedListeningReadingReview } from "./correctionModel";
import {
  promptKey,
  createPromptSelectionContext,
  selectScheduledWritingPrompts,
  selectScheduledSpeakingPrompts,
  type PromptWorkReference,
} from "./promptWorkSelection";

export interface CheckpointCycle {
  listening: number;
  reading: number;
  writing?: number;
  speaking?: number;
}
let defaultCycles: CheckpointCycle[] | undefined;
function checkpointCycles(
  days: readonly DayPlan[],
  rules: PlanRules,
): CheckpointCycle[] {
  const full = days.filter(
    (day) =>
      day.blocks.some(
        (block) => block.skill === "listening" && block.minutes >= 30,
      ) &&
      day.blocks.some(
        (block) => block.skill === "reading" && block.minutes >= 60,
      ),
  );
  const chosen = new Set<number>();
  if (full[0]) chosen.add(full[0].day);
  for (const gate of rules.gates) {
    if (typeof gate.atMonth !== "number") continue;
    const target = gate.atMonth * 30;
    let anchor =
      full.filter((day) => day.day <= target).at(-1) ??
      full.find((day) => day.day >= target);
    if (!anchor) continue;
    chosen.add(anchor.day);
    for (let index = 1; index < gate.consecutive; index++) {
      anchor = full.find((day) => day.day > anchor!.day);
      if (!anchor) break;
      chosen.add(anchor.day);
    }
  }
  const weekly = full.filter((day) => day.day % 7 === 6);
  for (const offset of [14, 7, 0]) {
    const anchor = weekly
      .filter((day) => day.day <= rules.goal.durationDays - offset)
      .at(-1);
    if (anchor) chosen.add(anchor.day);
  }
  return [...chosen]
    .sort((a, b) => a - b)
    .map((day) => ({
      listening: day,
      reading: day,
      writing: days.find(
        (value) =>
          value.day >= day &&
          value.day <= day + 3 &&
          value.blocks.some(
            (block) => block.skill === "writing" && block.minutes >= 60,
          ),
      )?.day,
      speaking: days.find(
        (value) =>
          value.day >= day &&
          value.day <= day + 3 &&
          value.blocks.some(
            (block) => block.skill === "speaking" && block.minutes >= 15,
          ),
      )?.day,
    }));
}
export function automaticCheckpointCycles(
  rules: PlanRules = bundledRules,
): readonly CheckpointCycle[] {
  if (rules === bundledRules && defaultCycles) return defaultCycles;
  const payload = {
    startDate: "2026-11-09",
    timeZone: rules.calendarPolicy.timeZone,
  };
  const days = Array.from({ length: rules.goal.durationDays }, (_, index) =>
    buildDayPlan(
      rules,
      payload,
      dayDate(String(payload.startDate), payload.timeZone, index + 1),
    ),
  );
  const value = checkpointCycles(days, rules);
  if (rules === bundledRules) defaultCycles = value;
  return value;
}
/** Baseline writing/speaking uses unseen practice; later independent checkpoints use holdouts. */
export function promptPoolForDay(
  day: number,
  skill: "writing" | "speaking",
  rules: PlanRules = bundledRules,
): "practice" | "holdout" {
  return automaticCheckpointCycles(rules).some(
    (cycle) => cycle.listening !== 1 && cycle[skill] === day,
  )
    ? "holdout"
    : "practice";
}

export type AssignedSkill = "listening" | "reading" | "writing" | "speaking";
export interface AssignedMaterial {
  kind: "listening-reading" | "prompt";
  skill: AssignedSkill;
  id: string;
  version: string;
  contentHash: string;
  title: string;
  sourceRef: string;
  role: "practice" | "calibration" | "assessment";
  pool: "practice" | "holdout";
  scope?: LocalMaterial["scope"];
  taskType?: "task1" | "task2";
  part?: 1 | 2 | 3;
  route: string;
  workId?: string;
  completed: boolean;
}
export interface BlockMaterialAssignment {
  day: number;
  date: string;
  taskId: string;
  blockId: string;
  skill: DayBlock["skill"];
  minutes: number;
  status: "assigned" | "partial" | "missing" | "not-required";
  materials: AssignedMaterial[];
  route: string | null;
  notice: string;
  checkpoint: boolean;
}
export interface AutomaticMaterialDay {
  day: number;
  date: string;
  phaseId: DayPlan["phaseId"];
  totalMinutes: number;
  blocks: BlockMaterialAssignment[];
}
export interface DailyMaterialPlanInput {
  plan: Revision;
  records: readonly Revision[];
  bank: readonly LocalMaterial[];
  prompts: readonly LocalPrompt[];
  localWorks?: readonly PromptWorkReference[];
  localMaterials?: readonly LocalMaterialReference[];
  throughDay?: number;
  rules?: PlanRules;
}
export interface LocalMaterialReference {
  skill?: "listening" | "reading";
  date: string;
  taskId: string;
  id?: string;
  version?: string;
  contentHash: string;
  updatedAt: number;
}
export interface AutomaticMaterialPlan {
  days: AutomaticMaterialDay[];
  checkpoints: readonly CheckpointCycle[];
  summary: {
    plannedDays: number;
    assignedBlocks: number;
    missingBlocks: number;
    partialBlocks: number;
    reservedMaterials: number;
  };
}
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const materialKey = (
  item: Pick<LocalMaterial, "id" | "version" | "contentHash">,
) => `${item.id}@${item.version}@${item.contentHash}`;
const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const canonicalMaterials = (bank: readonly LocalMaterial[]) =>
  [...bank].sort(
    (a, b) =>
      compareText(a.id, b.id) ||
      compareText(a.version, b.version) ||
      compareText(a.contentHash, b.contentHash),
  );
const latestWorkFirst = (a: Revision, b: Revision) =>
  b.createdAt - a.createdAt ||
  b.seq - a.seq ||
  compareText(b.revisionId, a.revisionId);
function savedSkill(work: Revision): AssignedSkill | null {
  if (work.kind === "essay") return "writing";
  if (work.kind === "speaking") return "speaking";
  const skill = work.payload.skill;
  return (work.kind === "attempt" || work.kind === "mission") &&
    (skill === "listening" ||
      skill === "reading" ||
      skill === "writing" ||
      skill === "speaking")
    ? skill
    : null;
}
function taskRoute(
  skill: AssignedSkill,
  day: number,
  date: string,
  taskId: string,
  minutes: number,
  key?: string,
  workId?: string,
): string {
  const query = new URLSearchParams({
    day: String(day),
    date,
    task: taskId,
    minutes: String(minutes),
  });
  if (key) query.set("material", key);
  if (workId) query.set("work", workId);
  return `#/${skill}?${query}`;
}
/** Reservations are in-memory identities only: no fabricated attempts, scores, dates or completion records. */
function materialReservations(
  bank: readonly LocalMaterial[],
  records: readonly Revision[],
  planId?: string,
) {
  const exact = new Map<string, LocalMaterial>(),
    bodies = new Map<LocalMaterial, string>();
  for (const item of bank) {
    if (!exact.has(materialKey(item))) exact.set(materialKey(item), item);
    bodies.set(
      item,
      normalize(item.skill === "reading" ? item.passage : item.transcript),
    );
  }
  const keys = new Set<string>(),
    usedBodies = new Set<string>(),
    audioPaths = new Set<string>(),
    audioHashes = new Set<string>();
  const exams = new Set<string>(),
    wholeExams = new Set<string>();
  const reserve = (item: LocalMaterial) => {
    keys.add(materialKey(item));
    const body = bodies.get(item);
    if (body) usedBodies.add(body);
    if (item.skill === "listening") {
      if (item.audio?.path) audioPaths.add(item.audio.path);
      if (item.audio?.sha256) audioHashes.add(item.audio.sha256);
    }
    if (item.examId) {
      const exam = `${item.skill}:${item.examId}`;
      exams.add(exam);
      if (item.scope === "full") wholeExams.add(exam);
    }
  };
  for (const work of records) {
    if (
      work.kind !== "attempt" ||
      work.deleted ||
      work.conflict ||
      (planId !== undefined &&
        (work.planId !== planId || work.payload.planId !== planId))
    )
      continue;
    const key = `${String(work.payload.contentId)}@${String(work.payload.contentVersion)}@${String(work.payload.contentHash)}`;
    keys.add(key);
    const item = exact.get(key);
    if (item) reserve(item);
  }
  const repeated = (item: LocalMaterial) => {
    if (keys.has(materialKey(item))) return true;
    const body = bodies.get(item);
    if (body && usedBodies.has(body)) return true;
    if (
      item.skill === "listening" &&
      ((item.audio?.path && audioPaths.has(item.audio.path)) ||
        (item.audio?.sha256 && audioHashes.has(item.audio.sha256)))
    )
      return true;
    return false;
  };
  const unseen = (item: LocalMaterial) => {
    if (repeated(item)) return false;
    if (item.examId) {
      const exam = `${item.skill}:${item.examId}`;
      if (wholeExams.has(exam) || (item.scope === "full" && exams.has(exam)))
        return false;
    }
    return true;
  };
  return { reserve, unseen, repeated };
}

export interface IndependentListeningReadingInput {
  skill: "reading" | "listening";
  bank: readonly LocalMaterial[];
  /** Records must already belong to the active account. Omit planId to consider all of its plans. */
  records: readonly Revision[];
  planId?: string;
  preferredPassageNumber?: 1 | 2 | 3;
  /** Listening only: prefer this IELTS Section (1 easiest → 4 hardest). */
  preferredSection?: 1 | 2 | 3 | 4;
  preferredQuestionTypes?: readonly string[];
}
export interface IndependentListeningReadingSelection {
  material: LocalMaterial | null;
  status: "assigned" | "missing";
  repeat: boolean;
  notice: string;
}
function independentAttemptHeads(
  records: readonly Revision[],
  planId?: string,
): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of [...records]
    .filter((record) => record.kind === "attempt" && !record.conflict)
    .sort(latestWorkFirst)) {
    if (!heads.has(record.id)) heads.set(record.id, record);
  }
  return [...heads.values()].filter(
    (record) =>
      !record.deleted &&
      (planId === undefined ||
        (record.planId === planId && record.payload.planId === planId)),
  );
}
/** Uses the same original/body/audio/exam boundary as automatic selection, across this account's history. */
export function wasListeningReadingAttempted(
  material: LocalMaterial,
  bank: readonly LocalMaterial[],
  records: readonly Revision[],
): boolean {
  const original = bank.find(
    (item) => materialKey(item) === materialKey(material),
  );
  const inventory = original ? bank : [...bank, material];
  return !materialReservations(
    inventory,
    independentAttemptHeads(records),
  ).unseen(original ?? material);
}
/** Practice is available before, during and after a course. Started work is resumed by the caller first. */
export function selectIndependentListeningReading(
  input: IndependentListeningReadingInput,
): IndependentListeningReadingSelection {
  const bank = canonicalMaterials(input.bank);
  const records = independentAttemptHeads(input.records, input.planId);
  const used = materialReservations(bank, records, input.planId);
  const heldAudioPaths = new Set(
    bank
      .filter(
        (item) =>
          item.pool === "holdout" &&
          item.skill === "listening" &&
          item.audio?.path,
      )
      .map((item) =>
        item.skill === "listening" ? item.audio?.path : undefined,
      ),
  );
  const candidates = bank.filter(
    (item) =>
      item.skill === input.skill &&
      ["section", "type-drill", "full"].includes(item.scope) &&
      item.questions.length > 0 &&
      (item.scope !== "full" || item.questions.length === 40) &&
      !isHeldOutListeningReading(item, bank) &&
      (item.skill === "reading"
        ? !!item.passage.trim()
        : !!item.transcript.trim() &&
          (!!item.audio?.path || isListeningSequenceMaterial(item)) &&
          !heldAudioPaths.has(item.audio?.path)),
  );
  const approximateMinutes = (item: LocalMaterial): number => {
    if (typeof item.estimatedMinutes === "number" && item.estimatedMinutes > 0)
      return item.estimatedMinutes;
    if (item.scope === "full") return item.skill === "reading" ? 60 : 30;
    if (item.scope === "type-drill") return 5;
    return item.skill === "reading"
      ? 20
      : item.audio
        ? Math.ceil(item.audio.durationSeconds / 60) + 1
        : 20;
  };
  const scopeRank = (item: LocalMaterial) =>
    item.scope === "section" ? 0 : item.scope === "type-drill" ? 1 : 2;
  const passageRank = (item: LocalMaterial) =>
    input.preferredPassageNumber &&
    item.skill === "reading" &&
    item.scope === "section"
      ? item.passageNumber === input.preferredPassageNumber
        ? 0
        : 1
      : 0;
  const sectionRank = (item: LocalMaterial) =>
    input.preferredSection && item.skill === "listening" && item.scope === "section"
      ? sectionDistance(item, input.preferredSection)
      : 0;
  const typeRank = (item: LocalMaterial) =>
    input.preferredQuestionTypes?.length &&
    item.questions.some((question) =>
      input.preferredQuestionTypes!.includes(question.type),
    )
      ? 0
      : 1;
  const ordered = [...candidates].sort(
    (a, b) =>
      scopeRank(a) - scopeRank(b) ||
      passageRank(a) - passageRank(b) ||
      sectionRank(a) - sectionRank(b) ||
      typeRank(a) - typeRank(b) ||
      Math.abs(approximateMinutes(a) - 20) -
        Math.abs(approximateMinutes(b) - 20) ||
      compareText(materialKey(a), materialKey(b)),
  );
  const fresh = ordered.find(used.unseen);
  const material = fresh ?? ordered.find(used.repeated) ?? null;
  const repeat = !!material && !fresh;
  const label = input.skill === "reading" ? "阅读" : "听力";
  return {
    material,
    status: material ? "assigned" : "missing",
    repeat,
    notice: !material
      ? `暂缺可用${label}练习材料；不使用检查池或虚构题补齐。`
      : repeat
        ? `本类可用新题已练完，已安排做过的${label}原题复习；本次标记为重复练习，不算未见新题或独立测评。`
        : `已自动安排未做过的${label}${material.scope === "full" ? "整套；请按完整材料所需时间练习。" : material.scope === "type-drill" ? "题型练习。" : "单篇／单节练习，适合约20分钟自主学习。"}`,
  };
}

/** Stable inventory order and separate reservations make the same inputs produce the same 365-day plan.
 * Unstarted future slots may adapt when inventory or learner evidence changes; submitted work stays pinned. */
export function buildDailyMaterialPlan(
  input: DailyMaterialPlanInput,
): AutomaticMaterialPlan {
  const { plan, records } = input,
    rules = input.rules ?? bundledRules,
    throughDay = input.throughDay ?? rules.goal.durationDays;
  if (
    plan.kind !== "plan" ||
    plan.deleted ||
    plan.conflict ||
    !Number.isInteger(throughDay) ||
    throughDay < 1 ||
    throughDay > rules.goal.durationDays
  )
    throw new Error("自动选材需要有效计划和1至365的学习日。");
  const qualified = materialQualifiedRecords(records, plan.id),
    baseline = selectLatestBaseline(qualified, plan.id);
  const scores = scoreView(
    latestAssessment(records, plan.id)?.payload ?? {},
    records,
  ).effectiveScores;
  const dayPlans = Array.from({ length: rules.goal.durationDays }, (_, index) =>
    buildDayPlan(
      rules,
      plan.payload,
      dayDate(
        String(plan.payload.startDate),
        String(plan.payload.timeZone),
        index + 1,
      ),
      baseline,
      { scores },
    ),
  );
  const checkpoints = checkpointCycles(dayPlans, rules),
    bank = canonicalMaterials(input.bank);
  const byKey = new Map(bank.map((item) => [materialKey(item), item]));
  const byHash = new Map<string, LocalMaterial[]>();
  for (const item of bank) {
    const items = byHash.get(item.contentHash) ?? [];
    items.push(item);
    byHash.set(item.contentHash, items);
  }
  const fromLocal = (ref: LocalMaterialReference) =>
    byHash
      .get(ref.contentHash)
      ?.find(
        (item) =>
          (!ref.skill || item.skill === ref.skill) &&
          item.contentHash === ref.contentHash &&
          (!ref.id || item.id === ref.id) &&
          (!ref.version || item.version === ref.version),
      );
  const localKey = (ref: LocalMaterialReference) =>
    `${ref.id ?? "missing"}@${ref.version ?? "missing"}@${ref.contentHash}`;
  const localByTask = new Map<string, LocalMaterialReference[]>();
  for (const ref of [...(input.localMaterials ?? [])].sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || compareText(localKey(a), localKey(b)),
  )) {
    const key = JSON.stringify([ref.date, ref.taskId]);
    const list = localByTask.get(key) ?? [];
    list.push(ref);
    localByTask.set(key, list);
  }
  const held = new Set(
    bank.filter((item) => isHeldOutListeningReading(item, bank)),
  );
  const originals = bank.filter(
    (item) => !isListeningSequenceMaterial(item) && !held.has(item),
  );
  const schedule = buildListeningReadingSchedule(originals);
  const reservedExams = new Set(
    bank
      .filter((item) => item.scope === "full" && item.examId)
      .map((item) => `${item.skill}:${item.examId}`),
  );
  const practiceSections = originals.filter(
    (item) =>
      item.scope === "section" &&
      item.questions.length > 0 &&
      (item.skill === "reading" || !!item.audio) &&
      !(item.examId && reservedExams.has(`${item.skill}:${item.examId}`)),
  );
  const fulls = bank.filter(
    (item) =>
      item.scope === "full" &&
      item.questions.length === 40 &&
      (item.skill === "reading" ||
        !!item.audio ||
        isListeningSequenceMaterial(item)),
  );
  const reservations = materialReservations(bank, records, plan.id);
  for (const ref of input.localMaterials ?? []) {
    const item = fromLocal(ref);
    if (item) reservations.reserve(item);
  }
  const history = records.filter(
    (work) =>
      work.kind === "attempt" &&
      byKey.has(
        `${String(work.payload.contentId)}@${String(work.payload.contentVersion)}@${String(work.payload.contentHash)}`,
      ),
  );
  const levels = [1, 6, 11].map((day) =>
    selectReadingForDay(originals, history, plan.id, day),
  );
  const heads = new Map<string, Revision>();
  for (const work of [...records].sort(latestWorkFirst))
    if (!heads.has(work.id)) heads.set(work.id, work);
  const works = [...heads.values()].filter(
    (work) =>
      !work.deleted &&
      !work.conflict &&
      work.planId === plan.id &&
      work.payload.planId === plan.id,
  );
  const worksByTask = new Map<string, Revision[]>();
  for (const work of works) {
    const key = JSON.stringify([work.payload.date, work.payload.taskId]);
    const list = worksByTask.get(key) ?? [];
    list.push(work);
    worksByTask.set(key, list);
  }
  const preferenceWeeks = new Map<
    number,
    ReturnType<typeof acceptedMaterialPreferences>
  >();
  const candidatePreferenceWeeks = new Set(
    records
      .filter(
        (work) =>
          work.kind === "adjustment" &&
          work.payload.decision === "accepted" &&
          typeof work.payload.weekIndex === "number",
      )
      .map((work) => Number(work.payload.weekIndex) + 1),
  );
  const promptSelection = createPromptSelectionContext({
    prompts: input.prompts,
    records: works,
    planId: plan.id,
    localWorks: input.localWorks,
  });
  const days: AutomaticMaterialDay[] = [];
  let assignedBlocks = 0,
    missingBlocks = 0,
    partialBlocks = 0,
    reservedMaterials = 0;
  for (const dayPlan of dayPlans.slice(0, throughDay)) {
    const { day, date } = dayPlan;
    const blocks: BlockMaterialAssignment[] = [];
    for (const block of dayPlan.blocks) {
      const taskId = missionTaskId(day, block.id);
      const current = worksByTask.get(JSON.stringify([date, taskId])) ?? [];
      const mission = current.find((work) => work.kind === "mission");
      const minutes =
        typeof mission?.payload.plannedMinutes === "number"
          ? mission.payload.plannedMinutes
          : block.minutes;
      const localReferences =
        localByTask.get(JSON.stringify([date, taskId])) ?? [];
      const localForTask = localReferences[0];
      const flexible =
        block.id === "timed-section" || block.id === "weak-skill";
      const workSkill = current
        .filter((work) => work.kind !== "mission")
        .map(savedSkill)
        .find((value): value is AssignedSkill => value !== null);
      const skill = flexible
        ? (workSkill ??
          (mission ? savedSkill(mission) : null) ??
          (localForTask
            ? (fromLocal(localForTask)?.skill ?? localForTask.skill)
            : null) ??
          block.skill)
        : block.skill;
      const result: BlockMaterialAssignment = {
        day,
        date,
        taskId,
        blockId: block.id,
        skill,
        minutes,
        status: "not-required",
        materials: [],
        route:
          block.route ??
          (block.id.includes("review") || block.id.includes("calibration")
            ? "#/review"
            : null),
        notice: "",
        checkpoint: false,
      };
      if (
        skill !== "listening" &&
        skill !== "reading" &&
        skill !== "writing" &&
        skill !== "speaking"
      ) {
        blocks.push(result);
        continue;
      }
      if (
        flexible &&
        !workSkill &&
        localForTask &&
        !localForTask.skill &&
        !fromLocal(localForTask)
      ) {
        result.status = "missing";
        result.route = null;
        result.notice =
          "缺少已开始草稿的原版材料，暂时无法识别原科目；草稿保留，不改派另一题。";
        missingBlocks++;
        blocks.push(result);
        continue;
      }
      const checkpoint = checkpoints.some((cycle) => cycle[skill] === day),
        pool =
          checkpoint &&
          (skill === "listening" ||
            skill === "reading" ||
            checkpoints.some(
              (cycle) => cycle.listening !== 1 && cycle[skill] === day,
            ))
            ? "holdout"
            : "practice";
      result.checkpoint = checkpoint;
      if (skill === "listening" || skill === "reading") {
        const requiresFull = minutes >= (skill === "reading" ? 60 : 30);
        const old = current.find(
          (work) =>
            work.kind === "attempt" &&
            work.payload.skill === skill &&
            work.payload.scope !== "type-drill",
        );
        const local = old
          ? undefined
          : localReferences.find((ref) => {
              const source = fromLocal(ref);
              return (
                (!ref.skill || ref.skill === skill) &&
                source?.scope !== "type-drill" &&
                (!source || source.skill === skill)
              );
            });
        let chosen: LocalMaterial | undefined;
        if (old || local) {
          chosen = old
            ? byKey.get(
                `${String(old.payload.contentId)}@${String(old.payload.contentVersion)}@${String(old.payload.contentHash)}`,
              )
            : fromLocal(local!);
          if (chosen?.skill !== skill) chosen = undefined;
          if (!chosen) {
            result.status = "missing";
            result.notice =
              "缺少已保存作答的原版材料；原作答保留，不改派另一份。";
            result.route = taskRoute(
              skill,
              day,
              date,
              taskId,
              minutes,
              local ? localKey(local) : undefined,
              old?.id,
            );
          }
        } else if (requiresFull) {
          chosen = fulls.find(
            (item) =>
              item.skill === skill &&
              (pool === "holdout"
                ? item.pool === "holdout"
                : !held.has(item)) &&
              reservations.unseen(item),
          );
        } else {
          const level = levels[day <= 5 ? 0 : day <= 10 ? 1 : 2];
          const wanted = skill === "reading" ? level.passageNumber : null;
          const week = Math.min(52, Math.floor((day - 1) / 7) + 1);
          if (!preferenceWeeks.has(week))
            preferenceWeeks.set(
              week,
              acceptedMaterialPreferences(
                candidatePreferenceWeeks.has(week) ? records : [],
                plan.id,
                week,
              ),
            );
          const preferredTypes =
            preferenceWeeks.get(week)!.questionTypes[skill];
          const unseen = practiceSections.filter(
            (item) =>
              item.skill === skill &&
              reservations.unseen(item) &&
              (skill !== "reading" ||
                (item.skill === "reading" && item.passageNumber === wanted)),
          );
          const ladder =
            skill === "listening"
              ? preferSection(unseen, listeningSectionForDay(day))
              : null;
          const candidates = ladder ? ladder.items : unseen;
          const typeCycle: string[] = [
            ...new Set(
              candidates.flatMap((item) =>
                item.questions.map((question) => question.type),
              ),
            ),
          ].sort(compareText);
          const wantedType =
            preferredTypes.find((type) => typeCycle.includes(type)) ??
            typeCycle[(day - 1) % Math.max(1, typeCycle.length)];
          chosen =
            candidates.find((item) =>
              item.questions.some((question) => question.type === wantedType),
            ) ?? candidates[0];
          result.notice =
            skill === "reading"
              ? level.notice
              : ladderNotice(day, ladder?.section);
        }
        const readingWarmupRequired = skill === "reading" && day <= 14;
        const officialRef =
          day <= 14 && (skill === "reading" || !requiresFull)
            ? skill === "reading"
              ? schedule.days[day - 1].readingOfficial
              : schedule.days[day - 1].listeningOfficial
            : null;
        const savedOfficial = current.find(
          (work) =>
            work.kind === "attempt" &&
            work.payload.skill === skill &&
            work.payload.scope === "type-drill" &&
            work.payload.materialSource === "official",
        );
        const localOfficial = localReferences.find((ref) => {
          const source = fromLocal(ref);
          return (
            source?.skill === skill &&
            source.scope === "type-drill" &&
            source.source.materialSource === "official"
          );
        });
        const official = savedOfficial
          ? byKey.get(
              `${String(savedOfficial.payload.contentId)}@${String(savedOfficial.payload.contentVersion)}@${String(savedOfficial.payload.contentHash)}`,
            )
          : localOfficial
            ? fromLocal(localOfficial)
            : officialRef && byKey.get(materialKey(officialRef));
        if (
          official &&
          (readingWarmupRequired || minutes >= (skill === "reading" ? 25 : 20))
        ) {
          const saved = current.find(
            (work) =>
              work.kind === "attempt" &&
              work.payload.contentId === official.id &&
              work.payload.contentVersion === official.version &&
              work.payload.contentHash === official.contentHash,
          );
          result.materials.push({
            kind: "listening-reading",
            skill,
            id: official.id,
            version: official.version,
            contentHash: official.contentHash,
            title: official.title,
            sourceRef: official.source.sourceRef,
            scope: official.scope,
            role: "calibration",
            pool: "practice",
            completed: !!saved && completedListeningReadingReview(saved),
            route: taskRoute(
              skill,
              day,
              date,
              taskId,
              minutes,
              materialKey(official),
              saved?.id,
            ),
            ...(saved ? { workId: saved.id } : {}),
          });
        }
        if (chosen) {
          const role =
            checkpoint && chosen.pool === "holdout" ? "assessment" : "practice";
          result.materials.push({
            kind: "listening-reading",
            skill,
            id: chosen.id,
            version: chosen.version,
            contentHash: chosen.contentHash,
            title: chosen.title,
            sourceRef: chosen.source.sourceRef,
            scope: chosen.scope,
            role,
            pool: chosen.pool === "holdout" ? "holdout" : "practice",
            completed: !!old && completedListeningReadingReview(old),
            route: taskRoute(
              skill,
              day,
              date,
              taskId,
              minutes,
              materialKey(chosen),
              old?.id,
            ),
            ...(old ? { workId: old.id } : {}),
          });
          reservations.reserve(chosen);
          reservedMaterials++;
          result.status = "assigned";
          result.notice =
            old || local
              ? "继续已保存作答，保留原材料版本。"
              : checkpoint
                ? "平台已安排未见独立检查题；作答不代表已达到成绩门槛。"
                : result.notice || "平台已按本块时长安排未做整套。";
          if (checkpoint && chosen.pool !== "holdout") {
            result.status = "partial";
            result.notice +=
              " 该既有作答不是独立检查池材料，不提升为独立检查成绩。";
          }
          if (requiresFull && chosen.scope !== "full") {
            result.status = "partial";
            result.notice +=
              " 该既有作答不是本块所需整套，保留原题，不能充作整套完成。";
          }
        } else if (!old && !local) {
          result.status = result.materials.length ? "partial" : "missing";
          result.notice = `缺少未做过的${pool === "holdout" ? "独立检查池" : ""}${skill === "listening" ? "听力" : "阅读"}${requiresFull ? "整套" : "单篇／单节"}材料；平台不拿旧题或不完整材料充数。`;
        }
        if (savedOfficial && !official) {
          result.status = result.materials.length ? "partial" : "missing";
          result.notice +=
            " 缺少已保存题型练习的原版材料；保留原作答，不改派另一份。";
          result.route = taskRoute(
            skill,
            day,
            date,
            taskId,
            minutes,
            undefined,
            savedOfficial.id,
          );
        }
        if (readingWarmupRequired) {
          if (official) {
            result.notice +=
              " 前14天先完成官方题型热身，再做本课完整主练；热身和复盘使用本课及既有复盘时间，主练计时不缩短。";
          } else {
            result.status = result.materials.length ? "partial" : "missing";
            result.notice +=
              " 缺少本课必需的可用官方阅读题型热身，完成门槛未满足；不虚构材料或降低要求。";
          }
        }
      } else {
        const selected = (
          skill === "writing"
            ? selectScheduledWritingPrompts
            : selectScheduledSpeakingPrompts
        )({
          prompts: input.prompts,
          records: current,
          planId: plan.id,
          day,
          date,
          taskId,
          plannedMinutes: minutes,
          pool,
          prepared: promptSelection,
          localWorks: input.localWorks,
        });
        const notices: string[] = [];
        for (const item of selected) {
          notices.push(item.notice);
          if (!item.prompt) continue;
          const prompt = item.prompt;
          const old = current.find(
            (work) =>
              work.kind === (skill === "writing" ? "essay" : "speaking") &&
              work.payload.contentId === prompt.id &&
              work.payload.contentVersion === prompt.version &&
              (prompt.skill === "writing"
                ? work.payload.taskType === prompt.taskType
                : work.payload.part === prompt.part),
          );
          result.materials.push({
            kind: "prompt",
            skill,
            id: prompt.id,
            version: prompt.version,
            contentHash: prompt.contentHash,
            title: `${skill === "writing" ? `Task ${prompt.skill === "writing" && prompt.taskType === "task1" ? "1" : "2"}` : `Part ${prompt.skill === "speaking" ? prompt.part : ""}`} · ${prompt.sourceRef}`,
            sourceRef: prompt.sourceRef,
            role: pool === "holdout" ? "assessment" : "practice",
            pool,
            completed:
              !!old &&
              (old.kind === "speaking" || old.payload.stage === "submitted"),
            ...(prompt.skill === "writing"
              ? { taskType: prompt.taskType }
              : { part: prompt.part }),
            route: taskRoute(
              skill,
              day,
              date,
              taskId,
              minutes,
              promptKey(prompt),
              old?.id,
            ),
            ...(old ? { workId: old.id } : {}),
          });
          promptSelection.reserve(prompt);
          reservedMaterials++;
        }
        result.status =
          selected.length && result.materials.length === selected.length
            ? "assigned"
            : result.materials.length
              ? "partial"
              : "missing";
        result.notice = notices.join(" ");
        if (checkpoint && pool === "practice")
          result.notice += " 基线使用未见练习题，不冒称独立检查池或正式成绩。";
      }
      result.route ??=
        result.materials.find((item) => !item.completed)?.route ??
        result.materials[0]?.route ??
        null;
      if (result.status === "assigned") assignedBlocks++;
      else if (result.status === "partial") partialBlocks++;
      else if (result.status === "missing") missingBlocks++;
      blocks.push(result);
    }
    days.push({
      day,
      date,
      phaseId: dayPlan.phaseId,
      totalMinutes: dayPlan.totalMinutes,
      blocks,
    });
  }
  return {
    days,
    checkpoints,
    summary: {
      plannedDays: days.length,
      assignedBlocks,
      missingBlocks,
      partialBlocks,
      reservedMaterials,
    },
  };
}
export function automaticMaterialForTask(
  input: DailyMaterialPlanInput,
  context: { day: number; taskId: string },
): BlockMaterialAssignment | null {
  const value = buildDailyMaterialPlan({ ...input, throughDay: context.day });
  return (
    value.days
      .at(-1)
      ?.blocks.find((block) => block.taskId === context.taskId) ?? null
  );
}
