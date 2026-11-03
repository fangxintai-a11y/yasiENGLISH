import { ReadingSchema } from "../schemas";
import type { ReadingBody, ReadingInput, ReadingWord } from "../types";
import { containsTarget } from "./text";
const selectionNotice = "The compiler gives no information about the choice or ranking of alternative examples.";
const lowerFirst = (value: string) => value[0]?.toLowerCase() + value.slice(1).replace(/[.!?]\s*$/, "");
const declarative = (value: string) => !/[?!]/.test(value) && /\.\s*$/.test(value) && !/^(please|let|tell|describe|explain|remember|consider|imagine|do|can|could|would|will|should|how|what|why|who|where|when)\b/i.test(value.trim());
function safeParaphrase(sentence: string, word: ReadingWord): string | null {
  // A small, explicit noun-context rule. Other dictionary senses remain review
  // candidates rather than being treated as proven equivalent statements.
  if (word.word.toLowerCase() === "benefit" && word.entry?.syn.some((value) => value.toLowerCase() === "advantage") && /\b(?:the|a|main|clear|real) benefit (?:of|to|for)\b/i.test(sentence))
    return sentence.replace(/\bbenefit\b/i, (value) => value[0] === "B" ? "Advantage" : "advantage");
  return null;
}
export function buildReadingRules(input: ReadingInput): ReadingBody {
  const selected = input.words.filter((word, index, all) => all.findIndex((value) => value.id === word.id) === index).slice(0, 12);
  if (selected.length < 5) throw new Error("请先选择至少5个不同的目标词。");
  const rows = selected.map((word) => {
    const examples = word.entry?.ex.filter((value) => declarative(value.en) && containsTarget(value.en, word.word, word.entry)) ?? [];
    const first = examples[0] ?? { en: `Researchers discuss the term ${word.word} in this account.`, zh: `研究人员在这份说明中讨论“${word.word}”（${word.zh}）。` };
    return { word, first, other: examples.find((value) => value.en !== first.en), topic: word.entry?.topic ?? "" };
  }).sort((a, b) => a.topic.localeCompare(b.topic, "en") || selected.indexOf(a.word) - selected.indexOf(b.word));
  const groups = Math.min(5, rows.length), paragraphs: string[] = [], translations: string[] = [];
  for (let i = 0; i < groups; i++) {
    const part = rows.slice(Math.floor(i * rows.length / groups), Math.floor((i + 1) * rows.length / groups));
    paragraphs.push(part.map((row) => row.first.en).join(" ")); translations.push(part.map((row) => row.first.zh).join(" "));
  }
  paragraphs[0] = `These vocabulary examples describe separate situations. ${selectionNotice} ${paragraphs[0]}`;
  const passage = paragraphs.join("\n\n"), questions: ReadingBody["questions"] = [];
  const count = selected.length >= 8 ? 6 : 5;
  for (let i = 0; i < count; i++) {
    const row = rows[i % rows.length], mode = i % 3;
    let q: string, a: ReadingBody["questions"][number]["a"], explanation: string;
    if (mode === 0) {
      const paraphrase = safeParaphrase(row.first.en, row.word);
      q = paraphrase ?? row.first.en;
      a = "TRUE"; explanation = paraphrase ? "在此名词搭配中用advantage替换benefit，原文事实不变。" : row.word.entry?.syn[0] ? `原文明确陈述该事实。同义候选“${row.word.entry.syn[0]}”需核对语境后再替换，避免不同词义误判。` : "原文明确陈述该事实。";
    } else if (mode === 1) {
      q = `It is not true that ${lowerFirst(row.first.en)}.`;
      a = "FALSE"; explanation = "题句明确否定了原文陈述；单纯换成反义词不一定构成逻辑矛盾。";
    } else {
      const other = row.other && !passage.includes(row.other.en) ? row.other.en : `Researchers developed an additional project about ${row.word.word}.`;
      q = `The compiler preferred this alternative example to every other option: “${other.slice(0, 400)}”`;
      a = "NOT GIVEN"; explanation = "原文未提供编者对备选例句的偏好或排名；此题不主张备选句本身为真，不能凭未收录就推断该句真假。";
    }
    questions.push({ q: q.slice(0, 600), a, why: `${mode === 2 ? `原文：“${selectionNotice}” ` : ""}原句：“${row.first.en}” ${explanation}`.slice(0, 1200) });
  }
  return ReadingSchema.parse({ title: "错词语境阅读：比较与证据", passage, zh: translations.join("\n\n"), questions });
}
