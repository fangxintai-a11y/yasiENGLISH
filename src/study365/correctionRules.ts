import { ERROR_CAUSES, type CORRECTION_ACTIONS } from "./protocol";

export type CorrectionSkill = "listening" | "reading" | "writing" | "speaking";
export type CorrectionCause = (typeof ERROR_CAUSES)[number];
export type CorrectionAction = (typeof CORRECTION_ACTIONS)[number];
export const CORRECTION_RULES: Record<
  CorrectionCause,
  { action: CorrectionAction; label: string }
> = {
  "synonym-miss": {
    action: "rephrase-pair",
    label: "记录原句与题干的同义替换，确认生词后加入复习。",
  },
  "locating-error": {
    action: "locate-evidence",
    label: "回到证据段或音频位置，重新定位并说明依据。",
  },
  spelling: {
    action: "vocab-review",
    label: "核对拼写，把需要复习的词加入已有FSRS。",
  },
  "time-pressure": {
    action: "review-timing",
    label: "回顾超时位置和答题顺序，在原预算内重做该步骤。",
  },
  "word-limit": {
    action: "review-instructions",
    label: "重读词数限制，说明原答案如何超限并写出合规答案。",
  },
  "vocab-unknown": {
    action: "vocab-review",
    label: "确认词义与语境，把生词加入已有FSRS。",
  },
  "misread-question": {
    action: "review-instructions",
    label: "重读题干并用自己的话说明真正要求。",
  },
  "tfng-inference": {
    action: "explain-judgment",
    label: "重做该组判断题，分别写出支持、反驳或信息不足的理由。",
  },
  grammar: {
    action: "rewrite-paragraph",
    label: "修改原稿里有语法问题的一段并与原稿对比。",
  },
  "lexical-misuse": {
    action: "rewrite-paragraph",
    label: "修改原稿中不准确的用词，并说明新表达的适用语境。",
  },
  coherence: {
    action: "rewrite-paragraph",
    label: "修改原稿一段的论点、衔接和顺序。",
  },
  "task-response": {
    action: "rewrite-paragraph",
    label: "重读题目，修改一段以直接回答问题。",
  },
  "task-achievement": {
    action: "rewrite-paragraph",
    label: "核对原题数据，修改总体概述或比较段。",
  },
  "fluency-pause": {
    action: "rerecord-segment",
    label: "同题重录一段，回听停顿并保留两版。",
  },
  pronunciation: {
    action: "rerecord-segment",
    label: "同题重录一段并回听，自查不换算发音分数。",
  },
  other: {
    action: "review-error",
    label: "说明具体问题、原依据和本轮订正动作。",
  },
};
export function correctionAction(
  cause: CorrectionCause,
  skill: CorrectionSkill,
): CorrectionAction {
  const action = CORRECTION_RULES[cause].action;
  return skill === "speaking" && action === "rewrite-paragraph"
    ? "rerecord-segment"
    : action;
}
export function correctionDimension(
  cause: CorrectionCause,
  skill: "writing" | "speaking",
  taskType?: unknown,
): string {
  const dimensions: Partial<Record<CorrectionCause, string>> = {
    grammar: "grammar",
    coherence: skill === "speaking" ? "fluency" : "coherence",
    "lexical-misuse": "lexical",
    spelling: "lexical",
    "vocab-unknown": "lexical",
    "task-response": "taskResponse",
    "task-achievement": "taskAchievement",
    "fluency-pause": "fluency",
    pronunciation: "pronunciation",
  };
  if (cause === "task-response" && taskType === "task1")
    return "taskAchievement";
  return dimensions[cause] ?? "other";
}
