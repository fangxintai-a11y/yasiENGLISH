import { z } from "zod";

const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/);
export const MATERIAL_LEVELS = ["foundation", "intermediate", "advanced", "ielts-academic"] as const;
export const LISTENING_QUESTION_TYPES = ["multiple-choice", "matching", "map-labeling", "form-completion", "note-completion", "table-completion", "flow-chart-completion", "summary-completion", "sentence-completion", "short-answer"] as const;
export const READING_QUESTION_TYPES = ["multiple-choice", "true-false-not-given", "yes-no-not-given", "matching-headings", "matching-information", "matching-features", "matching-sentence-endings", "summary-completion", "note-completion", "table-completion", "flow-chart-completion", "diagram-label-completion", "sentence-completion", "short-answer"] as const;
const source = z.strictObject({
  kind: z.literal("original"), rights: z.literal("project-authored"), reviewStatus: z.enum(["draft", "reviewed"]),
  author: text, reviewNote: text, reviewer: text.optional(), reviewedAt: z.iso.date().optional(),
}).superRefine((value, ctx) => {
  if (value.reviewStatus !== "reviewed") return;
  if (!value.reviewer) ctx.addIssue({ code: "custom", path: ["reviewer"], message: "审校完成必须标明独立审校者。" });
  if (!value.reviewedAt) ctx.addIssue({ code: "custom", path: ["reviewedAt"], message: "审校完成必须标明日期。" });
});
const common = {
  id, version: text.max(120), materialLevel: z.enum(MATERIAL_LEVELS), deliveryMode: z.literal("builtin"),
  title: text.max(200), instructions: z.array(text).min(1).max(12), estimatedMinutes: z.number().int().positive().max(120),
  source, sourceFormatReference: z.url().regex(/^https:\/\/(?:www\.)?ielts\.org\//), isCheckpoint: z.boolean(),
  vocabulary: z.strictObject({ cefr: z.enum(["B1", "B2", "C1", "C2"]), awl: z.boolean(),
    items: z.array(z.strictObject({ headword: text.max(80), awlSublist: z.number().int().min(1).max(10).optional() })).min(1).max(50) }),
};
const answer = z.strictObject({ accepted: z.array(text.max(120)).min(1).max(12), maxWords: z.number().int().positive().max(10) });
const question = { id, prompt: text.max(1000), answer,
  options: z.array(z.strictObject({ id: text.max(20), text: text.max(500) })).min(2).max(20).optional(), paragraphId: id.optional() };
const evidence = z.strictObject({ quote: text.max(1800), rationale: text.max(1000).optional() });
const listening = z.strictObject({
  ...common, skill: z.literal("listening"), type: z.literal("ielts-listening-section"), section: z.number().int().min(1).max(4),
  audio: z.strictObject({ path: z.string().regex(/^audio\/[a-z0-9-]+\.wav$/), durationSeconds: z.number().positive().max(900) }),
  transcript: text.max(16000), segments: z.array(z.strictObject({ id, text })).min(1).max(40),
  questions: z.array(z.strictObject({ ...question, type: z.enum(LISTENING_QUESTION_TYPES),
    evidence: evidence.extend({ startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() }) })).length(10),
});
const reading = z.strictObject({
  ...common, skill: z.literal("reading"), type: z.literal("ielts-academic-reading"), passageNumber: z.number().int().min(1).max(3),
  passage: text.max(16000), paragraphs: z.array(z.strictObject({ id, text })).min(4).max(15),
  questions: z.array(z.strictObject({ ...question, type: z.enum(READING_QUESTION_TYPES), evidence })).min(10).max(15),
});
const writing = z.strictObject({
  ...common, skill: z.literal("writing"), type: z.literal("ielts-writing-task"), taskType: z.enum(["task1", "task2"]),
  prompt: text.max(4000), minWords: z.number().int().positive(), maxWords: z.number().int().positive(),
  taskData: z.strictObject({ kind: z.literal("table"), description: text, columns: z.array(text).min(2).max(12), rows: z.array(z.array(text).min(2).max(12)).min(2).max(20) }).optional(),
  selfCheck: z.array(text).min(1).max(12), example: text.max(12000),
});
const speaking = z.strictObject({
  ...common, skill: z.literal("speaking"), type: z.literal("ielts-speaking-part"), part: z.number().int().min(1).max(3),
  prompts: z.array(text).min(1).max(12), preparationSeconds: z.number().int().min(0).max(60),
  suggestedSeconds: z.number().int().positive().max(360), reviewChecklist: z.array(text).min(1).max(12), example: text.max(8000),
});
export const MaterialSchema = z.discriminatedUnion("skill", [listening, reading, writing, speaking]);
export type Material = z.infer<typeof MaterialSchema>;
export const countContentWords = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

/** IELTS task contracts; levels are chosen from measured baseline evidence, never calendar dates. */
export const ContentCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1), id, version: text.max(120), purpose: text, materials: z.array(MaterialSchema).min(1).max(1000),
}).superRefine((catalog, ctx) => {
  const identifiers = new Set<string>();
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  catalog.materials.forEach((material, index) => {
    const at = ["materials", index];
    if (identifiers.has(material.id)) fail([...at, "id"], "材料ID重复。");
    identifiers.add(material.id);
    if (material.skill === "writing") {
      const required = material.taskType === "task1" ? 150 : 250;
      const minutes = material.taskType === "task1" ? 20 : 40;
      if (material.minWords !== required) fail([...at, "minWords"], `对应任务最低字数必须为${required}。`);
      if (material.estimatedMinutes !== minutes) fail([...at, "estimatedMinutes"], `对应任务限时必须为${minutes}分钟。`);
      if (material.minWords > material.maxWords) fail([...at, "maxWords"], "建议上限低于任务最低字数。");
      if (countContentWords(material.example) < required) fail([...at, "example"], "写作示例不足该任务最低字数。");
      if (material.taskType === "task1" && !material.taskData) fail([...at, "taskData"], "Task 1需要可检查的数据表。");
      if (material.taskType === "task2" && material.taskData) fail([...at, "taskData"], "Task 2不应携带Task 1图表。");
      if (material.taskData?.rows.some((row) => row.length !== material.taskData!.columns.length)) fail([...at, "taskData", "rows"], "表格列数不一致。");
    }
    if (material.skill === "speaking") {
      if (material.part === 2 && material.preparationSeconds !== 60) fail([...at, "preparationSeconds"], "Part 2准备时间应为60秒。");
      if (material.part === 2 && material.suggestedSeconds !== 120) fail([...at, "suggestedSeconds"], "Part 2回答上限应为120秒。");
      if (material.part !== 2 && material.preparationSeconds !== 0) fail([...at, "preparationSeconds"], "Part 1/3不使用Part 2准备时间。");
    }
    if (material.skill !== "listening" && material.skill !== "reading") return;
    const original = material.skill === "listening" ? material.transcript : material.passage;
    if (material.skill === "reading") {
      const words = countContentWords(material.passage);
      if (words < 700 || words > 900) fail([...at, "passage"], "R0学术阅读样本必须为700至900词。");
      if (material.paragraphs.map((p) => p.text).join(" ") !== material.passage) fail([...at, "paragraphs"], "段落与完整文章不一致。");
      if (new Set(material.paragraphs.map((p) => p.id)).size !== material.paragraphs.length) fail([...at, "paragraphs"], "段落ID重复。");
    } else {
      if (countContentWords(material.transcript) < 450) fail([...at, "transcript"], "完整听力Section样本不能退化为短句练习。");
      if (material.segments.map((segment) => segment.text).join(" ") !== material.transcript) fail([...at, "segments"], "音频段文本与完整文本不一致。");
      if (new Set(material.segments.map((segment) => segment.id)).size !== material.segments.length) fail([...at, "segments"], "音频段ID重复。");
      material.questions.forEach((item, qIndex) => {
        if (item.evidence.startSeconds >= item.evidence.endSeconds || item.evidence.endSeconds > material.audio.durationSeconds) fail([...at, "questions", qIndex, "evidence"], "证据时码超出音频范围。");
      });
    }
    material.questions.forEach((item, qIndex) => {
      const qAt = [...at, "questions", qIndex];
      if (identifiers.has(item.id)) fail([...qAt, "id"], "题目ID重复。");
      identifiers.add(item.id);
      if (!original.includes(item.evidence.quote)) fail([...qAt, "evidence", "quote"], "证据不在对应原文中。");
      if (new Set(item.answer.accepted.map((value) => value.toLowerCase())).size !== item.answer.accepted.length) fail([...qAt, "answer", "accepted"], "接受答案重复。");
      if (item.answer.accepted.some((value) => countContentWords(value) > item.answer.maxWords)) fail([...qAt, "answer", "accepted"], "接受答案超过该题词数限制。");
      if (item.options && (new Set(item.options.map((option) => option.id)).size !== item.options.length || item.answer.accepted.some((value) => !item.options!.some((option) => option.id === value)))) fail([...qAt, "options"], "选项ID重复或答案没有对应选项。");
      if (["multiple-choice", "matching", "matching-headings", "matching-features", "matching-sentence-endings", "map-labeling"].includes(item.type) && !item.options) fail([...qAt, "options"], "选择或匹配题必须有候选选项。");
      if (item.type === "true-false-not-given" && item.answer.accepted.some((value) => !["TRUE", "FALSE", "NOT GIVEN"].includes(value))) fail([...qAt, "answer", "accepted"], "判断题答案必须使用TRUE/FALSE/NOT GIVEN。");
      if (item.type === "yes-no-not-given" && item.answer.accepted.some((value) => !["YES", "NO", "NOT GIVEN"].includes(value))) fail([...qAt, "answer", "accepted"], "观点判断答案必须使用YES/NO/NOT GIVEN。");
      if (item.type === "matching-headings" && material.skill === "reading") {
        const paragraph = material.paragraphs.find((p) => p.id === item.paragraphId);
        if (!paragraph) fail([...qAt, "paragraphId"], "标题匹配题必须引用实际段落。");
        else if (!paragraph.text.includes(item.evidence.quote)) fail([...qAt, "paragraphId"], "标题匹配证据不属于所引用的段落。");
      }
      if (item.answer.accepted.includes("NOT GIVEN") && !item.evidence.rationale) fail([...qAt, "evidence", "rationale"], "NOT GIVEN需说明原文未提供的具体信息。");
    });
  });
});
export type ContentCatalog = z.infer<typeof ContentCatalogSchema>;
