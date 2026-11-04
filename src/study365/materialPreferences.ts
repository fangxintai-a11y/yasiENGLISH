import type { LocalMaterial } from "./localBankSchema";
import { isListeningSequenceMaterial } from "./listeningSequence";
import type { Revision } from "./protocol";
import {
  isHeldOutListeningReading,
  unseenListeningReading,
} from "./retestSelection";
import { prioritizeMaterials, type AcceptedPreferences } from "./weeklyReview";
/** Wrap the existing level/order recommendation; accepted preferences do not alter its rules. */
export function preferPracticeMaterial(
  base: LocalMaterial | null,
  bank: readonly LocalMaterial[],
  records: readonly Revision[],
  planId: string,
  skill: "reading" | "listening",
  preferences: AcceptedPreferences,
) {
  const wanted = preferences.questionTypes[skill];
  if (!wanted.length) return { material: base, missingTypes: [] as string[] };
  const reserved = new Set(
    bank
      .filter(
        (m) =>
          !isListeningSequenceMaterial(m) &&
          m.skill === skill &&
          m.scope === "full" &&
          m.examId,
      )
      .map((m) => m.examId),
  );
  const pool = [
    ...(base ? [base] : []),
    ...bank.filter((m) => m !== base),
  ].filter(
    (m) =>
      m.skill === skill &&
      m.scope === "section" &&
      m.questions.length &&
      (m.skill === "reading" || !!m.audio) &&
      !isHeldOutListeningReading(m, bank) &&
      unseenListeningReading(m, records, bank, planId) &&
      !(m.examId && reserved.has(m.examId)) &&
      (skill !== "reading" ||
        !base ||
        base.skill !== "reading" ||
        !base.passageNumber ||
        (m.skill === "reading" && m.passageNumber === base.passageNumber)),
  );
  const ranked = prioritizeMaterials(pool, preferences, skill),
    found = ranked.find((m) =>
      m.questions.some((q) => wanted.includes(q.type)),
    );
  return {
    material: found ?? base,
    missingTypes: wanted.filter(
      (type) => !pool.some((m) => m.questions.some((q) => q.type === type)),
    ),
  };
}
