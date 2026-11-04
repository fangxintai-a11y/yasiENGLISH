import type { Revision } from "./protocol";
import { speakingCalibrationForWork } from "./speakingCalibration";
import { SPEAKING_ERROR_CAUSES } from "./speakingChecklist";
import { part2Full, speakingPart } from "./speakingModel";
import { speakingFeedbackForWork } from "./speakingReview";

/** Repository records are current heads; immutable history is read separately. */
export function listSpeakingWorks(
  records: readonly Revision[],
  planId: string,
): Revision[] {
  return records
    .filter(
      (work) =>
        work.kind === "speaking" &&
        work.planId === planId &&
        !work.deleted &&
        !work.conflict,
    )
    .sort(
      (a, b) =>
        String(b.payload.date ?? "").localeCompare(
          String(a.payload.date ?? ""),
        ) || b.createdAt - a.createdAt,
    );
}

export function speakingListSummary(
  work: Revision,
  records: readonly Revision[],
) {
  const part = speakingPart(work.payload.part);
  const durationSeconds =
    typeof work.payload.durationSeconds === "number" &&
    Number.isFinite(work.payload.durationSeconds) &&
    work.payload.durationSeconds >= 0
      ? work.payload.durationSeconds
      : null;
  const recordedCauses = new Set(
    speakingFeedbackForWork(records, work).flatMap((feedback) =>
      Array.isArray(feedback.payload.errorCauses)
        ? feedback.payload.errorCauses
        : [],
    ),
  );
  return {
    part,
    durationSeconds,
    part2Full:
      part === 2 && durationSeconds !== null
        ? part2Full(durationSeconds)
        : null,
    hasRecordingReference:
      typeof work.payload.recordingId === "string" &&
      !!work.payload.recordingId.trim(),
    hasTranscript:
      typeof work.payload.transcript === "string" &&
      !!work.payload.transcript.trim(),
    errorCauses: SPEAKING_ERROR_CAUSES.filter((cause) =>
      recordedCauses.has(cause),
    ),
    hasHumanCalibration: speakingCalibrationForWork(records, work).length > 0,
  };
}
