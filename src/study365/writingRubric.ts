import {
  WRITING_CHECKLIST_IDS,
  WRITING_ERROR_CAUSES,
} from "./writingChecklist";
export const WRITING_RUBRIC_SOURCE =
  "https://ielts.org/cdn/ielts-guides/ielts-writing-band-descriptors.pdf";
export const WRITING_DIMENSION_LABELS: Record<string, string> = {
  taskAchievement: "任务完成",
  taskResponse: "任务回应",
  coherence: "连贯与衔接",
  lexical: "词汇",
  grammar: "语法",
};
const descriptions: Record<string, string> = {
  "task-achievement-coverage": "挑出题图的主要特征，不遗漏重要部分。",
  "task-achievement-accuracy": "数据、单位、对象和变化方向与题图一致。",
  "task-achievement-relevance": "细节服务于主要特征，避免逐项罗列或无关解释。",
  "task-response-answer": "回应题目所有要求，每段都围绕问题。",
  "task-response-position": "立场清楚且前后一致，不在结尾突然换观点。",
  "task-response-support": "分论点有展开，并用相关理由或例子支持。",
  "coherence-organisation": "分段有目的，每段围绕一个清晰的中心。",
  "coherence-progression": "观点或信息顺序清楚，读者能顺着论述前进。",
  "coherence-cohesion": "连接和指代自然准确，不靠堆叠连接词维持逻辑。",
  "lexical-precision": "用词准确表达所指，不用不确定的难词替代清楚表达。",
  "lexical-range": "有适当的表达变化，减少机械重复。",
  "lexical-collocation": "搭配、语域和词形合适，已逐项核对不确定表达。",
  "grammar-range": "根据表达需要灵活使用不同句式。",
  "grammar-accuracy": "多数句子准确，反复出现的语法问题已处理。",
  "grammar-punctuation": "标点、从句连接和句子边界清楚。",
  "task1-overview": "有总体概述，概括主要趋势或差异。",
  "task1-comparison": "有适当比较，并用关键数据支撑。",
  "task1-no-opinion": "没有加入个人观点或题图未给出的原因。",
};
export function writingRubric(taskType: "task1" | "task2") {
  return WRITING_CHECKLIST_IDS[taskType].map((id) => ({
    id,
    label: descriptions[id],
    dimension:
      id.startsWith("task1-") || id.startsWith("task-achievement-")
        ? "taskAchievement"
        : id.startsWith("task-response-")
          ? "taskResponse"
          : id.startsWith("coherence-")
            ? "coherence"
            : id.startsWith("lexical-")
              ? "lexical"
              : "grammar",
  }));
}
const causeLabels: Record<string, string> = {
  "task-achievement": "任务完成",
  "task-response": "任务回应",
  coherence: "连贯与衔接",
  "lexical-misuse": "用词不当",
  grammar: "语法",
  spelling: "拼写",
  "word-limit": "字数不足",
  "time-pressure": "时间压力",
  "misread-question": "审题偏差",
  "vocab-unknown": "词汇不熟",
  other: "其他（需说明）",
};
export function writingCauseOptions(taskType: "task1" | "task2") {
  return WRITING_ERROR_CAUSES.filter(
    (cause) =>
      cause !== (taskType === "task1" ? "task-response" : "task-achievement"),
  ).map((id) => ({ id, label: causeLabels[id] }));
}
