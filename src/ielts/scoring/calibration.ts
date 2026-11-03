import { hashPayload, validatePayload, type LearningPayload } from "../../study365/protocol";
import { SpeakingFeedbackSchema, Task1FeedbackSchema, Task2FeedbackSchema } from "./schemas";
import { assertNoSecrets } from "./privacy";
import type { FeedbackWork, MachineSource, SpeakingResult, WritingResult } from "./types";
function validatedBands(result: WritingResult | SpeakingResult) {
  assertNoSecrets(result);
  if (result.source !== "rules" && result.source !== "ai") throw new Error("机器反馈来源只能为rules或ai。");
  const criteria = Object.fromEntries(Object.entries(result.criteria).map(([key, value]) => [key, { band: value.band, confidence: value.confidence, evidence: value.evidence }]));
  const body = { criteria, causes: result.causes, rewrite8: result.rewrite8, summaryZh: result.summaryZh };
  (result.taskType === "task1" ? Task1FeedbackSchema : result.taskType === "task2" ? Task2FeedbackSchema : SpeakingFeedbackSchema).parse(body);
  if (result.source === "rules" && Object.values(result.criteria).some((value) => value.band !== null || value.confidence !== 0)) throw new Error("本地写作和口语反馈必须保留未评估分数。");
  return Object.fromEntries(Object.entries(result.criteria).map(([key, value]) => [key, value.band]));
}
/** Async so the supplied original is checked against P1's exact UTF-8 hash. */
export async function toFeedbackPayload(result: WritingResult | SpeakingResult, work: FeedbackWork): Promise<LearningPayload> {
  assertNoSecrets(work);
  const kind = result.kind === "writing" ? "essay" : "speaking";
  const hash = await hashPayload(kind, kind === "essay" ? { text: work.text } : { transcript: work.text });
  if (hash !== result.inputHash) throw new Error("评分对应的原稿已经变化，请对当前原稿重新评分。");
  const bands = validatedBands(result);
  const lines = [result.summaryZh, ...Object.entries(result.criteria).flatMap(([key, value]) => [
    `${key}：${value.band === null ? "未评估" : value.band}`,
    ...value.evidence.slice(0, 3).map((item) => `${item.message}${item.text ? `\n原文：${item.text}` : ""}`),
  ]), ...result.warnings.slice(0, 8), result.rewrite8 ? `8分参考表达：\n${result.rewrite8}` : ""].filter(Boolean);
  const payload: LearningPayload = { planId: work.planId, workId: work.workId, workRevisionId: work.workRevisionId, inputHash: hash,
    rubricVersion: result.rubricVersion, source: result.source, sourceText: result.provider === "manual" ? "复制提示词后回填的机器反馈" : result.source === "rules" ? "本地规则的指标与证据" : "自动接口返回的机器反馈",
    assessedAt: result.assessedAt, text: lines.join("\n").slice(0, 20000), bands };
  if (result.kind === "writing") payload.taskType = result.taskType;
  validatePayload("feedback", payload);
  return payload;
}
export function toCalibrationSidecar(result: WritingResult | SpeakingResult): { machineSource: MachineSource; machineBands: Record<string, number | null> } {
  return { machineSource: result.source, machineBands: validatedBands(result) };
}
