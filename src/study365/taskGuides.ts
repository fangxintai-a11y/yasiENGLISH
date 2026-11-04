export type PhaseId = "baseline" | "phase1" | "phase2" | "phase3" | "phase4";
const names: Record<string, string> = { vocabulary: "词汇", listening: "听力", reading: "阅读", writing: "写作", speaking: "口语", review: "复盘", "timed-section": "分科限时", "weak-skill": "弱项练习", "human-calibration-handoff": "交给真人评分", "correction-log": "订正与记录", "app-setup": "计划与工具设置" };
const base: Record<string, string> = {
  vocabulary: "先完成到期复习，再按今日词汇预算学习新词；把词放回语境核对意思与拼写。",
  listening: "点击开始练习，首答只播一遍，结束后检查一分钟再提交；复盘时自由回听，也可外部完成后登记。",
  reading: "点击开始练习，限时首答后判分，再查原文证据；也可在外部完成后登记。",
  writing: "在外部完成独立写作，保存原稿与题目；写作分等待真人或正式评估。",
  speaking: "在外部录音并回听，保留题目与原音频；口语分等待真人或正式评估。",
  review: "对照答案或反馈找出一个具体问题，记录证据和下一次要改的做法。",
  "timed-section": "完成当前科目的限时任务，保留首答、材料和实际用时；按这份材料的要求执行。",
  "weak-skill": "围绕当前差距最大的科目处理一项具体问题，保留练习与订正记录。",
  "human-calibration-handoff": "把本周Task 2原稿和口语录音交给真人评阅；尚未返回的分数保持待评估。",
  "correction-log": "整理本次测评的证据和错因，写下一个可执行的订正动作。",
  "app-setup": "确认计划时区、合法材料与录音保存方式，准备后续练习和真人评阅渠道。",
};
const phase: Partial<Record<PhaseId, Record<string, string>>> = {
  baseline: { listening: "用合法取得且未做过的完整听力题采集基线，保留首答、原始正确数和作答条件。", reading: "用未做过的学术阅读整套题采集基线，保留原始正确数；按材料提供的换算表登记。", writing: "在外部独立完成Task 1和Task 2并保存原稿，交给真人评阅；没有真人分时留空。", speaking: "在外部完成Part 1、2、3并录音，交给真人听原音频评阅；没有真人分时留空。" },
  phase1: { writing: "完成当前题型的一段独立表达或Task 1练习，再核对是否回应题目并保存原稿。", speaking: "围绕题目回答并补充理由或例子，录音后回听一处表达。" },
  phase2: { writing: "练习Task 1主要特征或Task 2论证，保留原稿并按反馈订正。", speaking: "练习Part 1、2、3的表达与追问，保存题目和录音。" },
  phase3: { writing: "按题目限时完成写作，比较原稿与修改稿，并核对真人反馈中的证据。", speaking: "完成连贯回答和追问，回听具体停顿或表达问题后重录。" },
};
export function taskGuide(blockId: string, phaseId: PhaseId): string { return phase[phaseId]?.[blockId] ?? base[blockId] ?? "在外部完成后登记材料、状态和实际用时。"; }
export function taskTitle(blockId: string, skill?: string | null): string { return `${names[blockId] ?? "学习任务"}${["timed-section", "weak-skill"].includes(blockId) && skill ? ` · ${names[skill] ?? skill}` : ""}`; }
