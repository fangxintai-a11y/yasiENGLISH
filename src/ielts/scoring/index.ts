import { z, type ZodType } from "zod";
import { SECTION_TARGETS, hashPayload, isRevisionId } from "../../study365/protocol";
import { requestStructured } from "../llm/structured";
import { createManualPrompt, validateManualResult } from "../llm/manual";
import { LlmError } from "../llm/types";
import { assertNoCredentials, CredentialPrivacyError } from "../llm/config";
import { toFeedbackPayload as mapFeedbackPayload, toCalibrationSidecar as mapCalibrationSidecar } from "./calibration";
import { assertNoSecrets, ScoringPrivacyError } from "./privacy";
import { buildTaskPrompt } from "./prompts";
import { HackSchema, ReadingSchema, SentenceGradeSchema, SentenceResultSchema, SpeakingFeedbackSchema, Task1FeedbackSchema, Task2FeedbackSchema, type FeedbackBody } from "./schemas";
import { scoreSentenceRules } from "./rules/sentence";
import { buildReadingRules } from "./rules/reading";
import { readingCoverage } from "./rules/readingCoverage";
import { buildHackRules } from "./rules/hack";
import { scoreWritingRules } from "./rules/writing";
import { scoreSpeakingRules } from "./rules/speaking";
import { RUBRIC_VERSION, type CriterionScore, type FallbackEntry, type FallbackInfo, type HackInput, type HackResult, type ReadingInput, type ReadingResult,
  type FeedbackWork, type ScoringContext, type SentenceInput, type SentenceResult, type SpeakingInput, type SpeakingResult, type TaskId, type WritingInput, type WritingResult } from "./types";
export * from "./types";
export * from "./schemas";
export { assertNoCredentials } from "../llm/config";
export { getFeedbackConfig, subscribeFeedbackConfig, saveFeedbackConfig, getCredential, setCredential, removeProvider, migrateLegacy } from "../llm/config";
export { testProvider } from "../llm/openaiCompatible";
export { PROVIDER_PRESETS, createProvider } from "../llm/presets";
export { TASK_LABELS, LlmError } from "../llm/types";
export type { ProviderConfig, FeedbackConfig } from "../llm/types";

function assertSafe(value: unknown): void { assertNoSecrets(value); assertNoCredentials(value); }
function checked<T>(value: T): T { assertSafe(value); return value; }
export async function toFeedbackPayload(result: WritingResult | SpeakingResult, work: FeedbackWork) {
  assertSafe(result); assertSafe(work);
  return checked(await mapFeedbackPayload(result, work));
}
export function toCalibrationSidecar(result: WritingResult | SpeakingResult) {
  assertSafe(result); return checked(mapCalibrationSidecar(result));
}
export function needsManualFallback(result: Partial<FallbackInfo>): boolean { return result.needsManual === true; }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new LlmError("cancelled"); }
class FeedbackContextError extends Error { constructor() { super("原稿已变化，请重新获取反馈。"); } }
function taskInput(task: TaskId, value: unknown) {
  assertSafe(value);
  const object = z.object({}).catchall(z.unknown()).parse(value);
  const text = (key: string, maximum = 20000) => z.string().max(maximum).parse(object[key]);
  if (task === "essay") {
    z.enum(["task1", "task2"]).parse(object.taskType); text("prompt", 8000); text("text");
    if (object.feedbackContext !== undefined) z.strictObject({ workRevisionId: z.string().refine(isRevisionId), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(object.feedbackContext);
  }
  if (task === "speaking") {
    z.union([z.literal(1), z.literal(2), z.literal(3)]).parse(object.part); text("prompt", 8000); text("transcript"); z.number().min(0).max(86400).parse(object.durationSeconds);
    if (object.feedbackContext !== undefined) z.strictObject({
      part: z.union([z.literal(1), z.literal(2), z.literal(3)]), prompt: z.string().max(8000), transcript: z.string().max(20000).refine(value => !!value.trim(), "请先填写转写。"), durationSeconds: z.number().min(0).max(86400),
      feedbackContext: z.strictObject({ workRevisionId: z.string().refine(isRevisionId), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }),
    }).parse(object);
  }
  if (task === "sentence") { text("word", 200); text("zh", 2000); text("sentence", 1000); }
  if (task === "reading") z.array(z.object({ id: z.string(), word: z.string(), zh: z.string(), entry: z.unknown() })).min(5).max(50).parse(object.words);
  if (task === "hack") { text("word", 120); text("ipa", 200); text("zh", 2000); }
  return object;
}
function taskSchema(task: TaskId, input: unknown): ZodType<unknown> {
  const value = taskInput(task, input);
  if (task === "sentence") return z.preprocess((raw) => { assertSafe(raw); return raw; }, SentenceGradeSchema).superRefine((body, ctx) => {
    const original = String(value.sentence);
    for (const [index, evidence] of (body.evidence ?? []).entries()) {
      if (evidence.kind === "span" && (Number(evidence.end) > original.length || original.slice(evidence.start, evidence.end) !== evidence.text))
        ctx.addIssue({ code: "custom", path: ["evidence", index], message: "证据片段与当前原句及字符位置不一致。" });
    }
  });
  if (task === "reading") return ReadingSchema;
  if (task === "hack") return HackSchema;
  const original = String(task === "essay" ? value.text : value.transcript);
  const context = (value as unknown as WritingInput | SpeakingInput).feedbackContext;
  const speakingSchema = context ? SpeakingFeedbackSchema.safeExtend({ criteria: SpeakingFeedbackSchema.shape.criteria.safeExtend({
    fluency: SpeakingFeedbackSchema.shape.criteria.shape.fluency.safeExtend({ band: z.null(), confidence: z.literal(0) }),
    pronunciation: SpeakingFeedbackSchema.shape.criteria.shape.pronunciation.safeExtend({ band: z.null(), confidence: z.literal(0) }),
  }) }) : SpeakingFeedbackSchema;
  const schema = task === "speaking" ? speakingSchema : value.taskType === "task1" ? Task1FeedbackSchema : Task2FeedbackSchema;
  const resultSchema = context ? schema.safeExtend({ workRevisionId: z.literal(context.workRevisionId), inputHash: z.literal(context.inputHash) }) : schema;
  return resultSchema.superRefine((body, ctx) => {
    for (const [key, criterion] of Object.entries(body.criteria)) for (const [index, evidence] of criterion.evidence.entries()) {
      if (evidence.kind === "span" && original.slice(evidence.start, evidence.end) !== evidence.text)
        ctx.addIssue({ code: "custom", path: ["criteria", key, "evidence", index], message: "证据片段与当前原稿及字符位置不一致。" });
    }
  });
}
export function manualPrompt(task: TaskId, input: unknown): { text: string; schemaName: string } {
  const schema = taskSchema(task, input), prompt = buildTaskPrompt(task, input);
  return checked({ ...createManualPrompt(prompt.system, prompt.user, schema), schemaName: task === "essay" ? String((input as WritingInput).taskType) : task });
}
function feedbackResult(task: "essay" | "speaking", input: WritingInput | SpeakingInput, wire: unknown, inputHash: string, provider: string, fallbackTrail: FallbackEntry[], now: number): WritingResult | SpeakingResult {
  let body = wire;
  if (input.feedbackContext) {
    const { workRevisionId: _revision, inputHash: _hash, ...value } = taskSchema(task, input).parse(wire) as Record<string, unknown>;
    body = value;
  }
  const parsed = (task === "speaking" ? SpeakingFeedbackSchema : (input as WritingInput).taskType === "task1" ? Task1FeedbackSchema : Task2FeedbackSchema).parse(body) as FeedbackBody;
  const target = task === "essay" ? SECTION_TARGETS.writing : SECTION_TARGETS.speaking;
  const criteria = Object.fromEntries(Object.entries(parsed.criteria).map(([key, value]) => [key, { ...value, target, gap: value.band === null ? null : Math.max(0, target - value.band) } satisfies CriterionScore]));
  const bands = Object.values(criteria).map((criterion) => criterion.band);
  const overall = bands.every((band) => band !== null) ? Math.round(bands.reduce<number>((sum, value) => sum + Number(value), 0) / 2) / 2 : null;
  const common = { rubricVersion: RUBRIC_VERSION, source: "ai" as const, provider, inputHash, assessedAt: now, criteria, overall, causes: parsed.causes, warnings: [], fallbackTrail, rewrite8: parsed.rewrite8, summaryZh: parsed.summaryZh };
  if (task === "speaking") return { ...common, kind: "speaking", taskType: "speaking", criteria: { fluency: criteria.fluency, lexical: criteria.lexical, grammar: criteria.grammar, pronunciation: criteria.pronunciation } };
  if ((input as WritingInput).taskType === "task1") return { ...common, kind: "writing", taskType: "task1", criteria: { taskAchievement: criteria.taskAchievement, coherence: criteria.coherence, lexical: criteria.lexical, grammar: criteria.grammar } };
  return { ...common, kind: "writing", taskType: "task2", criteria: { taskResponse: criteria.taskResponse, coherence: criteria.coherence, lexical: criteria.lexical, grammar: criteria.grammar } };
}
function wrapped(task: TaskId, input: unknown, wire: unknown, provider: string, trail: FallbackEntry[], now: number, rawHash = "") {
  assertSafe(wire);
  if (task === "sentence") {
    const value = SentenceGradeSchema.parse(wire);
    return SentenceResultSchema.parse({ ...value, source: "ai", provider, confidence: value.confidence ?? .6, evidence: value.evidence ?? [],
      cause: value.cause ?? null, warnings: value.warnings ?? [], fallbackTrail: trail }) as SentenceResult;
  }
  if (task === "reading") {
    const value = ReadingSchema.parse(wire), coverage = readingCoverage(input as ReadingInput, value.passage), words = coverage.coveredWordIds;
    return { ...value, id: `r-${now}-${words.join("-").slice(0, 40)}`, at: now, words, coverage, answers: value.questions.map(() => null), src: provider === "manual" ? "manual" as const : "ai" as const, fallbackTrail: trail } satisfies ReadingResult;
  }
  if (task === "hack") return { ...HackSchema.parse(wire), at: now, src: provider === "manual" ? "manual" as const : "ai" as const, fallbackTrail: trail } satisfies HackResult;
  return feedbackResult(task, input as WritingInput | SpeakingInput, wire, rawHash, provider, trail, now);
}
export async function acceptManual<T>(task: TaskId, pasted: string, input: unknown): Promise<{ ok: true; value: T } | { ok: false; errors: string[] }> {
  try {
    assertSafe(pasted);
    const parsed = validateManualResult(pasted, taskSchema(task, input));
    if (!parsed.ok) return parsed;
    let hash = "";
    if (task === "essay") {
      hash = await hashPayload("essay", { text: (input as WritingInput).text });
      const context = (input as WritingInput).feedbackContext;
      if (context && context.inputHash !== hash) throw new FeedbackContextError();
    }
    if (task === "speaking") {
      hash = await hashPayload("speaking", { transcript: (input as SpeakingInput).transcript });
      const context = (input as SpeakingInput).feedbackContext;
      if (context && context.inputHash !== hash) throw new FeedbackContextError();
    }
    return { ok: true, value: checked(wrapped(task, input, parsed.value, "manual", [], Date.now(), hash)) as T };
  } catch (error) { return { ok: false, errors: [error instanceof ScoringPrivacyError || error instanceof CredentialPrivacyError || error instanceof FeedbackContextError ? error.message : "输入或结果字段不符合要求，请核对原稿与JSON内容。"] }; }
}
async function enhance<T extends FallbackInfo>(task: TaskId, input: unknown, context: ScoringContext, local: T, now: number, hash = ""): Promise<T> {
  cancelled(context.signal);
  assertSafe(local);
  if (context.mode !== "auto") return local;
  try {
    const result = await requestStructured(task, taskSchema(task, input), buildTaskPrompt(task, input), { signal: context.signal });
    cancelled(context.signal);
    assertSafe(result.value);
    return checked(wrapped(task, input, result.value, result.provider, result.fallbackTrail, now, hash)) as unknown as T;
  } catch (error) {
    if (context.signal?.aborted || error instanceof LlmError && error.code === "cancelled") throw new LlmError("cancelled");
    const fallbackTrail: FallbackEntry[] = error instanceof LlmError && error.fallbackTrail.length ? error.fallbackTrail : [{ provider: "接口", error: "no-provider" }];
    return checked({ ...local, needsManual: true, fallbackTrail });
  }
}
export async function scoreSentence(input: SentenceInput, context: ScoringContext): Promise<SentenceResult> {
  cancelled(context.signal); taskInput("sentence", input); const local = scoreSentenceRules(input);
  return enhance("sentence", input, context, local, context.now ?? Date.now());
}
export async function buildReading(input: ReadingInput, context: ScoringContext): Promise<ReadingResult> {
  cancelled(context.signal); taskInput("reading", input); const now = context.now ?? Date.now(), value = buildReadingRules(input);
  const coverage = readingCoverage(input, value.passage);
  const local: ReadingResult = { ...value, id: `r-${now}-${input.words.map((word) => word.id).join("-").slice(0, 40)}`, at: now, words: coverage.coveredWordIds, coverage, answers: value.questions.map(() => null), src: "rules", fallbackTrail: [] };
  return enhance("reading", input, context, local, now);
}
export async function buildHack(input: HackInput, context: ScoringContext): Promise<HackResult> {
  cancelled(context.signal); taskInput("hack", input); const now = context.now ?? Date.now();
  return enhance("hack", input, context, { ...buildHackRules(input), at: now, src: "rules" as const, fallbackTrail: [] }, now);
}
export async function scoreWriting(input: WritingInput, context: ScoringContext): Promise<WritingResult> {
  cancelled(context.signal); taskInput("essay", input); const now = context.now ?? Date.now(), local = await scoreWritingRules(input, now);
  if (input.feedbackContext && input.feedbackContext.inputHash !== local.inputHash) throw new FeedbackContextError();
  return enhance("essay", input, context, local, now, local.inputHash);
}
export async function scoreSpeaking(input: SpeakingInput, context: ScoringContext): Promise<SpeakingResult> {
  cancelled(context.signal); taskInput("speaking", input); const now = context.now ?? Date.now(), local = await scoreSpeakingRules(input, now);
  if (input.feedbackContext && input.feedbackContext.inputHash !== local.inputHash) throw new FeedbackContextError();
  return enhance("speaking", input, context, local, now, local.inputHash);
}
