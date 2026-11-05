import { SECTION_TARGETS, hashPayload } from "../../../study365/protocol";
import { SpeakingFeedbackSchema } from "../schemas";
import { RUBRIC_VERSION, type CriterionScore, type Evidence, type SpeakingInput, type SpeakingResult } from "../types";
import { metric, normal, rule, stopWords } from "./text";
const criterion = (evidence: Evidence[]): CriterionScore => ({ band: null, confidence: 0, target: SECTION_TARGETS.speaking, gap: null, evidence: evidence.slice(0, 12) });
export async function scoreSpeakingRules(input: SpeakingInput, assessedAt = 0): Promise<SpeakingResult> {
  if (![1, 2, 3].includes(input.part) || !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0) throw new Error("口语部分或录音时长无效。");
  const warnings: string[] = [], fluent: Evidence[] = [];
  const tokens = normal(input.transcript), fillers = tokens.filter((word) => ["um", "uh", "like"].includes(word)).length + (input.transcript.match(/\byou know\b/gi) ?? []).length * 2;
  const repetitions = tokens.slice(1).filter((token, index) => token === tokens[index]).length;
  const corrections = (input.transcript.match(/\b(i mean|sorry|rather|let me correct)\b/gi) ?? []).length;
  if (input.words?.length) {
    let previous = 0;
    for (const word of input.words) { if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < previous || word.end <= word.start || word.end > input.durationSeconds || !word.w.trim()) throw new Error("口语词级时间戳无效。"); previous = word.end; }
    const pauses = input.words.slice(1).filter((word, index) => word.start - input.words![index].end > 1).length;
    fluent.push(metric("s.rate", "wordsPerMinute", input.words.length * 60 / input.durationSeconds, "按词级时间戳词数与总时长计算。"), metric("s.pauses", "pausesPerMinute", pauses * 60 / input.durationSeconds, "相邻词间超过1秒的停顿次数/分钟。"), metric("s.runs", "meanRunLength", input.words.length / (pauses + 1), "以超过1秒停顿分组的平均语流词数。"));
  } else warnings.push("尚无词级时间戳，语速、停顿和语流指标待分析。");
  fluent.push(metric("s.fillers", "fillerRatio", tokens.length ? fillers / tokens.length : 0, "按um、uh、like与you know词面计数；like也可能是实义词。"), metric("s.repetitions", "repetitions", repetitions, "相邻重复词次数，需回听核对。"), metric("s.corrections", "selfCorrections", corrections, "常见自我修正表达次数，需回听核对。"));
  if (input.part === 2) {
    fluent.push(metric("s.part2.duration", "durationSeconds", input.durationSeconds, "Part 2目标为100至120秒的连续回答。"));
    if (input.durationSeconds < 100) warnings.push("Part 2不足100秒，请补充具体细节并重新录音。");
    for (const [index, point] of (input.cueCardPoints ?? []).entries()) {
      const keywords = normal(point).filter((word) => !stopWords.has(word)), found = keywords.some((word) => tokens.includes(word));
      if (!found) warnings.push(`题卡第${index + 1}点尚未检出关键词，请回听核对是否回应。`);
    }
  }
  const criteria = { fluency: criterion(fluent), lexical: criterion([metric("s.lexical.types", "contentWordTypes", new Set(tokens.filter((word) => !stopWords.has(word))).size, "转写中的实义词种类数，不换算词汇分。")]), grammar: criterion([rule("s.grammar.review", "转写可能存在识别错误，语法需对照原音频核对。")]), pronunciation: criterion([rule("s.pronunciation.unassessed", "本地文本与时间戳不能验证发音，发音分保持未评估。")]) };
  SpeakingFeedbackSchema.parse({ criteria: Object.fromEntries(Object.entries(criteria).map(([key, value]) => [key, { band: null, confidence: 0, evidence: value.evidence }])), causes: [], rewrite8: "", summaryZh: "口语指标用于回听检查，各维度分数待评估。" });
  return { kind: "speaking", taskType: "speaking", rubricVersion: RUBRIC_VERSION, source: "rules", provider: null, inputHash: await hashPayload("speaking", { transcript: input.transcript }), assessedAt, criteria, overall: null, causes: [], warnings, rewrite8: "", summaryZh: "口语指标用于回听检查，各维度分数待评估。", fallbackTrail: [] };
}
