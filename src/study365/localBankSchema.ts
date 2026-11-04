import { z } from "zod";
import { ATTEMPT_SCOPES, MATERIAL_SOURCES, isIdentifier } from "./protocol";
import {
  LISTENING_QUESTION_TYPES,
  READING_QUESTION_TYPES,
} from "./contentSchemas";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !!value.trim(), "文字不能为空。");
const identifier = text(160).refine(isIdentifier, "标识无效。");
export function isLocalAudioPath(path: string): boolean {
  return (
    /^(?:audio\/|\/local-bank\/audio\/|\/curriculum365\/v1\/audio\/)[a-zA-Z0-9/_-]+\.(?:mp3|m4a|ogg|wav|webm)$/.test(
      path,
    ) && !path.split("/").some((part) => part === ".." || part === ".")
  );
}
const EvidenceSchema = z.strictObject({
  quote: text(8000).optional(),
  rationale: text(4000).optional(),
  startSeconds: z.number().finite().nonnegative().optional(),
  endSeconds: z.number().finite().positive().optional(),
  paragraphId: identifier.optional(),
  offset: z.number().int().nonnegative().optional(),
});
export const LocalQuestionSchema = z.strictObject({
  id: identifier,
  type: z.enum([...LISTENING_QUESTION_TYPES, ...READING_QUESTION_TYPES]),
  prompt: text(20000),
  answer: z.strictObject({
    accepted: z.array(text(500)).min(1).max(30),
    maxWords: z.number().int().min(1).max(100),
  }),
  options: z
    .array(z.strictObject({ id: text(40), text: text(3000) }))
    .min(2)
    .max(100)
    .optional(),
  paragraphId: identifier.optional(),
  groupId: identifier.optional(),
  number: z.number().int().min(1).max(200).optional(),
  selectionCount: z.number().int().min(2).max(20).optional(),
  evidence: EvidenceSchema,
  answerVerified: z.boolean(),
});
const common = {
  id: identifier,
  version: text(120),
  title: text(500),
  deliveryMode: z.literal("local-import"),
  source: z.strictObject({
    materialSource: z.enum(MATERIAL_SOURCES),
    sourceRef: text(300),
    rights: text(3000),
    answerVerified: z.boolean(),
  }),
  scope: z.enum(ATTEMPT_SCOPES),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  questions: z.array(LocalQuestionSchema).max(200),
  estimatedMinutes: z.number().int().min(1).max(180).optional(),
  frequency: z.enum(["high", "medium", "low"]).optional(),
  pool: z.enum(["practice", "holdout"]).optional(),
  examId: identifier.optional(),
  notes: z.array(text(4000)).max(100).optional(),
  instructions: z.array(text(4000)).max(30).optional(),
};
export const LocalMaterialSchema = z
  .discriminatedUnion("skill", [
    z.strictObject({
      ...common,
      skill: z.literal("reading"),
      passage: text(200000),
      paragraphs: z
        .array(
          z.strictObject({
            id: identifier,
            text: text(50000),
            label: text(30).optional(),
          }),
        )
        .min(1)
        .max(100),
      passageNumber: z.number().int().min(1).max(3).optional(),
    }),
    z.strictObject({
      ...common,
      skill: z.literal("listening"),
      transcript: z.string().max(200000),
      audio: z
        .strictObject({
          path: text(500).refine(
            isLocalAudioPath,
            "音频必须是允许的本机文件路径。",
          ),
          durationSeconds: z.number().finite().positive().max(7200),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .optional(),
      section: z.number().int().min(1).max(4).optional(),
    }),
  ])
  .superRefine((material, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (!material.questions.length && material.scope !== "short")
      issue(["questions"], "可判分材料不能缺题目；原文对照只能作为短专项。");
    if (
      material.skill === "listening" &&
      material.scope !== "short" &&
      !material.audio
    )
      issue(["audio"], "听力作答材料缺少本机音频。");
    const original =
      material.skill === "reading" ? material.passage : material.transcript;
    const paragraphs = new Map(
      material.skill === "reading"
        ? material.paragraphs.map((value) => [value.id, value.text])
        : [],
    );
    if (material.skill === "reading") {
      if (paragraphs.size !== material.paragraphs.length)
        issue(["paragraphs"], "段落标识重复。");
      if (
        material.paragraphs.map((value) => value.text).join(" ") !==
        material.passage
      )
        issue(["passage"], "完整文章与段落不一致。");
    }
    const ids = new Set<string>(),
      multi = new Map<string, typeof material.questions>();
    material.questions.forEach((question, index) => {
      const path = ["questions", index];
      if (ids.has(question.id)) issue([...path, "id"], "题目标识重复。");
      ids.add(question.id);
      const allowed: readonly string[] =
        material.skill === "reading"
          ? READING_QUESTION_TYPES
          : LISTENING_QUESTION_TYPES;
      if (!allowed.includes(question.type))
        issue([...path, "type"], "题型与科目不符。");
      for (const [key, value] of [
        ["paragraphId", question.paragraphId],
        ["evidence.paragraphId", question.evidence.paragraphId],
      ] as const) {
        if (value && !paragraphs.has(value))
          issue([...path, ...key.split(".")], "引用段落不存在。");
      }
      const quote = question.evidence.quote,
        paragraphId = question.evidence.paragraphId ?? question.paragraphId;
      if (
        quote &&
        !(
          paragraphId ? (paragraphs.get(paragraphId) ?? "") : original
        ).includes(quote)
      )
        issue([...path, "evidence", "quote"], "证据原句不在对应原文中。");
      const offset = question.evidence.offset,
        anchored = paragraphId ? (paragraphs.get(paragraphId) ?? "") : original;
      if (
        offset !== undefined &&
        (offset >= anchored.length ||
          (quote && anchored.slice(offset, offset + quote.length) !== quote))
      )
        issue(
          [...path, "evidence", "offset"],
          "证据偏移不在原文中，或不指向对应原句。",
        );
      if (question.options) {
        const options = new Set(question.options.map((value) => value.id));
        if (
          options.size !== question.options.length ||
          question.answer.accepted.some((value) => !options.has(value))
        )
          issue([...path, "options"], "选项重复或正确答案没有对应选项。");
      }
      if (
        [
          "multiple-choice",
          "matching",
          "matching-headings",
          "matching-features",
          "matching-sentence-endings",
          "map-labeling",
        ].includes(question.type) &&
        !question.options
      )
        issue([...path, "options"], "选择和配对题需要完整选项。");
      const labels =
        question.type === "true-false-not-given"
          ? ["TRUE", "FALSE", "NOT GIVEN"]
          : question.type === "yes-no-not-given"
            ? ["YES", "NO", "NOT GIVEN"]
            : null;
      if (
        labels &&
        question.answer.accepted.some((value) => !labels.includes(value))
      )
        issue([...path, "answer", "accepted"], "判断题答案标签无效。");
      const start = question.evidence.startSeconds,
        end = question.evidence.endSeconds;
      if (start !== undefined || end !== undefined) {
        if (
          material.skill !== "listening" ||
          start === undefined ||
          end === undefined ||
          start >= end ||
          !material.audio ||
          end > material.audio.durationSeconds
        )
          issue([...path, "evidence"], "音频证据时间范围无效。");
      }
      if (question.selectionCount) {
        if (!question.groupId || !question.options)
          issue([...path, "selectionCount"], "多选题必须记录题组和完整选项。");
        else
          multi.set(question.groupId, [
            ...(multi.get(question.groupId) ?? []),
            question,
          ]);
      }
    });
    for (const [groupId, questions] of multi) {
      const first = questions[0],
        optionKey = JSON.stringify(first.options);
      if (
        questions.length !== first.selectionCount ||
        questions.some(
          (value) =>
            value.selectionCount !== first.selectionCount ||
            JSON.stringify(value.options) !== optionKey,
        )
      )
        issue(["questions"], `多选组${groupId}的答案槽数或选项不一致。`);
    }
  });
export type LocalMaterial = z.infer<typeof LocalMaterialSchema>;
export type LocalQuestion = z.infer<typeof LocalQuestionSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function hashLocalMaterial(value: unknown): Promise<string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("材料格式无效。");
  const { contentHash: _hash, ...body } = value as Record<string, unknown>;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(body)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function parseLocalBank(
  input: unknown,
): Promise<{
  materials: LocalMaterial[];
  duplicate: number;
  issues: string[];
}> {
  const envelope = z
    .strictObject({
      importVersion: z.literal(1),
      materials: z.array(z.unknown()).max(10000),
    })
    .parse(input);
  const materials: LocalMaterial[] = [],
    seen = new Map<string, string>(),
    issues: string[] = [];
  let duplicate = 0;
  for (const [index, raw] of envelope.materials.entries()) {
    const parsed = LocalMaterialSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push(
        `材料${index + 1}：${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`,
      );
      continue;
    }
    const material = parsed.data,
      key = `${material.id}@${material.version}`;
    if ((await hashLocalMaterial(material)) !== material.contentHash) {
      issues.push(`${key}：材料内容校验失败。`);
      continue;
    }
    if (seen.has(key)) {
      if (seen.get(key) === material.contentHash) duplicate++;
      else issues.push(`${key}：同标识版本包含不同内容，保留第一份。`);
      continue;
    }
    seen.set(key, material.contentHash);
    materials.push(material);
  }
  return { materials, duplicate, issues };
}
