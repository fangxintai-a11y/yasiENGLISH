/** Stable wire IDs; learner-facing explanations belong to the writing rubric. */
const shared = ["coherence-organisation", "coherence-progression", "coherence-cohesion", "lexical-precision", "lexical-range", "lexical-collocation", "grammar-range", "grammar-accuracy", "grammar-punctuation"] as const;
export const WRITING_CHECKLIST_IDS = Object.freeze({
  task1: Object.freeze(["task-achievement-coverage", "task-achievement-accuracy", "task-achievement-relevance", ...shared, "task1-overview", "task1-comparison", "task1-no-opinion"] as const),
  task2: Object.freeze(["task-response-answer", "task-response-position", "task-response-support", ...shared] as const),
});
export type WritingTaskType = keyof typeof WRITING_CHECKLIST_IDS;
export const writingChecklistIds = (taskType: WritingTaskType): readonly string[] => WRITING_CHECKLIST_IDS[taskType];
export const WRITING_ERROR_CAUSES = Object.freeze(["task-achievement", "task-response", "coherence", "lexical-misuse", "grammar", "spelling", "word-limit", "time-pressure", "misread-question", "vocab-unknown", "other"] as const);
