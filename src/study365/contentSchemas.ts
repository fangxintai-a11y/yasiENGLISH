import { z } from "zod";

const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
const source = z.strictObject({
  kind: z.literal("original"),
  rights: z.literal("project-authored"),
  reviewStatus: z.enum(["draft", "reviewed"]),
  author: text,
  reviewNote: text,
  reviewer: text.optional(),
  reviewedAt: z.iso.date().optional(),
}).superRefine((value, ctx) => {
  if (value.reviewStatus === "reviewed" && (!value.reviewer || !value.reviewedAt))
    ctx.addIssue({ code: "custom", message: "审校完成必须有审校者和日期。" });
});
const common = {
  id,
  version: text.max(120),
  materialLevel: z.literal("foundation"),
  deliveryMode: z.literal("builtin"),
  title: text.max(200),
  instructions: z.array(text).min(1).max(12),
  estimatedMinutes: z.number().int().positive().max(180),
  source,
  isCheckpoint: z.boolean(),
};
const answer = z.strictObject({ accepted: z.array(text.max(120)).min(1).max(12), maxWords: z.number().int().positive().max(10) });
const question = { id, prompt: text.max(500), answer };
const evidence = z.strictObject({ quote: text.max(1000) });
const listening = z.strictObject({
  ...common,
  skill: z.literal("listening"),
  type: z.literal("short-listening"),
  audio: z.strictObject({
    path: z.string().regex(/^audio\/[a-z0-9-]+\.wav$/),
    durationSeconds: z.number().positive().max(600),
  }),
  transcript: text.max(8000),
  segments: z.array(z.strictObject({ id, text })).min(1).max(30),
  questions: z.array(z.strictObject({
    ...question,
    evidence: evidence.extend({ startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() }),
  })).min(1).max(40),
});
const reading = z.strictObject({
  ...common,
  skill: z.literal("reading"),
  type: z.literal("short-reading"),
  passage: text.max(8000),
  questions: z.array(z.strictObject({ ...question, evidence })).min(1).max(40),
});
const writing = z.strictObject({
  ...common,
  skill: z.literal("writing"),
  type: z.literal("foundation-paragraph"),
  prompt: text.max(2000),
  minWords: z.number().int().nonnegative(),
  maxWords: z.number().int().positive(),
  selfCheck: z.array(text).min(1).max(12),
  example: text.max(8000),
});
const speaking = z.strictObject({
  ...common,
  skill: z.literal("speaking"),
  type: z.literal("foundation-short-answer"),
  prompts: z.array(text).min(1).max(12),
  suggestedSeconds: z.number().int().positive().max(600),
  reviewChecklist: z.array(text).min(1).max(12),
});
export const MaterialSchema = z.discriminatedUnion("skill", [listening, reading, writing, speaking]);
export type Material = z.infer<typeof MaterialSchema>;

/** R0 foundation format, not a general IELTS paper parser or band-scoring schema. */
export const ContentCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  version: text.max(120),
  purpose: text,
  materials: z.array(MaterialSchema).min(1).max(1000),
}).superRefine((catalog, ctx) => {
  const identifiers = new Set<string>();
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  catalog.materials.forEach((material, index) => {
    const at = ["materials", index];
    if (identifiers.has(material.id)) fail([...at, "id"], "材料ID重复。");
    identifiers.add(material.id);
    if (material.skill === "writing" && material.minWords > material.maxWords)
      fail([...at, "minWords"], "建议字数下限超过上限。");
    if (material.skill !== "listening" && material.skill !== "reading") return;
    const original = material.skill === "listening" ? material.transcript : material.passage;
    if (material.skill === "listening") {
      if (material.segments.map((segment) => segment.text).join(" ") !== material.transcript)
        fail([...at, "segments"], "音频段文本与完整文本不一致。");
      if (new Set(material.segments.map((segment) => segment.id)).size !== material.segments.length)
        fail([...at, "segments"], "音频段ID重复。");
      material.questions.forEach((item, qIndex) => {
        if (item.evidence.startSeconds >= item.evidence.endSeconds || item.evidence.endSeconds > material.audio.durationSeconds)
          fail([...at, "questions", qIndex, "evidence"], "证据时码超出音频范围。");
      });
    }
    material.questions.forEach((item, qIndex) => {
      const qAt = [...at, "questions", qIndex];
      if (identifiers.has(item.id)) fail([...qAt, "id"], "题目ID重复。");
      identifiers.add(item.id);
      if (!original.includes(item.evidence.quote)) fail([...qAt, "evidence"], "证据不在对应原文中。");
      if (new Set(item.answer.accepted.map((value) => value.toLowerCase())).size !== item.answer.accepted.length)
        fail([...qAt, "answer"], "接受答案重复。");
      if (item.answer.accepted.some((value) => value.split(/\s+/).length > item.answer.maxWords))
        fail([...qAt, "answer"], "接受答案超过该题词数限制。");
    });
  });
});
export type ContentCatalog = z.infer<typeof ContentCatalogSchema>;
