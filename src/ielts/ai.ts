import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { getKey } from "./aikey";

/**
 * Claude, called straight from the browser with the learner's own API key. Personal use only:
 * the key lives in this browser's storage and is never put into backups.
 */

export class AiError extends Error {}

function client() {
  const apiKey = getKey();
  if (!apiKey) throw new AiError("先在「我的 → AI 助教」里填入你的 Claude API Key。");
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/** Server-side refusal fallback where the model supports it. */
const fallbackFor = (model: string) =>
  model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

function explain(e: unknown): never {
  if (e instanceof AiError) throw e;
  if (e instanceof Anthropic.AuthenticationError) throw new AiError("API Key 无效或已被撤销，请在「我的」里重新填写。");
  if (e instanceof Anthropic.PermissionDeniedError) throw new AiError("这个 API Key 没有权限使用所选模型，换一个模型试试。");
  if (e instanceof Anthropic.RateLimitError) throw new AiError("请求太频繁或额度用完了，稍后再试。");
  if (e instanceof Anthropic.BadRequestError) throw new AiError(`请求被拒绝：${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) throw new AiError("连不上 api.anthropic.com，检查网络后再试。");
  if (e instanceof Anthropic.APIError) throw new AiError(`Claude 返回错误 ${e.status ?? ""}：${e.message}`);
  throw new AiError(e instanceof Error ? e.message : "未知错误");
}

const ReadingSchema = z.object({
  title: z.string(),
  passage: z.string(),
  zh: z.string(),
  questions: z.array(
    z.object({
      q: z.string(),
      a: z.enum(["TRUE", "FALSE", "NOT GIVEN"]),
      why: z.string(),
    }),
  ),
});
export type GeneratedReading = z.infer<typeof ReadingSchema>;

const READING_SYSTEM = `You write IELTS Academic Reading practice for a Chinese learner who is memorising vocabulary.
Write one coherent passage on an academic topic of the kind IELTS uses (science, society, history, environment, education, technology).
Use every target word naturally, each at least once, in a context that makes its meaning clear; inflected forms are fine.
Then write True / False / Not Given statements in real IELTS style: each statement paraphrases the passage instead of copying it, at least one tests a target word through a synonym, and the answer set mixes all three labels.
Explanations ("why") and the full translation ("zh") are in Simplified Chinese; the explanation quotes the sentence that decides the answer.`;

export async function generateReading(words: { word: string; zh: string }[], band: number, model: string): Promise<GeneratedReading> {
  try {
    const res = await client().beta.messages.parse({
      model,
      max_tokens: 16000,
      ...fallbackFor(model),
      system: READING_SYSTEM,
      output_config: { effort: "medium", format: betaZodOutputFormat(ReadingSchema) },
      messages: [
        {
          role: "user",
          content: `Target band: ${band}. Passage length: 280–360 words, 4–5 paragraphs. Five statements.\nTarget words:\n${words.map((w) => `- ${w.word} (${w.zh})`).join("\n")}`,
        },
      ],
    });
    if (res.stop_reason === "refusal") throw new AiError("Claude 拒绝了这次生成，换一组词再试。");
    if (!res.parsed_output) throw new AiError(res.stop_reason === "max_tokens" ? "文章太长被截断了，再试一次。" : "没能解析返回的文章，再试一次。");
    return res.parsed_output;
  } catch (e) {
    return explain(e);
  }
}

const GradeSchema = z.object({
  score: z.number().int().min(0).max(3),
  usedCorrectly: z.boolean(),
  verdict: z.string(),
  corrected: z.string(),
  better: z.string(),
  notes: z.array(z.string()),
});
export type SentenceGrade = z.infer<typeof GradeSchema>;

const GRADE_SYSTEM = `You are an IELTS writing examiner coaching a Chinese learner on one vocabulary item at a time.
Judge whether the learner's sentence uses the target word with the right meaning, part of speech, grammar and collocation.
score: 3 = correct and natural, 2 = correct meaning with a small slip, 1 = understandable but the word is misused, 0 = wrong word use or no use of the word.
"verdict" is one short sentence in Simplified Chinese. "corrected" is the learner's sentence with the minimum fixes (unchanged if already correct).
"better" is a band 7+ sentence on the same idea that uses the target word with a strong collocation. "notes" are at most three short tips in Simplified Chinese.`;

export async function gradeSentence(word: string, zh: string, sentence: string, model: string): Promise<SentenceGrade> {
  try {
    const res = await client().beta.messages.parse({
      model,
      max_tokens: 4000,
      ...fallbackFor(model),
      system: GRADE_SYSTEM,
      output_config: { effort: "low", format: betaZodOutputFormat(GradeSchema) },
      messages: [{ role: "user", content: `Target word: ${word} (${zh})\nLearner's sentence: ${sentence}` }],
    });
    if (res.stop_reason === "refusal") throw new AiError("Claude 拒绝了这次批改。");
    if (!res.parsed_output) throw new AiError("没能解析批改结果，再试一次。");
    return res.parsed_output;
  } catch (e) {
    return explain(e);
  }
}

const HackSchema = z.object({
  homophone: z.string(),
  split: z.string(),
  scene: z.string(),
});
export type Hack = z.infer<typeof HackSchema>;

const HACK_SYSTEM = `You are a memory coach for Chinese learners preparing for IELTS. The learner keeps forgetting one English word and wants "邪修" tricks: unorthodox, vivid, slightly silly hooks that make it stick. Write all three in Simplified Chinese, each at most 60 characters.
homophone (谐音): a Chinese phrase that genuinely sounds like the word's pronunciation (use the IPA given) and points at its meaning, e.g. ambulance → "俺不能死"——救护车. If no honest sound-alike exists, give the closest one and say it is approximate.
split (拆分): cut the spelling, in order and covering every letter, into chunks the learner already knows (short English words, pinyin, letters) and link the chunks to the meaning, e.g. "pest·i·cide：pest 害虫 + cide 杀 → 杀虫剂".
scene (画面): one absurd, concrete picture that joins the sound or the spelling with the meaning, the stranger the better.
Nothing crude or offensive. Do not repeat the dictionary definition as a hook.`;

export async function generateHack(word: string, ipa: string, zh: string, model: string): Promise<Hack> {
  try {
    const res = await client().beta.messages.parse({
      model,
      max_tokens: 2000,
      ...fallbackFor(model),
      system: HACK_SYSTEM,
      output_config: { effort: "low", format: betaZodOutputFormat(HackSchema) },
      messages: [{ role: "user", content: `Word: ${word}\nIPA: ${ipa || "(unknown)"}\nMeaning: ${zh}` }],
    });
    if (res.stop_reason === "refusal") throw new AiError("Claude 拒绝了这次生成，换个词再试。");
    if (!res.parsed_output) throw new AiError("没能解析生成的记法，再试一次。");
    return res.parsed_output;
  } catch (e) {
    return explain(e);
  }
}
