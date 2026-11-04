import type { Entry } from "../../atlas/types";
import type { Mnemonic } from "../tags";
import type { Reading, SavedHack } from "../../store/store";
import type { SCORE_SOURCES, ERROR_CAUSES } from "../../study365/protocol";
export type ScoreSource = (typeof SCORE_SOURCES)[number];
export type MachineSource = Extract<ScoreSource, "rules" | "ai">;
export type ErrorCause = (typeof ERROR_CAUSES)[number];
export type FeedbackMode = "rules" | "manual" | "auto";
export type TaskId = "essay" | "speaking" | "sentence" | "reading" | "hack";
export type LlmErrorCode = "no-provider" | "auth" | "quota" | "network" | "timeout" | "cancelled" | "bad-json" | "schema" | "http";
export interface FallbackEntry { provider: string; error: LlmErrorCode }
export interface FallbackInfo { fallbackTrail: FallbackEntry[]; needsManual?: boolean }
export interface ScoringContext { mode: FeedbackMode; signal?: AbortSignal; now?: number }
export type Task1Criterion = "taskAchievement" | "coherence" | "lexical" | "grammar";
export type Task2Criterion = "taskResponse" | "coherence" | "lexical" | "grammar";
export type SpeakingCriterion = "fluency" | "lexical" | "grammar" | "pronunciation";
export type WritingTaskType = "task1" | "task2";
export interface Evidence { kind: "span" | "metric" | "rule"; ruleId?: string; text?: string; start?: number; end?: number; metric?: string; value?: number; message: string }
export interface CriterionScore { band: number | null; confidence: number; evidence: Evidence[]; target: number; gap: number | null }
export interface ScoreResult<C extends string> extends FallbackInfo {
  kind: "writing" | "speaking"; taskType: WritingTaskType | "speaking"; rubricVersion: string;
  source: MachineSource; provider: string | null;
  /** Exact original UTF-8 text hash, including whitespace, as required by P1. */
  inputHash: string; assessedAt: number; criteria: Record<C, CriterionScore>; overall: number | null;
  causes: ErrorCause[]; warnings: string[]; rewrite8: string; summaryZh: string;
}
export type WritingResult = (ScoreResult<Task1Criterion> & { kind: "writing"; taskType: "task1" }) | (ScoreResult<Task2Criterion> & { kind: "writing"; taskType: "task2" });
export type SpeakingResult = ScoreResult<SpeakingCriterion> & { kind: "speaking"; taskType: "speaking" };
export interface SentenceResult extends FallbackInfo {
  score: 0 | 1 | 2 | 3; usedCorrectly: boolean; verdict: string; corrected: string; better: string; notes: string[];
  source: MachineSource; provider: string | null; confidence: number; evidence: Evidence[]; cause: ErrorCause | null;
  warnings?: string[];
}
export interface SentenceInput { word: string; zh: string; sentence: string; entry: Entry | null }
export interface ReadingWord { id: string; word: string; zh: string; entry: Entry | null }
export interface ReadingInput { words: ReadingWord[] }
export interface HackInput { word: string; ipa: string; zh: string; syllables: string | null; mnemonic: Mnemonic | null }
export interface WritingInput { taskType: WritingTaskType; prompt: string; text: string; taskData?: unknown; feedbackContext?: { workRevisionId: string; inputHash: string } }
export interface TimedWord { w: string; start: number; end: number }
export interface SpeakingInput { part: 1 | 2 | 3; prompt: string; transcript: string; words?: TimedWord[]; durationSeconds: number; cueCardPoints?: string[] }
export interface ReadingBody { title: string; passage: string; zh: string; questions: { q: string; a: "TRUE" | "FALSE" | "NOT GIVEN"; why: string }[] }
export interface HackBody { homophone: string; split: string; scene: string }
export interface ReadingCoverage { requestedWordIds: string[]; coveredWordIds: string[]; uncoveredWordIds: string[] }
export type ReadingResult = Reading & FallbackInfo & { src: "rules" | "ai" | "manual"; coverage: ReadingCoverage };
export type HackResult = SavedHack & FallbackInfo & { src: "rules" | "ai" | "manual" };
export interface FeedbackWork { planId: string; workId: string; workRevisionId: string; text: string }
export const RUBRIC_VERSION = "bg-rubric-2026.11-s0";
