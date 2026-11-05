import type { LocalPrompt } from "./promptBankSchema";
import type { WritingDraft } from "./writingModel";
import type { SpeakingDraft } from "./speakingModel";
import type { Revision } from "./protocol";
export const promptKey = (prompt: LocalPrompt) =>
  `${prompt.id}@${prompt.version}@${prompt.contentHash}`;
const normalizedQuestions = new WeakMap<
  LocalPrompt,
  { text: string; value: string }
>();
const promptIdentities = new WeakMap<
  LocalPrompt,
  {
    text: string;
    skill: LocalPrompt["skill"];
    kind: string | number;
    stimulusHash: string;
    value: string;
  }
>();
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const normalizeQuestion = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
function questionBody(prompt: LocalPrompt): string {
  const previous = normalizedQuestions.get(prompt);
  if (previous?.text === prompt.prompt) return previous.value;
  const value = normalizeQuestion(prompt.prompt);
  normalizedQuestions.set(prompt, { text: prompt.prompt, value });
  return value;
}
function practiceIdentity(prompt: LocalPrompt): string {
  const kind = prompt.skill === "writing" ? prompt.taskType : prompt.part;
  const stimulusHash =
    prompt.skill === "writing" && prompt.taskType === "task1"
      ? (prompt.stimulusHash ?? "?")
      : "";
  const previous = promptIdentities.get(prompt);
  if (
    previous?.text === prompt.prompt &&
    previous.skill === prompt.skill &&
    previous.kind === kind &&
    previous.stimulusHash === stimulusHash
  )
    return previous.value;
  const original = questionBody(prompt);
  const value = JSON.stringify([prompt.skill, kind, original, stimulusHash]);
  promptIdentities.set(prompt, {
    text: prompt.prompt,
    skill: prompt.skill,
    kind,
    stimulusHash,
    value,
  });
  return value;
}
function currentPromptWorks(
  records: readonly Revision[],
  planId: string | undefined,
  skill: "writing" | "speaking",
) {
  const heads = new Map<string, Revision>();
  for (const work of records) {
    if (work.conflict) continue;
    const previous = heads.get(work.id);
    if (
      !previous ||
      work.createdAt > previous.createdAt ||
      (work.createdAt === previous.createdAt &&
        (work.seq > previous.seq ||
          (work.seq === previous.seq &&
            compareText(work.revisionId, previous.revisionId) > 0)))
    )
      heads.set(work.id, work);
  }
  return [...heads.values()].filter(
    (work) =>
      !work.deleted &&
      !!work.planId &&
      work.payload.planId === work.planId &&
      (planId === undefined || work.planId === planId) &&
      work.kind === (skill === "writing" ? "essay" : "speaking"),
  );
}
export function unattemptedPrompts(
  input: Pick<
    PromptScheduleInput,
    "prompts" | "records" | "planId" | "historyScope"
  >,
  skill: "writing" | "speaking",
): Set<LocalPrompt> {
  const byKey = new Map(
    input.prompts.map((prompt) => [`${prompt.id}@${prompt.version}`, prompt]),
  );
  const originals = new Set<string>(),
    unknownBodies = new Set<string>();
  for (const work of currentPromptWorks(
    input.records,
    input.historyScope === "account" ? undefined : input.planId,
    skill,
  )) {
    const text = String(work.payload.prompt ?? ""),
      body = normalizeQuestion(
        work.payload.taskType === "task1"
          ? text.split("\n\n题图文字说明：")[0]
          : text,
      );
    const known = byKey.get(
      `${String(work.payload.contentId)}@${String(work.payload.contentVersion)}`,
    );
    if (
      known &&
      known.skill === skill &&
      questionBody(known) === body &&
      (known.skill === "writing"
        ? known.taskType === work.payload.taskType
        : known.part === work.payload.part)
    )
      originals.add(practiceIdentity(known));
    else unknownBodies.add(normalizeQuestion(text));
  }
  return new Set(
    input.prompts.filter(
      (prompt) =>
        !originals.has(practiceIdentity(prompt)) &&
        !unknownBodies.has(questionBody(prompt)),
    ),
  );
}
export function practicePrompts(prompts: readonly LocalPrompt[]) {
  const reserved = new Set(
    prompts.filter((prompt) => prompt.pool === "holdout").map(practiceIdentity),
  );
  return prompts.filter(
    (prompt) =>
      promptReady(prompt) &&
      prompt.pool !== "holdout" &&
      !reserved.has(practiceIdentity(prompt)),
  );
}
function promptReady(prompt: LocalPrompt) {
  return (
    prompt.ready !== false &&
    !!prompt.prompt.trim() &&
    (prompt.skill !== "writing" ||
      prompt.taskType !== "task1" ||
      (!!prompt.stimulusHash &&
        (!!prompt.stimulusText?.trim() || !!prompt.stimulusImage)))
  );
}
export interface PromptScheduleInput {
  prompts: readonly LocalPrompt[];
  records: readonly Revision[];
  planId: string;
  day: number;
  date: string;
  taskId: string;
  plannedMinutes: number;
  pool?: "practice" | "holdout";
  /** Earlier slots in a preview are reservations, never attempts or scores. */
  reservedPrompts?: readonly LocalPrompt[];
  localWorks?: readonly PromptWorkReference[];
  continueCurrent?: boolean;
  historyScope?: "plan" | "account";
  /** Explicit snapshot for one projection. Recreate after records or inventory change. */
  prepared?: PromptSelectionContext;
}
export interface PromptSelectionContext {
  candidates(
    target: Pick<PromptAssignment, "skill" | "taskType" | "part">,
    pool: "practice" | "holdout",
  ): readonly LocalPrompt[];
  isReserved(prompt: LocalPrompt): boolean;
  reserve(prompt: LocalPrompt): void;
}
export interface PromptWorkReference {
  skill: "writing" | "speaking";
  date: string;
  taskId?: string;
  taskType?: "task1" | "task2";
  part?: 1 | 2 | 3;
  contentId?: string;
  contentVersion?: string;
  prompt: string;
  updatedAt: number;
}
export interface PromptAssignment {
  skill: "writing" | "speaking";
  taskType?: "task1" | "task2";
  part?: 1 | 2 | 3;
  prompt: LocalPrompt | null;
  status: "assigned" | "missing";
  notice: string;
}
/** One short-lived projection snapshot; only reservations mutate through reserve(). */
export function createPromptSelectionContext(
  input: Pick<
    PromptScheduleInput,
    | "prompts"
    | "records"
    | "planId"
    | "localWorks"
    | "reservedPrompts"
    | "historyScope"
  >,
): PromptSelectionContext {
  const writingUnseen = unattemptedPrompts(input, "writing"),
    speakingUnseen = unattemptedPrompts(input, "speaking"),
    practice = new Set(practicePrompts(input.prompts)),
    reserved = new Set((input.reservedPrompts ?? []).map(practiceIdentity)),
    indexed = new Map<string, LocalPrompt[]>();
  const key = (
    target: Pick<PromptAssignment, "skill" | "taskType" | "part">,
    pool: "practice" | "holdout",
  ) => `${pool}:${target.skill}:${target.taskType ?? target.part}`;
  for (const work of input.localWorks ?? []) {
    const original = input.prompts.find(
      (prompt) =>
        prompt.id === work.contentId &&
        prompt.version === work.contentVersion &&
        prompt.skill === work.skill &&
        (prompt.skill === "writing"
          ? prompt.taskType === work.taskType
          : prompt.part === work.part),
    );
    if (original) reserved.add(practiceIdentity(original));
  }
  for (const prompt of input.prompts) {
    if (
      !(prompt.skill === "writing" ? writingUnseen : speakingUnseen).has(prompt)
    )
      continue;
    const pool =
      prompt.pool === "holdout" && promptReady(prompt)
        ? "holdout"
        : practice.has(prompt)
          ? "practice"
          : null;
    if (!pool) continue;
    const scope = key(prompt, pool),
      list = indexed.get(scope) ?? [];
    list.push(prompt);
    indexed.set(scope, list);
  }
  for (const list of indexed.values())
    list.sort(
      (a, b) =>
        compareText(a.id, b.id) ||
        compareText(a.version, b.version) ||
        compareText(a.contentHash, b.contentHash),
    );
  return {
    candidates: (target, pool) => indexed.get(key(target, pool)) ?? [],
    isReserved: (prompt) => reserved.has(practiceIdentity(prompt)),
    reserve: (prompt) => {
      reserved.add(practiceIdentity(prompt));
    },
  };
}
function scheduledPrompt(
  input: PromptScheduleInput,
  target: Pick<PromptAssignment, "skill" | "taskType" | "part">,
): PromptAssignment {
  const label =
    target.skill === "writing"
      ? target.taskType === "task1"
        ? "写作 Task 1"
        : "写作 Task 2"
      : `口语 Part ${target.part}`;
  const sameType = (prompt: LocalPrompt) =>
    prompt.skill === target.skill &&
    (prompt.skill === "writing"
      ? prompt.taskType === target.taskType
      : prompt.part === target.part);
  const local =
    input.continueCurrent === false
      ? undefined
      : input.localWorks
          ?.filter(
            (work) =>
              work.prompt.trim() &&
              work.skill === target.skill &&
              work.date === input.date &&
              work.taskId === input.taskId &&
              (target.skill === "writing"
                ? work.taskType === target.taskType
                : work.part === target.part),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const saved =
    input.continueCurrent === false
      ? undefined
      : currentPromptWorks(input.records, input.planId, target.skill)
          .filter(
            (work) =>
              work.payload.date === input.date &&
              work.payload.taskId === input.taskId &&
              (target.skill === "writing"
                ? work.payload.taskType === target.taskType
                : work.payload.part === target.part),
          )
          .sort(
            (a, b) =>
              b.createdAt - a.createdAt ||
              b.seq - a.seq ||
              compareText(b.revisionId, a.revisionId),
          )[0];
  if (local || saved) {
    const previous = local ?? saved!.payload;
    const savedText = String(previous.prompt ?? ""),
      savedBody = normalizeQuestion(
        previous.taskType === "task1"
          ? savedText.split("\n\n题图文字说明：")[0]
          : savedText,
      );
    const exact = input.prompts.find(
      (prompt) =>
        sameType(prompt) &&
        prompt.id === previous.contentId &&
        prompt.version === previous.contentVersion &&
        questionBody(prompt) === savedBody &&
        (input.pool !== "holdout" || prompt.pool === "holdout"),
    );
    return {
      ...target,
      prompt: exact ?? null,
      status: exact ? "assigned" : "missing",
      notice: exact
        ? `继续本次${label}，保留原题版本。`
        : `缺少已保存${label}的原版材料；原作答保留，不改派另一题。`,
    };
  }
  const prepared = input.prepared ?? createPromptSelectionContext(input);
  const choices = prepared
    .candidates(target, input.pool ?? "practice")
    .filter((prompt) => !prepared.isReserved(prompt));
  const types =
    target.skill === "writing"
      ? [
          ...new Set(
            choices
              .filter((prompt) => prompt.skill === "writing")
              .map((prompt) => prompt.questionType),
          ),
        ].sort(
          (a, b) =>
            Number(a === "unknown") - Number(b === "unknown") ||
            compareText(a, b),
        )
      : [];
  const wanted = types.length
    ? types[(Math.max(1, input.day) - 1) % types.length]
    : null;
  const ordered = choices.filter(
    (prompt) =>
      !wanted || prompt.skill !== "writing" || prompt.questionType === wanted,
  );
  const prompt = ordered[0] ?? null;
  return {
    ...target,
    prompt,
    status: prompt ? "assigned" : "missing",
    notice: prompt
      ? `平台已安排${label}${prompt.skill === "writing" ? ` · ${prompt.questionType}` : ""}，开始后保留本题。`
      : `缺少未做过且已就绪的${label}材料，平台不会用旧题或缺图题替代。`,
  };
}
export function selectWritingPrompt(
  input: PromptScheduleInput,
  taskType: "task1" | "task2",
): PromptAssignment {
  return scheduledPrompt(input, { skill: "writing", taskType });
}
export function selectSpeakingPrompt(
  input: PromptScheduleInput,
  part: 1 | 2 | 3,
): PromptAssignment {
  return scheduledPrompt(input, { skill: "speaking", part });
}
export function selectIndependentPracticePrompt(
  input: PromptScheduleInput,
  target: Pick<PromptAssignment, "skill" | "taskType" | "part">,
): PromptAssignment & { repeat: boolean } {
  const fresh = scheduledPrompt(
    {
      ...input,
      pool: "practice",
      continueCurrent: false,
      prepared: undefined,
      historyScope: "account",
    },
    target,
  );
  if (fresh.prompt) return { ...fresh, repeat: false };
  const unseen = unattemptedPrompts(
    { ...input, historyScope: "account" },
    target.skill,
  );
  const prompt = practicePrompts(input.prompts)
    .filter(
      (prompt) =>
        prompt.skill === target.skill &&
        (prompt.skill === "writing"
          ? prompt.taskType === target.taskType
          : prompt.part === target.part) &&
        !unseen.has(prompt),
    )
    .sort(
      (a, b) =>
        compareText(a.id, b.id) ||
        compareText(a.version, b.version) ||
        compareText(a.contentHash, b.contentHash),
    )[0];
  return {
    ...fresh,
    prompt: prompt ?? null,
    status: prompt ? "assigned" : "missing",
    repeat: !!prompt,
    notice: prompt
      ? "本类就绪新题已练完，已安排做过的原题复习；本次保留重复练习标记，不算未见新题。"
      : "暂缺本类可用练习材料；已有作品保留，不使用检查池或生成题补齐。",
  };
}
export function writingPromptReferences(
  drafts: readonly WritingDraft[],
): PromptWorkReference[] {
  return drafts
    .filter((draft) => draft.prompt.trim())
    .map((draft) => ({
      skill: "writing",
      date: draft.date,
      taskId: draft.taskId,
      taskType: draft.taskType,
      contentId: draft.contentId,
      contentVersion: draft.contentVersion,
      prompt: draft.prompt,
      updatedAt: draft.updatedAt,
    }));
}
export function selectScheduledWritingPrompts(
  input: PromptScheduleInput,
): PromptAssignment[] {
  if (input.plannedMinutes <= 0 || input.day < 1 || input.day > 365) return [];
  const types: ("task1" | "task2")[] =
    input.plannedMinutes >= 60
      ? ["task1", "task2"]
      : [input.plannedMinutes <= 20 ? "task1" : "task2"];
  const prepared = input.prepared ?? createPromptSelectionContext(input);
  return types.map((taskType) =>
    selectWritingPrompt({ ...input, prepared }, taskType),
  );
}
export function selectScheduledSpeakingPrompts(
  input: PromptScheduleInput,
): PromptAssignment[] {
  if (input.plannedMinutes <= 0 || input.day < 1 || input.day > 365) return [];
  const prepared = input.prepared ?? createPromptSelectionContext(input);
  return ([1, 2, 3] as const).map((part) =>
    selectSpeakingPrompt({ ...input, prepared }, part),
  );
}
export function canChooseWritingPrompt(draft: WritingDraft): boolean {
  return (
    draft.stage === "draft" &&
    !draft.baseRevision &&
    !draft.parentRevisionId &&
    !draft.retestOf &&
    !draft.text.trim() &&
    !draft.outline.trim() &&
    draft.timer.elapsedSeconds === 0 &&
    draft.timer.runningSince === null
  );
}
export function writingWithPrompt(
  draft: WritingDraft,
  prompt: LocalPrompt,
): WritingDraft {
  if (
    prompt.skill !== "writing" ||
    prompt.taskType !== draft.taskType ||
    !practicePrompts([prompt]).length ||
    !canChooseWritingPrompt(draft)
  )
    return draft;
  return {
    ...draft,
    prompt: prompt.prompt,
    contentId: prompt.id,
    contentVersion: prompt.version,
    sourceRef: prompt.sourceRef,
    tableDescription: undefined,
    materialSelfCheck: [],
  };
}
export function speakingWithPrompt(
  draft: SpeakingDraft,
  prompt: LocalPrompt,
): SpeakingDraft {
  if (
    prompt.skill !== "speaking" ||
    prompt.part !== draft.part ||
    !practicePrompts([prompt]).length ||
    draft.baseRevision ||
    draft.retestOf ||
    draft.transcript.trim() ||
    draft.recordingId ||
    draft.durationSeconds ||
    draft.prepSeconds
  )
    return draft;
  const id = crypto.randomUUID();
  return {
    ...draft,
    id,
    recordId: id,
    prompt: prompt.prompt,
    contentId: prompt.id,
    contentVersion: prompt.version,
    sourceRef: prompt.sourceRef,
  };
}
export interface PromptRetestContext {
  date: string;
  taskId: string;
  correctionId?: string;
  retestOf?: string;
}
/** This identifies one local work, not a revision. Including the exact material hash prevents draft reuse after question changes. */
export async function retestWorkId(
  scope: string,
  planId: string,
  context: PromptRetestContext,
  materialKey: string,
): Promise<string> {
  if (!context.correctionId || !context.retestOf || !materialKey)
    throw new Error("复测链接缺少准确订正、原稿或题目。请从订正页重新进入。");
  const input = JSON.stringify([
    scope,
    planId,
    context.date,
    context.taskId,
    context.correctionId,
    context.retestOf,
    materialKey,
  ]);
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes.slice(0, 16)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function matchesRetestWork(
  work: Revision,
  id: string,
  planId: string,
  context: PromptRetestContext,
  prompt: LocalPrompt,
): boolean {
  return (
    !work.deleted &&
    !work.conflict &&
    work.id === id &&
    work.planId === planId &&
    work.kind === (prompt.skill === "writing" ? "essay" : "speaking") &&
    work.payload.date === context.date &&
    work.payload.taskId === context.taskId &&
    work.payload.correctionId === context.correctionId &&
    work.payload.retestOf === context.retestOf &&
    work.payload.contentId === prompt.id &&
    work.payload.contentVersion === prompt.version &&
    (prompt.skill === "writing"
      ? work.payload.taskType === prompt.taskType
      : work.payload.part === prompt.part)
  );
}
