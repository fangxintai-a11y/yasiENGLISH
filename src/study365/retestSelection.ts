import { type MaterialSource, type Revision } from "./protocol";
import type { LocalMaterial } from "./localBankSchema";
import {
  buildCorrection,
  civilDayDistance,
  completedListeningReadingReview,
  correctionItemKey,
  correctionOriginal,
  type CorrectionContext,
  type CorrectionDraft,
  type CorrectionItem,
  type CorrectionPayload,
} from "./correctionModel";
import { correctionDimension, type CorrectionCause } from "./correctionRules";

/** A private imported question. The original question/graphic stays in the local bank. */
export interface RetestPrompt {
  id: string;
  version: string;
  contentHash: string;
  skill: "writing" | "speaking";
  prompt: string;
  sourceRef: string;
  materialSource: MaterialSource;
  pool?: "practice" | "holdout";
  taskType?: "task1" | "task2";
  questionType?: string;
  part?: 1 | 2 | 3;
  stimulusHash?: string;
  ready?: boolean;
  estimatedMinutes?: number;
}
export interface RetestContext extends CorrectionContext {
  materials: readonly LocalMaterial[];
  prompts: readonly RetestPrompt[];
  /** Pure answer-review projection for this retest, keyed by question ID. */
  questionResults?: Readonly<
    Record<string, { correct: boolean; excluded?: boolean }>
  >;
}
export type RetestMaterial = LocalMaterial | RetestPrompt;
export type RetestReason =
  | "ready"
  | "waiting-correction"
  | "next-day"
  | "complete"
  | "missing-source"
  | "missing-classification"
  | "missing-material";
export interface RetestSelection {
  material: RetestMaterial | null;
  missingCount: number;
  reason: RetestReason;
  notice: string;
  correctionId: string;
  retestOf: string | null;
  targetKeys: string[];
  estimatedMinutes: number | null;
}
const normalized = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const body = (material: LocalMaterial) =>
  normalized(
    material.skill === "reading" ? material.passage : material.transcript,
  );
const paperSource = (material: RetestMaterial): MaterialSource =>
  "source" in material
    ? material.source.materialSource
    : material.materialSource;
const promptIdentity = (material: RetestPrompt) =>
  `${material.skill}:${normalized(material.prompt)}:${material.taskType === "task1" ? (material.stimulusHash ?? "?") : ""}`;
export function estimatedRetestMinutes(
  material: RetestMaterial,
  original: Revision,
): number {
  if (!("questions" in material) && material.skill === "writing")
    return material.taskType === "task1" ||
      original.payload.scope === "paragraph"
      ? 20
      : 40;
  if (
    typeof material.estimatedMinutes === "number" &&
    material.estimatedMinutes > 0
  )
    return material.estimatedMinutes;
  if ("questions" in material)
    return material.scope === "full"
      ? material.skill === "reading"
        ? 60
        : 30
      : material.scope === "type-drill"
        ? 5
        : material.skill === "reading"
          ? 20
          : material.audio
            ? Math.ceil(material.audio.durationSeconds / 60) + 1
            : 20;
  return material.part === 2 ? 3 : material.part === 1 ? 1 : 2;
}
function exactMaterial(work: Revision, materials: readonly LocalMaterial[]) {
  return materials.find(
    (material) =>
      material.id === work.payload.contentId &&
      material.version === work.payload.contentVersion &&
      material.contentHash === work.payload.contentHash &&
      material.skill === work.payload.skill,
  );
}
function exactPrompt(work: Revision, prompts: readonly RetestPrompt[]) {
  const actualPrompt =
    work.kind === "essay" && work.payload.taskType === "task1"
      ? String(work.payload.prompt ?? "").split("\n\n题图文字说明：")[0]
      : String(work.payload.prompt ?? "");
  return prompts.find(
    (prompt) =>
      prompt.id === work.payload.contentId &&
      prompt.version === work.payload.contentVersion &&
      prompt.skill === (work.kind === "essay" ? "writing" : "speaking") &&
      normalized(prompt.prompt) === normalized(actualPrompt) &&
      (work.kind === "essay"
        ? prompt.taskType === work.payload.taskType
        : prompt.part === work.payload.part),
  );
}
function correctionPayload(
  correction: Revision,
  context: RetestContext,
): CorrectionPayload {
  if (
    correction.kind !== "correction" ||
    correction.deleted ||
    correction.conflict ||
    correction.planId !== context.planId ||
    correction.payload.planId !== context.planId ||
    !Array.isArray(correction.payload.items)
  )
    throw new Error("请使用当前计划的有效订正记录。");
  return correction.payload as CorrectionPayload;
}
function promptReady(prompt: RetestPrompt): boolean {
  return (
    prompt.ready !== false &&
    !!prompt.prompt.trim() &&
    (prompt.skill !== "writing" ||
      prompt.taskType !== "task1" ||
      (typeof prompt.stimulusHash === "string" &&
        /^[a-f0-9]{64}$/.test(prompt.stimulusHash)))
  );
}
/** A changed ID, question numbering, title, or source alias cannot make an old original new. */
export function unseenListeningReading(
  material: LocalMaterial,
  records: readonly Revision[],
  bank: readonly LocalMaterial[],
  planId: string,
): boolean {
  const seen = records.filter(
    (record) =>
      record.kind === "attempt" &&
      record.planId === planId &&
      record.payload.planId === planId &&
      !record.deleted &&
      !record.conflict,
  );
  const known = seen
    .map((record) => exactMaterial(record, bank))
    .filter((item): item is LocalMaterial => !!item);
  if (
    seen.some(
      (record) =>
        record.payload.contentId === material.id &&
        record.payload.contentVersion === material.version &&
        record.payload.contentHash === material.contentHash,
    )
  )
    return false;
  if (known.some((item) => body(item) && body(item) === body(material)))
    return false;
  if (
    material.skill === "listening" &&
    known.some(
      (item) =>
        item.skill === "listening" &&
        ((material.audio?.sha256 &&
          item.audio?.sha256 === material.audio.sha256) ||
          item.audio?.path === material.audio?.path),
    )
  )
    return false;
  if (
    material.examId &&
    known.some(
      (item) =>
        item.skill === material.skill &&
        item.examId === material.examId &&
        (item.scope === "full" || material.scope === "full"),
    )
  )
    return false;
  return true;
}
function heldOutListeningReading(
  material: LocalMaterial,
  bank: readonly LocalMaterial[],
): boolean {
  return (
    material.pool === "holdout" ||
    bank.some(
      (item) =>
        item.pool === "holdout" &&
        item.skill === material.skill &&
        ((item.examId && item.examId === material.examId) ||
          (body(item) && body(item) === body(material)) ||
          (item.skill === "listening" &&
            material.skill === "listening" &&
            material.audio?.sha256 &&
            item.audio?.sha256 === material.audio.sha256)),
    )
  );
}
export function unseenPrompt(
  prompt: RetestPrompt,
  records: readonly Revision[],
  prompts: readonly RetestPrompt[],
  planId: string,
): boolean {
  const kind = prompt.skill === "writing" ? "essay" : "speaking";
  const seen = records.filter(
    (record) =>
      record.kind === kind &&
      record.planId === planId &&
      record.payload.planId === planId &&
      !record.deleted &&
      !record.conflict,
  );
  return !seen.some((record) => {
    const original = exactPrompt(record, prompts);
    if (original) return promptIdentity(original) === promptIdentity(prompt);
    return (
      normalized(String(record.payload.prompt ?? "")) ===
      normalized(prompt.prompt)
    );
  });
}
function promptHeldOut(
  prompt: RetestPrompt,
  prompts: readonly RetestPrompt[],
): boolean {
  return (
    prompt.pool === "holdout" ||
    prompts.some(
      (item) =>
        item.pool === "holdout" &&
        promptIdentity(item) === promptIdentity(prompt),
    )
  );
}
function rank(originalSource: MaterialSource | undefined) {
  return (a: RetestMaterial, b: RetestMaterial) => {
    const source = (item: RetestMaterial) =>
      ["official", "cambridge"].includes(paperSource(item)) ? 0 : 1;
    const scope = (item: RetestMaterial) =>
      "scope" in item
        ? item.scope === "type-drill"
          ? 0
          : item.scope === "section"
            ? 1
            : 2
        : 0;
    return (
      source(a) - source(b) ||
      Number(paperSource(a) !== originalSource) -
        Number(paperSource(b) !== originalSource) ||
      scope(a) - scope(b) ||
      a.id.localeCompare(b.id) ||
      b.version.localeCompare(a.version, undefined, { numeric: true })
    );
  };
}
function prepare(
  correction: Revision,
  context: RetestContext,
  targetKey?: string,
) {
  const payload = correctionPayload(correction, context),
    original = correctionOriginal(correction, context.records);
  const all = payload.items.filter((item) => item.status === "corrected"),
    items = targetKey
      ? all.filter((item) => correctionItemKey(item) === targetKey)
      : all;
  const result = (
    reason: RetestReason,
    notice: string,
    missingCount = 0,
  ): RetestSelection => ({
    material: null,
    reason,
    notice,
    missingCount,
    correctionId: correction.id,
    retestOf: original?.revisionId ?? null,
    targetKeys: items.map(correctionItemKey),
    estimatedMinutes: null,
  });
  if (payload.items.some((item) => item.status === "open"))
    return {
      payload,
      original,
      items,
      blocked: result(
        "waiting-correction",
        "请先完成本组订正；完成不代表掌握。",
      ),
    };
  if (!items.length)
    return {
      payload,
      original,
      items,
      blocked: result("complete", "没有待复测的已订正项。"),
    };
  if (civilDayDistance(context.date, payload.date) < 1)
    return {
      payload,
      original,
      items,
      blocked: result("next-day", "至少隔一个自然日，再用没做过的新题复测。"),
    };
  if (!original)
    return {
      payload,
      original,
      items,
      blocked: result(
        "missing-source",
        "原问题或原稿修订尚未在本机，暂时无法核对复测绑定。",
        1,
      ),
    };
  return { payload, original, items, blocked: null };
}
function candidates(
  correction: Revision,
  context: RetestContext,
  targetKey?: string,
): {
  selection: RetestSelection;
  candidates: RetestMaterial[];
  items: CorrectionItem[];
  original: Revision | null;
} {
  const prepared = prepare(correction, context, targetKey),
    { original, items } = prepared;
  if (prepared.blocked || !original)
    return { selection: prepared.blocked!, candidates: [], items, original };
  const result = (
    reason: RetestReason,
    notice: string,
    values: RetestMaterial[],
  ): RetestSelection => ({
    material: values[0] ?? null,
    reason,
    notice,
    missingCount: values.length ? 0 : 1,
    correctionId: correction.id,
    retestOf: original.revisionId,
    targetKeys: items.map(correctionItemKey),
    estimatedMinutes: values[0]
      ? estimatedRetestMinutes(values[0], original)
      : null,
  });
  let values: RetestMaterial[] = [];
  if (original.kind === "attempt") {
    const source = exactMaterial(original, context.materials);
    if (!source)
      return {
        selection: result(
          "missing-source",
          "本机缺少原版材料，无法确认原题题型（还缺1份）。",
          [],
        ),
        candidates: [],
        items,
        original,
      };
    const types = new Set(
      items
        .map(
          (item) =>
            source.questions.find((question) => question.id === item.questionId)
              ?.type,
        )
        .filter((type): type is NonNullable<typeof type> => !!type),
    );
    if (!types.size)
      return {
        selection: result(
          "missing-source",
          "订正题在原版材料中找不到，不能猜测题型（还缺1份）。",
          [],
        ),
        candidates: [],
        items,
        original,
      };
    values = context.materials
      .filter(
        (material) =>
          material.skill === source.skill &&
          material.questions.length > 0 &&
          material.scope !== "short" &&
          (material.skill === "reading" || !!material.audio) &&
          !heldOutListeningReading(material, context.materials) &&
          unseenListeningReading(
            material,
            context.records,
            context.materials,
            context.planId,
          ) &&
          material.questions.some((question) => types.has(question.type)),
      )
      .sort(rank(source.source.materialSource));
  } else {
    const source = exactPrompt(original, context.prompts),
      writing = original.kind === "essay";
    if (
      writing &&
      (!source?.questionType ||
        source.questionType === "unknown" ||
        !["task1", "task2"].includes(String(source.taskType)))
    )
      return {
        selection: result(
          "missing-classification",
          "原写作题没有明确题型分类，不能当作同题型新题（还缺1份）。",
          [],
        ),
        candidates: [],
        items,
        original,
      };
    const part = Number(original.payload.part);
    if (!writing && ![1, 2, 3].includes(part))
      return {
        selection: result(
          "missing-classification",
          "原口语作答的Part未知，不能猜测（还缺1份）。",
          [],
        ),
        candidates: [],
        items,
        original,
      };
    values = context.prompts
      .filter(
        (prompt) =>
          prompt.skill === (writing ? "writing" : "speaking") &&
          promptReady(prompt) &&
          !promptHeldOut(prompt, context.prompts) &&
          unseenPrompt(
            prompt,
            context.records,
            context.prompts,
            context.planId,
          ) &&
          (writing
            ? prompt.taskType === source!.taskType &&
              prompt.questionType === source!.questionType
            : prompt.part === part),
      )
      .sort(rank(source?.materialSource));
  }
  return {
    selection: result(
      values.length ? "ready" : "missing-material",
      values.length
        ? "已找到同科同型、未做过的新题；本轮复测不改门槛分。"
        : "该题型新题不够（还缺1份），不重复旧题凑数。",
      values,
    ),
    candidates: values,
    items,
    original,
  };
}
export function selectRetest(
  correction: Revision,
  context: RetestContext,
  targetKey?: string,
): RetestSelection {
  return candidates(correction, context, targetKey).selection;
}

/** URL parameters may choose an eligible alternative, never bypass the whole policy. */
export function assertRetestMaterialEligible(
  correction: Revision,
  material: RetestMaterial,
  context: RetestContext,
): void {
  const result = candidates(correction, context);
  if (result.selection.reason !== "ready")
    throw new Error(result.selection.notice);
  if (
    !result.candidates.some(
      (candidate) =>
        candidate.skill === material.skill &&
        candidate.id === material.id &&
        candidate.version === material.version &&
        candidate.contentHash === material.contentHash,
    )
  )
    throw new Error(
      "这份题目不符合订正复测条件，请重新选择同科同型、未做过且不在检查池的新题。",
    );
}

export interface RetestEvaluation {
  payload: CorrectionPayload;
  outcomes: { key: string; status: "retested-pass" | "retested-fail" }[];
  nextRound: CorrectionDraft | null;
  estimate: boolean;
  pending: string | null;
}
/** Updates only correction status. No assessment, score, source work or target is changed. */
export function evaluateRetest(
  correction: Revision,
  retest: Revision,
  context: RetestContext,
): RetestEvaluation {
  const payload = correctionPayload(correction, context);
  const pending = (message: string): RetestEvaluation => ({
    payload,
    outcomes: [],
    nextRound: null,
    estimate: false,
    pending: message,
  });
  if (
    retest.deleted ||
    retest.conflict ||
    retest.planId !== context.planId ||
    retest.payload.planId !== context.planId ||
    retest.payload.correctionId !== correction.id
  )
    return pending("复测与这条订正不一致。");
  const selectionContext = {
    ...context,
    records: context.records.filter((record) => record.id !== retest.id),
  };
  const selected = candidates(correction, selectionContext),
    { original, items } = selected;
  if (!original || selected.selection.reason !== "ready")
    return pending(selected.selection.notice);
  if (
    retest.id === original.id ||
    retest.payload.retestOf !== original.revisionId ||
    civilDayDistance(String(retest.payload.date), payload.date) < 1
  )
    return pending("复测必须隔天新建作答，并绑定原问题的准确修订。");
  const material = selected.candidates.find(
    (item) =>
      item.id === retest.payload.contentId &&
      item.version === retest.payload.contentVersion &&
      (!("questions" in item) ||
        item.contentHash === retest.payload.contentHash),
  );
  if (!material)
    return pending("这份作答不是符合条件的新材料，不能复用旧题或检查池。");
  const outcomes: RetestEvaluation["outcomes"] = [];
  let failedSource: Revision | null = null,
    estimate = false;
  if (
    original.kind === "attempt" &&
    retest.kind === "attempt" &&
    "questions" in material &&
    retest.payload.skill === original.payload.skill
  ) {
    if (
      retest.payload.firstAttempt !== true ||
      !completedListeningReadingReview(retest)
    )
      return pending(
        "请先完成新材料首答与复盘，不能把熟题或未复盘作答判为通过。",
      );
    const source = exactMaterial(original, context.materials)!;
    const results = new Map(
      (retest.payload.questionResults as Record<string, unknown>[]).map(
        (row) => [String(row.questionId), row],
      ),
    );
    for (const item of items) {
      const type = source.questions.find(
        (question) => question.id === item.questionId,
      )?.type;
      if (!type) continue;
      const questions = material.questions
        .filter((question) => question.type === type)
        .map((question) => {
          const overlaid = context.questionResults?.[question.id],
            row = results.get(question.id);
          return (
            overlaid ??
            (row
              ? {
                  correct: row.correct === true,
                  excluded: row.answerDisputed === true,
                }
              : null)
          );
        });
      if (questions.some((question) => question === null)) continue;
      const included = questions.filter(
        (question): question is { correct: boolean; excluded?: boolean } =>
          !!question && !question.excluded,
      );
      if (!included.length) continue;
      outcomes.push({
        key: correctionItemKey(item),
        status: included.every((question) => question.correct)
          ? "retested-pass"
          : "retested-fail",
      });
    }
    if (outcomes.some((outcome) => outcome.status === "retested-fail"))
      failedSource = retest;
  } else if (
    ["essay", "speaking"].includes(original.kind) &&
    retest.kind === original.kind &&
    !("questions" in material)
  ) {
    const actualPrompt = String(retest.payload.prompt ?? "").split(
      "\n\n题图文字说明：",
    )[0];
    if (
      normalized(actualPrompt) !== normalized(material.prompt) ||
      (original.kind === "essay" &&
        (retest.payload.taskType !== material.taskType ||
          retest.payload.scope !== original.payload.scope)) ||
      (original.kind === "speaking" && retest.payload.part !== material.part)
    )
      return pending("复测题目、Task范围或Part已改变，请使用选定的新题。");
    const feedback = context.records
      .filter(
        (record) =>
          record.kind === "feedback" &&
          !record.deleted &&
          !record.conflict &&
          record.planId === context.planId &&
          record.payload.planId === context.planId &&
          record.payload.workId === retest.id &&
          record.payload.workRevisionId === retest.revisionId &&
          record.payload.inputHash === retest.contentHash &&
          Array.isArray(record.payload.errorCauses),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)[0];
    if (!feedback)
      return pending("新作品还没有列明错因的同稿反馈，请完成自查或粘贴反馈。");
    const skill = retest.kind === "essay" ? "writing" : "speaking";
    const causes = feedback.payload.errorCauses as CorrectionCause[];
    const dimensions = new Set(
      causes.map((cause) =>
        correctionDimension(cause, skill, retest.payload.taskType),
      ),
    );
    for (const item of items)
      outcomes.push({
        key: correctionItemKey(item),
        status:
          causes.includes(item.errorCause) ||
          dimensions.has(String(item.dimension))
            ? "retested-fail"
            : "retested-pass",
      });
    estimate = !["human", "official"].includes(String(feedback.payload.source));
    if (outcomes.some((outcome) => outcome.status === "retested-fail"))
      failedSource = feedback;
  } else return pending("复测科目与原订正不一致。");
  if (!outcomes.length)
    return pending(
      "本次没有可判定的目标题型，或该题型全部有歧义；不能空集通过。",
    );
  const states = new Map(
    outcomes.map((outcome) => [outcome.key, outcome.status]),
  );
  const next = {
    ...payload,
    items: payload.items.map((item) => ({
      ...item,
      status: states.get(correctionItemKey(item)) ?? item.status,
    })),
  };
  const nextRound = failedSource
    ? buildCorrection(failedSource, context)
    : null;
  return { payload: next, outcomes, nextRound, estimate, pending: null };
}
