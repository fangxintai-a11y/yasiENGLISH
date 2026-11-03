import { z } from "zod";
import { ERROR_CAUSES } from "../../study365/protocol";
export const HalfBandSchema = z.number().min(0).max(9).refine((value) => Number.isInteger(value * 2), "分数必须使用半分档。");
export const EvidenceSchema = z.strictObject({ kind: z.enum(["span", "metric", "rule"]), ruleId: z.string().max(80).optional(),
  text: z.string().max(600).optional(), start: z.int().min(0).optional(), end: z.int().min(0).optional(),
  metric: z.string().max(60).optional(), value: z.number().optional(), message: z.string().min(1).max(300),
}).superRefine((value, ctx) => {
  if (value.kind === "span" && (value.text === undefined || value.start === undefined || value.end === undefined || value.end <= value.start))
    ctx.addIssue({ code: "custom", path: ["text"], message: "原文证据必须包含片段及有效起止位置。" });
  if (value.kind === "metric" && (!value.metric || value.value === undefined)) ctx.addIssue({ code: "custom", path: ["metric"], message: "指标证据必须包含名称与数值。" });
  if (value.kind === "rule" && !value.ruleId) ctx.addIssue({ code: "custom", path: ["ruleId"], message: "规则证据必须包含规则标识。" });
});
const criterion = z.strictObject({ band: HalfBandSchema.nullable(), confidence: z.number().min(0).max(1), evidence: z.array(EvidenceSchema).max(12) })
  .superRefine((value, ctx) => { if (value.band === null && value.confidence !== 0) ctx.addIssue({ code: "custom", path: ["confidence"], message: "未评分维度的可信度必须为0。" }); });
const pronunciation = criterion.superRefine((value, ctx) => { if (value.confidence > .3) ctx.addIssue({ code: "custom", path: ["confidence"], message: "文字证据的发音估分可信度不得超过0.3。" }); });
const feedback = { causes: z.array(z.enum(ERROR_CAUSES)).max(8), rewrite8: z.string().max(4000), summaryZh: z.string().max(800) };
export const Task1FeedbackSchema = z.strictObject({ criteria: z.strictObject({ taskAchievement: criterion, coherence: criterion, lexical: criterion, grammar: criterion }), ...feedback });
export const Task2FeedbackSchema = z.strictObject({ criteria: z.strictObject({ taskResponse: criterion, coherence: criterion, lexical: criterion, grammar: criterion }), ...feedback });
export const SpeakingFeedbackSchema = z.strictObject({ criteria: z.strictObject({ fluency: criterion, lexical: criterion, grammar: criterion, pronunciation }), ...feedback });
export const SentenceGradeSchema = z.strictObject({ score: z.int().min(0).max(3), usedCorrectly: z.boolean(), verdict: z.string().max(200),
  corrected: z.string().max(1000), better: z.string().max(1000), notes: z.array(z.string().max(200)).max(3) });
export const ReadingSchema = z.strictObject({ title: z.string().min(1).max(300), passage: z.string().min(1).max(20000), zh: z.string().max(20000),
  questions: z.array(z.strictObject({ q: z.string().min(1).max(600), a: z.enum(["TRUE", "FALSE", "NOT GIVEN"]), why: z.string().min(1).max(1200) })).min(5).max(12) });
export const HackSchema = z.strictObject({ homophone: z.string().max(400), split: z.string().max(400), scene: z.string().max(400) });
export const SentenceResultSchema = SentenceGradeSchema.extend({ source: z.enum(["rules", "ai"]), provider: z.string().max(80).nullable(), confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema).max(12), cause: z.enum(ERROR_CAUSES).nullable(), fallbackTrail: z.array(z.strictObject({ provider: z.string().max(80), error: z.enum(["no-provider", "auth", "quota", "network", "timeout", "cancelled", "bad-json", "schema", "http"]) })).max(32), needsManual: z.boolean().optional() });
export type FeedbackBody = z.infer<typeof Task1FeedbackSchema> | z.infer<typeof Task2FeedbackSchema> | z.infer<typeof SpeakingFeedbackSchema>;
export type SentenceBody = z.infer<typeof SentenceGradeSchema>;
