import { isObject } from "./protocol";
import {
  hashLocalMaterial,
  LocalMaterialSchema,
  type LocalMaterial,
  type LocalQuestion,
} from "./localBankSchema";
type Node = Record<string, unknown>;
const object = (value: unknown): Node => {
  if (!isObject(value)) throw new Error("源材料结构无效。");
  return value;
};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
function* walk(value: unknown): Generator<Node> {
  for (const node of array(value))
    if (isObject(node)) {
      yield node;
      yield* walk(node.children);
    }
}
const attrs = (node: Node): Node => (isObject(node.attrs) ? node.attrs : {});
function plain(value: unknown, blanks = true): string {
  return array(value)
    .map((raw) => {
      const node = object(raw);
      if (node.type === "text") return String(node.text ?? "");
      if (["textInput", "dropzone", "select"].includes(String(node.type)))
        return blanks ? ` ____ [${String(node.questionId ?? "")}] ` : "";
      if (["choiceInput", "optionChip"].includes(String(node.type))) return "";
      const tag = String(node.tag ?? "");
      if (["script", "style"].includes(tag)) return "";
      return (
        plain(node.children, blanks) +
        (["p", "div", "h2", "h3", "h4", "h5", "br", "tr", "li"].includes(tag)
          ? "\n"
          : ["td", "th"].includes(tag)
            ? " | "
            : "")
      );
    })
    .join("");
}
const compact = (value: string) =>
  value
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
const hasQuestion = (node: Node, id: string) =>
  [...walk([node])].some(
    (value) => value.questionId === id || array(value.questionIds).includes(id),
  );
function optionsFor(
  nodes: unknown,
  questionId: string,
  fallback: unknown,
): { id: string; text: string }[] {
  const result = new Map<string, string>();
  for (const node of walk(nodes)) {
    if (node.type === "optionChip" && node.value !== undefined && node.label)
      result.set(String(node.value), String(node.label));
    if (node.tag === "label") {
      const input = [...walk(node.children)].find(
        (value) =>
          value.type === "choiceInput" &&
          (value.questionId === questionId ||
            array(value.questionIds).includes(questionId)),
      );
      const label = compact(plain(node.children, false));
      if (input && input.value !== undefined && label)
        result.set(String(input.value), label);
    }
    if (node.type === "select" && node.questionId === questionId)
      for (const raw of array(node.options)) {
        const option = object(raw),
          value = String(option.value ?? ""),
          label = String(option.label ?? option.text ?? "");
        if (value && label) result.set(value, label);
      }
  }
  if (!result.size)
    for (const raw of array(fallback)) {
      const option = object(raw);
      if (option.value && option.label)
        result.set(String(option.value), String(option.label));
    }
  return [...result].map(([id, text]) => ({ id, text }));
}
function groupType(
  kind: string,
  text: string,
  nodes: unknown,
): LocalQuestion["type"] {
  const known: Record<string, LocalQuestion["type"]> = {
    true_false_not_given: "true-false-not-given",
    yes_no_not_given: "yes-no-not-given",
    sentence_completion: "sentence-completion",
    table_completion: "table-completion",
    summary_completion: "summary-completion",
    note_completion: "note-completion",
    flow_chart_completion: "flow-chart-completion",
    short_answer: "short-answer",
    single_choice: "multiple-choice",
    multi_choice: "multiple-choice",
  };
  if (known[kind]) return known[kind];
  if (kind !== "matching")
    throw new Error(`未支持的题型${kind}，整篇保留待人工核对。`);
  if (/list of headings|correct heading|heading for/i.test(text))
    return "matching-headings";
  if (/which paragraph|paragraph contains|following information/i.test(text))
    return "matching-information";
  if (
    /summary|complete the notes/i.test(text) ||
    [...walk(nodes)].some((node) => node.appearance === "summary")
  )
    return "summary-completion";
  if (/sentence endings|complete each sentence/i.test(text))
    return "matching-sentence-endings";
  return "matching-features";
}
function wordLimit(text: string, accepted: string[]): number {
  const words: Record<string, number> = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    SIX: 6,
  };
  const match =
    /(?:NO MORE THAN|WRITE)\s+(ONE|TWO|THREE|FOUR|FIVE|SIX|\d+)\s+WORDS?/i.exec(
      text,
    );
  return match
    ? Number(words[match[1].toUpperCase()] ?? match[1])
    : Math.max(3, ...accepted.map((value) => value.trim().split(/\s+/).length));
}
function acceptedAnswers(value: unknown): string[] {
  const values =
    typeof value === "string"
      ? value.split(/\s+\/\s+|\s*\|\s*/)
      : array(value).map(String);
  return [
    ...new Set(
      values
        .flatMap((answer) =>
          /^\([A-Za-z]+\) [A-Za-z][A-Za-z -]*$/.test(answer)
            ? [
                answer.replace(/[()]/g, ""),
                answer.replace(/^\([A-Za-z]+\) /, ""),
              ]
            : /\((?:s|es)\)/.test(answer)
              ? [
                  answer.replace(/\((s|es)\)/, ""),
                  answer.replace(/\((s|es)\)/, "$1"),
                ]
              : [answer],
        )
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
export async function mapNativeReading(
  input: unknown,
  version: string,
): Promise<Extract<LocalMaterial, { skill: "reading" }>> {
  const source = object(input),
    meta = object(source.meta);
  if (source.schemaVersion !== "ReadingExamDocumentV1")
    throw new Error("源材料不是ReadingExamDocumentV1。");
  const examId = String(source.examId),
    id = `hwt-${examId}`,
    passageNodes = array(source.passageBlocks).flatMap((block) =>
      array(object(block).nodes),
    );
  const groups = array(source.questionGroups).map(object),
    allNodes = [
      ...walk(passageNodes),
      ...groups.flatMap((group) => [...walk(group.contentNodes)]),
    ];
  if (
    allNodes.some((node) => ["img", "svg", "canvas"].includes(String(node.tag)))
  )
    throw new Error(
      "源材料包含尚未完整映射的图示，整篇跳过，不能只保留文字作答。",
    );
  const anchors = isObject(source.paragraphAnchors)
      ? source.paragraphAnchors
      : {},
    domIds = new Set(allNodes.map((node) => attrs(node).id).filter(Boolean));
  if (Object.values(anchors).some((value) => !domIds.has(value)))
    throw new Error("源段落引用不存在。");
  const wrappers = [...walk(passageNodes)].filter((node) =>
    /paragraph-wrapper/.test(String(attrs(node).class ?? "")),
  );
  const paragraphNodes = wrappers.length
    ? wrappers
    : [...walk(passageNodes)].filter(
        (node) =>
          node.tag === "p" &&
          !/You should spend|based on Reading Passage/i.test(
            plain([node], false),
          ),
      );
  const paragraphs = paragraphNodes
    .map((node, index) => {
      const dropzone = [...walk([node])].find(
        (value) => value.type === "dropzone" && value.paragraph,
      );
      const label = String(
        dropzone?.paragraph ??
          Object.entries(anchors).find(
            ([, target]) => target === attrs(node).id,
          )?.[0] ??
          String.fromCharCode(65 + index),
      );
      return {
        id: `${id}-p${index + 1}`,
        label,
        text: compact(plain([node], false)),
      };
    })
    .filter((paragraph) => !!paragraph.text);
  if (!paragraphs.length) throw new Error("源材料没有可读取的正文段落。");
  const byLabel = new Map(
    paragraphs.map((paragraph) => [paragraph.label, paragraph]),
  );
  const answerKey = object(source.answerKey),
    questionOrder = array(source.questionOrder).map(String),
    questions = new Map<string, LocalQuestion>();
  const numbers = new Map(
    array(source.questionItems)
      .map(object)
      .map((item) => [String(item.questionId), String(item.displayNumber)]),
  );
  const promptText = (nodes: unknown) =>
    compact(plain(nodes)).replace(
      /\[(q\d+)\]/g,
      (_, qid: string) => `[${numbers.get(qid) ?? qid.slice(1)}]`,
    );
  for (const group of groups) {
    const nodes = group.contentNodes,
      groupText = promptText([...array(group.leadNodes), ...array(nodes)]),
      type = groupType(String(group.kind), groupText, nodes);
    for (const qid of array(group.questionIds).map(String)) {
      const accepted = acceptedAnswers(answerKey[qid]);
      if (!accepted.length) throw new Error(`${qid}缺少答案，整篇跳过。`);
      if (type === "true-false-not-given" || type === "yes-no-not-given")
        for (let i = 0; i < accepted.length; i++)
          accepted[i] = accepted[i].replace(/\s+/g, " ").toUpperCase();
      const specific = [...walk(nodes)].find(
        (node) =>
          node.type === "element" &&
          /(?:question|match)[-_](?:item|row)/.test(
            String(attrs(node).class ?? ""),
          ) &&
          hasQuestion(node, qid),
      );
      const prompt = promptText(specific ? [specific] : nodes);
      const item = array(source.questionItems)
        .map(object)
        .find((value) => value.questionId === qid);
      const number = Number(item?.displayNumber ?? qid.replace(/^q/, ""));
      const choice = isObject(source.fields)
        ? array(source.fields.choiceGroups)
            .map(object)
            .find((field) => array(field.questionIds).includes(qid))
        : undefined;
      const multiIds = array(choice?.questionIds).length
        ? array(choice?.questionIds)
        : array(group.questionIds);
      const options = optionsFor(
        specific ? [specific] : nodes,
        qid,
        source.options,
      );
      const selectedParagraph =
        type === "matching-headings"
          ? (() => {
              const zone = [...walk(passageNodes)].find(
                (node) => node.type === "dropzone" && node.questionId === qid,
              );
              return byLabel.get(String(zone?.paragraph ?? ""));
            })()
          : type === "matching-information"
            ? byLabel.get(accepted[0])
            : undefined;
      if (type === "matching-headings" && !selectedParagraph)
        throw new Error(`${qid}标题配对缺少有效段落。`);
      const needsOptions =
        [
          "multiple-choice",
          "matching-headings",
          "matching-information",
          "matching-features",
          "matching-sentence-endings",
        ].includes(type) ||
        (options.length > 0 &&
          accepted.every((answer) =>
            options.some((option) => option.id === answer),
          ));
      const question: LocalQuestion = {
        id: `${id}-${qid}`,
        type,
        prompt:
          prompt || groupText || `Paragraph ${selectedParagraph?.label ?? qid}`,
        answer: {
          accepted,
          ...(/completion|short-answer/.test(type) &&
          /\bAND\s*\/\s*OR\s+A\s+NUMBER\b/i.test(groupText)
            ? { allowNumber: true }
            : {}),
          maxWords: ["true-false-not-given", "yes-no-not-given"].includes(type)
            ? 2
            : needsOptions
              ? 1
              : wordLimit(groupText, accepted),
        },
        groupId: `${id}-${String(choice?.name ?? group.groupId)}`,
        number,
        evidence: selectedParagraph
          ? {
              paragraphId: selectedParagraph.id,
              quote: selectedParagraph.text,
              offset: 0,
              rationale: "源答案指向此段；该定位不代表语义已人工核验。",
            }
          : {},
        answerVerified: false,
        ...(selectedParagraph ? { paragraphId: selectedParagraph.id } : {}),
        ...(needsOptions ? { options } : {}),
        ...(group.kind === "multi_choice"
          ? { selectionCount: multiIds.length }
          : {}),
      };
      if (type === "matching-headings")
        question.prompt = `${groupText}\nParagraph ${selectedParagraph!.label}`;
      questions.set(qid, question);
    }
  }
  if (!questionOrder.length || questionOrder.some((qid) => !questions.has(qid)))
    throw new Error("题序包含缺少题干或未知分组的题目。");
  const body = {
    id,
    version,
    skill: "reading",
    title: String(meta.title),
    deliveryMode: "local-import",
    scope: "section",
    contentHash: "0".repeat(64),
    estimatedMinutes: 20,
    source: {
      materialSource: "unofficial",
      sourceRef: `hwttop5:${examId}`,
      rights:
        "Third-party material retained locally for personal study; source rights remain with their holders.",
      answerVerified: false,
    },
    passage: paragraphs.map((paragraph) => paragraph.text).join(" "),
    paragraphs,
    passageNumber: Number(String(meta.category).replace(/^P/i, "")),
    ...(typeof meta.frequency === "string"
      ? { frequency: meta.frequency }
      : {}),
    questions: questionOrder.map((qid) => questions.get(qid)!),
    instructions: [
      ...new Set(
        groups
          .map((group) => compact(plain(group.leadNodes)))
          .filter((value) => !!value && !/^Questions$/i.test(value)),
      ),
    ],
  };
  const material = LocalMaterialSchema.parse(body);
  if (material.skill !== "reading") throw new Error("阅读材料科目不符。");
  material.contentHash = await hashLocalMaterial(material);
  return material;
}

export interface LocalAnswerCheck {
  questionId: string;
  located: boolean;
  answerVerified: boolean;
  reason: string;
}
export function checkLocalAnswers(material: LocalMaterial): LocalAnswerCheck[] {
  const original =
    material.skill === "reading" ? material.passage : material.transcript;
  const normal = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ");
  return material.questions.map((question) => {
    let located = false;
    const paragraphId = question.evidence.paragraphId ?? question.paragraphId;
    if (
      material.skill === "reading" &&
      paragraphId &&
      material.paragraphs.some((paragraph) => paragraph.id === paragraphId)
    )
      located = true;
    if (question.evidence.quote && original.includes(question.evidence.quote))
      located = true;
    if (
      !located &&
      !["true-false-not-given", "yes-no-not-given", "multiple-choice"].includes(
        question.type,
      )
    )
      located = question.answer.accepted.some((answer) => {
        const actual =
          question.options
            ?.find((option) => option.id === answer)
            ?.text.replace(
              new RegExp(
                `^${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[.)]?\\s*`,
              ),
              "",
            ) ?? answer;
        const escaped = normal(actual).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(
          normal(original),
        );
      });
    return {
      questionId: question.id,
      located,
      answerVerified: question.answerVerified && located,
      reason: located
        ? "只确认词面或段落可定位，不代替答案语义审校。"
        : "未找到可靠原文定位，答案待核。",
    };
  });
}
