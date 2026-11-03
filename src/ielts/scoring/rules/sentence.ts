import { SentenceResultSchema } from "../schemas";
import type { SentenceInput, SentenceResult } from "../types";
import { containsTarget, metric, normal, overlap, rule, subordinate, words } from "./text";
export function scoreSentenceRules(input: SentenceInput): SentenceResult {
  const count = words(input.sentence).length, used = containsTarget(input.sentence, input.word, input.entry);
  const copied = Math.max(0, ...(input.entry?.ex ?? []).map((example) => overlap(input.sentence, example.en)));
  const capital = /^[^A-Za-z]*[A-Z]/.test(input.sentence), punctuation = /[.!?]["'’”)]*\s*$/.test(input.sentence);
  const collocation = (input.entry?.col ?? []).some((value) => value.trim() && normal(input.sentence).join(" ").includes(normal(value).join(" ")));
  const extended = collocation || subordinate.test(input.sentence);
  let score: 0 | 1 | 2 | 3 = 0;
  if (used) score = count < 6 || copied >= .6 ? 1 : count >= 8 && capital && punctuation ? count >= 12 && extended ? 3 : 2 : 1;
  const notes: string[] = [];
  if (!used) notes.push("加入目标词、词族或可识别的词形后，再独立写一句。");
  if (copied >= .6) notes.push("与词库例句的四词组合重合较多，请换一个自己的场景。");
  if (count < 8) notes.push("写到至少8个词，交代清楚完整意思。");
  if (!capital || !punctuation) notes.push("检查句首大写和句末标点。");
  if (score === 2) notes.push("尝试至少12个词，并加入词库搭配或从属结构。");
  notes.push("本地评分检查可观察的用词与句子结构，词义和语法仍需结合语境核对。");
  const example = input.entry?.ex.find((value) => (input.entry?.col ?? []).some((col) => normal(value.en).join(" ").includes(normal(col).join(" ")))) ?? input.entry?.ex[0];
  return SentenceResultSchema.parse({ score, usedCorrectly: score >= 2, verdict: ["尚未检测到目标词。", "请补充独立完整的表达。", "已满足基本造句条件。", "已包含较完整的搭配或从属表达。 "][score].trim(),
    corrected: input.sentence, better: example?.en.slice(0, 1000) ?? "", notes: notes.slice(0, 3), source: "rules", provider: null, confidence: .4,
    evidence: [metric("s.words", "wordCount", count, "按英文词与数字统计句子长度。"), metric("s.copy.4gram", "exampleOverlap", copied, "与词库例句的四词组合重合比例。"), rule("s.structure", `目标词${used ? "已检出" : "未检出"}；${capital ? "句首大写" : "请检查大写"}；${punctuation ? "有句末标点" : "请补句末标点"}。`)],
    cause: used ? null : "lexical-misuse", fallbackTrail: [] }) as SentenceResult;
}
