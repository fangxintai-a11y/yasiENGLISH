import { SECTION_TARGETS, hashPayload } from "../../../study365/protocol";
import { Task1FeedbackSchema, Task2FeedbackSchema } from "../schemas";
import { RUBRIC_VERSION, type CriterionScore, type Evidence, type WritingInput, type WritingResult } from "../types";
import { emptyGrammarChecker } from "../adapters/grammar";
import { deviation, mean, metric, normal, overlap, paragraphs, rule, sentences, span, stopWords, subordinate, words } from "./text";
const criterion = (evidence: Evidence[]): CriterionScore => ({ band: null, confidence: 0, target: SECTION_TARGETS.writing, gap: null, evidence: evidence.slice(0, 12) });
function writingCriteria(task: Evidence[], coherence: Evidence[], lexical: Evidence[], grammar: Evidence[]) {
  const common = { coherence: criterion(coherence), lexical: criterion(lexical), grammar: criterion(grammar) };
  return { task1: { taskAchievement: criterion(task), ...common }, task2: { taskResponse: criterion(task), ...common } };
}
export async function scoreWritingRules(input: WritingInput, assessedAt = 0): Promise<WritingResult> {
  if (!["task1", "task2"].includes(input.taskType)) throw new Error("请选择Task 1或Task 2。");
  const count = words(input.text).length, minimum = input.taskType === "task1" ? 150 : 250;
  const parts = paragraphs(input.text), lines = sentences(input.text), lengths = lines.map((line) => words(line.text).length);
  const warnings: string[] = count < minimum ? [`字数不足${minimum}，当前${count}词。`] : [];
  const task: Evidence[] = [metric(`w.wordcount.min${minimum}`, "wordCount", count, `本任务至少${minimum}词；当前${count}词。`)];
  if (input.taskType === "task1") {
    const overview = /\b(overall|in general|on the whole|it is clear|the main)\b/i.test(parts.slice(0, 2).join(" "));
    task.push(metric("w.task1.overview", "overviewMarker", Number(overview), "检查前两段是否出现常见概述表达，不代替内容核验。"),
      metric("w.task1.figures", "numericReferences", (input.text.match(/\b\d+(?:\.\d+)?%?/g) ?? []).length, "引用的数字数量，需对照题目数据核对。"),
      metric("w.task1.comparisons", "comparisonPatterns", (input.text.match(/\b(more than|less than|higher|lower|whereas|while|compared|in contrast|by contrast)\b/gi) ?? []).length, "比较表达的词面命中次数。"));
    if (!overview) warnings.push("前两段未检测到常见概述标记，请核对是否概括主要趋势。");
  } else {
    const stance = /\b(I (?:largely )?(?:agree|disagree|believe|argue)|in my (?:view|opinion)|should)\b/i;
    task.push(metric("w.task2.position", "positionMarker", Number(stance.test(parts[0] ?? "")), "开头立场表达的词面检测。"),
      metric("w.task2.conclusion", "conclusionEcho", Number(stance.test(parts.at(-1) ?? "") || overlap(parts.at(-1) ?? "", parts[0] ?? "", 2) > .1), "结尾是否出现立场表达或呼应开头的词组，需人工核对论证。"));
  }
  const connectors = input.text.toLowerCase().match(/\b(however|therefore|moreover|furthermore|nevertheless|consequently|although|because|in addition|for example|in conclusion)\b/g) ?? [];
  const connectorCounts = new Map<string, number>(); for (const value of connectors) connectorCounts.set(value, (connectorCounts.get(value) ?? 0) + 1);
  for (const [value, occurrences] of connectorCounts) if (occurrences > 3) warnings.push(`连接词“${value}”出现${occurrences}次，请检查是否重复。`);
  const coherence: Evidence[] = [metric("w.paragraphs", "paragraphCount", parts.length, "按空行分段。"), metric("w.connectors.types", "connectorTypes", connectorCounts.size, "已检测到的连接表达种类数。")];
  let searchAt = 0;
  for (const part of parts.slice(0, 6)) {
    const first = sentences(part)[0]; if (!first) continue;
    const start = input.text.indexOf(first.text, searchAt); if (start >= 0) { coherence.push(span("w.paragraph.topic", first.text, start, "本段首句，供核对主题是否清晰。")); searchAt = start + first.text.length; }
  }
  const frequency = new Map<string, number>(); for (const word of normal(input.text)) if (!stopWords.has(word) && word.length > 2) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const repeated = [...frequency].filter(([, occurrences]) => occurrences > 4).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const lexical: Evidence[] = [metric("w.lexical.repetition", "repeatedContentWords", repeated.length, repeated.length ? `重复超过4次的实义词：${repeated.slice(0, 5).map(([word, n]) => `${word}(${n})`).join("、")}。` : "未检测到同一实义词超过4次。"), metric("w.prompt.overlap", "promptOverlap", overlap(input.text, input.prompt), "与题目四词组合的重合比例，供检查是否照抄题目。")];
  const grammar: Evidence[] = [metric("w.sentences.mean", "meanSentenceLength", mean(lengths), "平均句长。"), metric("w.sentences.deviation", "sentenceLengthDeviation", deviation(lengths), "句长总体标准差。"), metric("w.sentences.complex-ratio", "complexSentenceRatio", lines.length ? lines.filter((line) => subordinate.test(line.text)).length / lines.length : 0, "从属结构关键词命中比例，不等于语法正确率。")];
  await emptyGrammarChecker.check(input.text); grammar.push(rule("w.grammar.review", "尚未执行语法工具检查，请逐句自查或交真人核对。"));
  const criteria = writingCriteria(task, coherence, lexical, grammar);
  const body = { criteria: criteria[input.taskType], causes: count < minimum ? ["word-limit"] : [], rewrite8: "", summaryZh: "本地文本体检保存指标和原文证据；各维度分数待评估。" };
  // Local and external feedback share the same strict wire shape.
  const wire = { ...body, criteria: Object.fromEntries(Object.entries(body.criteria).map(([key, value]) => [key, { band: value.band, confidence: value.confidence, evidence: value.evidence }])) };
  (input.taskType === "task1" ? Task1FeedbackSchema : Task2FeedbackSchema).parse(wire);
  const base = { rubricVersion: RUBRIC_VERSION, source: "rules" as const, provider: null, inputHash: await hashPayload("essay", { text: input.text }), assessedAt, overall: null, warnings, fallbackTrail: [], rewrite8: body.rewrite8, summaryZh: body.summaryZh, causes: count < minimum ? ["word-limit" as const] : [] };
  return input.taskType === "task1" ? { ...base, kind: "writing", taskType: "task1", criteria: criteria.task1 } : { ...base, kind: "writing", taskType: "task2", criteria: criteria.task2 };
}
