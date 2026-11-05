import {
  assertNoCredentials,
  scoreWriting,
  toFeedbackPayload,
  type WritingResult,
} from "../ielts/scoring";
import {
  hashPayload,
  validatePayload,
  validateWritingFeedbackReference,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { writingCauseOptions, writingRubric } from "./writingRubric";

export interface SpellingItem {
  start: number;
  end: number;
  text: string;
  confirmed: boolean;
}
export interface SpellingCheck {
  status: "unchecked" | "checked";
  count: number | null;
  items: SpellingItem[];
}
export interface SelfReview {
  spellingCheck: SpellingCheck;
  checklist: Record<string, boolean | null>;
  errorCauses: string[];
  otherExplanation: string;
  bands: Record<string, number | null>;
}
export function spellingTokens(text: string): SpellingItem[] {
  return [...text.matchAll(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    confirmed: true,
  }));
}
export function checkedSpelling(check: SpellingCheck): SpellingCheck {
  return {
    ...check,
    status: "checked",
    count: check.items.filter((item) => item.confirmed).length,
  };
}
export function toggleSpelling(
  check: SpellingCheck,
  token: SpellingItem,
): SpellingCheck {
  const exists = check.items.some(
    (item) => item.start === token.start && item.end === token.end,
  );
  const items = exists
    ? check.items.map((item) =>
        item.start === token.start && item.end === token.end
          ? { ...item, confirmed: !item.confirmed }
          : item,
      )
    : [...check.items, { ...token, confirmed: true }].sort(
        (a, b) => a.start - b.start,
      );
  return check.status === "checked"
    ? checkedSpelling({ ...check, items })
    : { ...check, items, count: null };
}
export function emptySelfReview(
  taskType: "task1" | "task2",
  causes: readonly string[] = [],
): SelfReview {
  return {
    spellingCheck: { status: "unchecked", count: null, items: [] },
    checklist: Object.fromEntries(
      writingRubric(taskType).map((item) => [item.id, null]),
    ),
    errorCauses: [...new Set(causes)].filter((cause) =>
      writingCauseOptions(taskType).some((item) => item.id === cause),
    ),
    otherExplanation: "",
    bands: Object.fromEntries(
      [
        taskType === "task1" ? "taskAchievement" : "taskResponse",
        "coherence",
        "lexical",
        "grammar",
      ].map((key) => [key, null]),
    ),
  };
}
function original(work: Revision) {
  if (
    work.kind !== "essay" ||
    work.deleted ||
    work.conflict ||
    work.payload.stage === "draft" ||
    !["task1", "task2"].includes(String(work.payload.taskType))
  )
    throw new Error("请先提交并选定这一版原稿。");
  return {
    taskType: work.payload.taskType as "task1" | "task2",
    text: String(work.payload.text ?? ""),
    prompt: String(work.payload.prompt ?? ""),
  };
}
export async function buildSelfReviewPayload(
  work: Revision,
  state: SelfReview,
  now = Date.now(),
): Promise<LearningPayload> {
  const input = original(work);
  const hash = await hashPayload("essay", { text: input.text });
  if (hash !== work.contentHash)
    throw new Error("原稿已变化，请重新读取当前版本。");
  const causes = [...new Set(state.errorCauses)];
  if (
    causes.some(
      (cause) =>
        !writingCauseOptions(input.taskType).some(
          (option) => option.id === cause,
        ),
    )
  )
    throw new Error("错因与写作任务类型不匹配。");
  if (causes.includes("other") && !state.otherExplanation.trim())
    throw new Error("选择其他错因时请填写说明。");
  const spelling =
    state.spellingCheck.status === "checked"
      ? checkedSpelling(state.spellingCheck)
      : { ...state.spellingCheck, count: null };
  const payload: LearningPayload = {
    planId: work.planId,
    workId: work.id,
    workRevisionId: work.revisionId,
    inputHash: hash,
    taskType: input.taskType,
    rubricVersion: "bg-writing-self-r2-2026.11",
    source: "self",
    sourceText: "学习者逐项自查",
    assessedAt: now,
    text: `写作自查。${state.otherExplanation.trim() ? `\n其他错因说明：${state.otherExplanation.trim()}` : ""}`,
    bands: { ...state.bands },
    errorCauses: causes,
    spellingCheck: spelling,
    checklist: { ...state.checklist },
  };
  assertNoCredentials(payload);
  validatePayload("feedback", payload);
  validateWritingFeedbackReference(payload, work.payload);
  return payload;
}
export async function runWritingRules(
  work: Revision,
): Promise<{ result: WritingResult; payload: LearningPayload }> {
  const input = original(work);
  let result = await scoreWriting(input, { mode: "rules" });
  if (work.payload.scope === "paragraph") {
    const criteria = Object.fromEntries(
      Object.entries(result.criteria).map(([key, value]) => [
        key,
        {
          ...value,
          evidence: value.evidence.filter(
            (item) => !item.ruleId?.startsWith("w.wordcount.min"),
          ),
        },
      ]),
    );
    result = {
      ...result,
      criteria,
      causes: result.causes.filter((cause) => cause !== "word-limit"),
      warnings: result.warnings.filter((item) => !item.startsWith("字数不足")),
    } as WritingResult;
  }
  const payload = await toFeedbackPayload(result, {
    planId: work.planId!,
    workId: work.id,
    workRevisionId: work.revisionId,
    text: input.text,
  });
  return { result, payload };
}
export function feedbackForWork(
  records: readonly Revision[],
  work: Revision,
): Revision[] {
  const heads = new Map<string, Revision>();
  for (const r of [...records].sort(
    (a, b) => b.createdAt - a.createdAt || b.seq - a.seq,
  ))
    if (!heads.has(r.id)) heads.set(r.id, r);
  return [...heads.values()].filter(
    (r) =>
      r.kind === "feedback" &&
      !r.deleted &&
      !r.conflict &&
      r.planId === work.planId &&
      r.payload.planId === work.planId &&
      r.payload.workId === work.id &&
      r.payload.workRevisionId === work.revisionId &&
      r.payload.inputHash === work.contentHash,
  );
}
export function restoreSelfReview(
  work: Revision,
  feedback?: Revision,
): SelfReview {
  const state = emptySelfReview(original(work).taskType);
  if (!feedback) return state;
  const p = feedback.payload;
  return {
    ...state,
    ...(p.spellingCheck
      ? { spellingCheck: p.spellingCheck as unknown as SpellingCheck }
      : {}),
    checklist: { ...state.checklist, ...(p.checklist as object) },
    bands: { ...state.bands, ...(p.bands as object) },
    errorCauses: Array.isArray(p.errorCauses)
      ? (p.errorCauses as string[])
      : [],
    otherExplanation: String(p.text ?? "").split("\n其他错因说明：")[1] ?? "",
  };
}
