import {
  LISTENING_QUESTION_TYPES,
  READING_QUESTION_TYPES,
} from "./contentSchemas";
import type { LocalMaterial, LocalQuestion } from "./localBankSchema";
import { currentAttempts } from "./readingModel";
import { isObject, type Revision } from "./protocol";
import {
  answerReviewTargetKey,
  latestAnswerReviews,
} from "./answerReviewModel";

type Skill = "listening" | "reading";
export interface ExamCatalogEntry {
  skill: Skill;
  examId: string;
  complete: boolean;
  fullPlayable: boolean;
}
/** A derived sequence binds an existing virtual full to its real leaf originals.
 * No sequence runtime or synthetic audio is needed by the coverage model. */
export interface SequenceOriginCatalog {
  material: LocalMaterial;
  parts: readonly LocalMaterial[];
}
export interface CoverageRow {
  skill: Skill;
  questionType: string;
  official: number;
  cambridge: number;
  other: number;
  available: number;
  done: number;
  unseen: number;
  retestAvailable: number;
  missing: number;
  officialMissing: number;
  missingRetest: number;
}
export interface CoverageGap {
  skill: Skill;
  questionType?: string;
  purpose:
    | "question-type"
    | "official-type"
    | "retest"
    | "annual-sections"
    | "annual-exams"
    | "holdout";
  required: number;
  available: number;
  missing: number;
}
export interface ExamCoverage {
  skill: Skill;
  complete: number;
  fullPlayable: number;
  sequential: number;
  holdout: number;
  holdoutRequired: number;
  holdoutMissing: number;
  unseenPractice: number;
  annualRequired: number;
  annualMissing: number;
}
export interface SectionCoverage {
  skill: Skill;
  available: number;
  done: number;
  remaining: number;
  daysRemaining: number;
  annualRequired: number;
  annualMissing: number;
}
const identity = (material: LocalMaterial) =>
  JSON.stringify([material.id, material.version, material.contentHash]);
const sourceRank = (material: LocalMaterial) =>
  ({ official: 0, cambridge: 1, publisher: 2, unofficial: 3 })[
    material.source.materialSource
  ];
const original = (material: LocalMaterial) =>
  material.skill === "reading" ? material.passage : material.transcript;
const bodyKey = (material: LocalMaterial) =>
  `${material.skill}:${original(material).toLowerCase().replace(/\s+/g, " ").trim()}`;
const examKey = (material: LocalMaterial) =>
  material.examId ? `${material.skill}:${material.examId}` : null;
const usable = (material: LocalMaterial) =>
  !material.source.sourceRef.startsWith("builtin:") &&
  material.scope !== "short" &&
  material.questions.length > 0 &&
  (material.skill === "reading" ||
    (!!material.audio?.path && material.audio.durationSeconds > 0));
/** Only current representations count. The same original in a full paper and its section is one question. */
export function coverageMaterials(
  bank: readonly LocalMaterial[],
): LocalMaterial[] {
  const current = new Map<string, LocalMaterial>();
  for (const material of [...bank].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }),
  ))
    if (!current.has(material.id)) current.set(material.id, material);
  return [...current.values()].filter(usable);
}
function questionKey(material: LocalMaterial, question: LocalQuestion) {
  return material.examId
    ? JSON.stringify([
        material.skill,
        material.examId,
        question.number ?? question.id,
      ])
    : JSON.stringify([material.skill, material.id, question.id]);
}
function hasFortyNumbers(materials: readonly LocalMaterial[]) {
  const numbers = materials.flatMap((material) =>
    material.questions.map((question) => question.number),
  );
  return (
    numbers.length === 40 &&
    new Set(numbers).size === 40 &&
    Array.from({ length: 40 }, (_, index) => index + 1).every((number) =>
      numbers.includes(number),
    )
  );
}
/** No catalog claim can substitute for present original questions and audio references. */
export function completeExamGroups(bank: readonly LocalMaterial[]) {
  const groups = new Map<string, LocalMaterial[]>();
  for (const material of coverageMaterials(bank)) {
    const key = examKey(material);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), material]);
  }
  return [...groups.values()].map((materials) => {
    const first = materials[0],
      skill = first.skill;
    const full = materials.find(
      (material) =>
        material.scope === "full" &&
        material.questions.length === 40 &&
        (skill === "reading" || hasFortyNumbers([material])),
    );
    const parts = new Map<number, LocalMaterial>();
    for (const material of materials.filter(
      (material) => material.scope === "section",
    )) {
      const index =
        material.skill === "listening"
          ? material.section
          : material.passageNumber;
      if (index && !parts.has(index)) parts.set(index, material);
    }
    const expected = skill === "listening" ? 4 : 3;
    const ordered = Array.from({ length: expected }, (_, index) =>
      parts.get(index + 1),
    );
    const allParts = ordered.every(
      (material): material is LocalMaterial => !!material,
    );
    const completeParts =
      allParts &&
      hasFortyNumbers(ordered as LocalMaterial[]) &&
      (skill === "reading" ||
        (ordered as LocalMaterial[]).every(
          (material, index) =>
            material.questions.length === 10 &&
            material.questions.every(
              (question) =>
                question.number! >= index * 10 + 1 &&
                question.number! <= (index + 1) * 10,
            ),
        ));
    const sequential = skill === "listening" && completeParts;
    return {
      skill,
      examId: first.examId!,
      complete: !!full || !!completeParts,
      fullPlayable: !!full,
      sequential: !!sequential,
      holdout: materials.some((material) => material.pool === "holdout"),
      materials,
    };
  });
}
/** Add only exact current originals of an actually completed derived sequence. */
function markSequenceOriginalsUsed(
  used: Set<string>,
  materials: readonly LocalMaterial[],
  attempts: readonly Revision[],
  sequenceOrigins: readonly SequenceOriginCatalog[],
) {
  for (const { material: virtual, parts } of sequenceOrigins) {
    if (
      virtual.skill !== "listening" ||
      virtual.scope !== "full" ||
      virtual.audio ||
      !virtual.examId ||
      !hasFortyNumbers([virtual]) ||
      parts.length !== 4
    )
      continue;
    // A stale manifest cannot consume even its unchanged siblings after a source
    // version changes. Only one complete, exact current four-part set qualifies.
    const originals = parts.map((part) =>
      materials.find(
        (current) =>
          current.skill === "listening" && identity(current) === identity(part),
      ),
    );
    if (
      originals.some(
        (part, index) =>
          !part ||
          part.skill !== "listening" ||
          part.scope !== "section" ||
          part.section !== index + 1 ||
          part.examId !== virtual.examId ||
          part.questions.length !== 10 ||
          part.source.materialSource !== virtual.source.materialSource ||
          (part.pool ?? "practice") !== (virtual.pool ?? "practice") ||
          !part.audio?.path ||
          part.audio.durationSeconds <= 0,
      ) ||
      new Set(originals.map((part) => part && identity(part))).size !== 4
    )
      continue;
    const exactOriginals = originals as LocalMaterial[];
    if (!hasFortyNumbers(exactOriginals)) continue;
    const completed = attempts.some((work) => {
      const payload = work.payload;
      return (
        payload.skill === "listening" &&
        payload.scope === "full" &&
        payload.total === 40 &&
        isObject(payload.conditions) &&
        payload.conditions.sequential === true &&
        payload.contentId === virtual.id &&
        payload.contentVersion === virtual.version &&
        payload.contentHash === virtual.contentHash
      );
    });
    if (completed) for (const part of exactOriginals) used.add(identity(part));
  }
}
export function bankCoverage(
  bank: readonly LocalMaterial[],
  records: readonly Revision[],
  planId: string,
  _examCatalog: readonly ExamCatalogEntry[] = [],
  sequenceOrigins: readonly SequenceOriginCatalog[] = [],
) {
  const materials = coverageMaterials(bank),
    attempts = currentAttempts(records, planId);
  const used = new Set(
    attempts.map((work) =>
      JSON.stringify([
        work.payload.contentId,
        work.payload.contentVersion,
        work.payload.contentHash,
      ]),
    ),
  );
  markSequenceOriginalsUsed(used, materials, attempts, sequenceOrigins);
  const usedBodies = new Set(
    materials.filter((material) => used.has(identity(material))).map(bodyKey),
  );
  const heldExams = new Set(
    materials
      .filter((material) => material.pool === "holdout")
      .flatMap((material) => (examKey(material) ? [examKey(material)!] : [])),
  );
  const practice = (material: LocalMaterial) =>
    material.pool !== "holdout" &&
    !(examKey(material) && heldExams.has(examKey(material)!));
  const unseen = (material: LocalMaterial) =>
    !used.has(identity(material)) && !usedBodies.has(bodyKey(material));
  const priority = (a: LocalMaterial, b: LocalMaterial) =>
    (a.scope === "section" ? 0 : a.scope === "type-drill" ? 1 : 2) -
      (b.scope === "section" ? 0 : b.scope === "type-drill" ? 1 : 2) ||
    sourceRank(a) - sourceRank(b) ||
    a.id.localeCompare(b.id);
  const uniqueQuestions = new Map<
    string,
    {
      material: LocalMaterial;
      question: LocalQuestion;
      aliases: { material: LocalMaterial; question: LocalQuestion }[];
    }
  >();
  for (const material of [...materials].sort(priority))
    for (const question of material.questions) {
      const key = questionKey(material, question),
        previous = uniqueQuestions.get(key);
      if (previous) previous.aliases.push({ material, question });
      else
        uniqueQuestions.set(key, {
          material,
          question,
          aliases: [{ material, question }],
        });
    }
  const reviews = new Map(
    latestAnswerReviews(records, planId).map((record) => [
      answerReviewTargetKey(
        String(record.payload.materialId),
        String(record.payload.contentVersion),
        String(record.payload.contentHash),
        String(record.payload.questionId),
      ),
      record,
    ]),
  );
  const sectionExamKeys = new Set(
    materials
      .filter((material) => material.scope === "section" && material.examId)
      .map(examKey),
  );
  const retestUnits = materials.filter(
    (material) =>
      material.scope !== "full" ||
      !material.examId ||
      !sectionExamKeys.has(examKey(material)),
  );
  const rows: CoverageRow[] = [];
  for (const skill of ["listening", "reading"] as const)
    for (const questionType of skill === "listening"
      ? LISTENING_QUESTION_TYPES
      : READING_QUESTION_TYPES) {
      const entries = [...uniqueQuestions.values()].filter(
        (entry) =>
          entry.material.skill === skill &&
          entry.question.type === questionType &&
          entry.aliases.some((alias) => practice(alias.material)),
      );
      const counts = { official: 0, cambridge: 0, other: 0 };
      let done = 0;
      for (const entry of entries) {
        const source = entry.material.source.materialSource;
        counts[
          source === "official" || source === "cambridge" ? source : "other"
        ]++;
        if (entry.aliases.some((alias) => used.has(identity(alias.material))))
          done++;
      }
      const newMaterials = new Set(
        retestUnits
          .filter(
            (material) =>
              material.skill === skill &&
              practice(material) &&
              unseen(material) &&
              material.questions.some(
                (question) => question.type === questionType,
              ),
          )
          .map(bodyKey),
      );
      rows.push({
        skill,
        questionType,
        ...counts,
        available: entries.length,
        done,
        unseen: entries.length - done,
        retestAvailable: newMaterials.size,
        missing: entries.length ? 0 : 1,
        officialMissing: counts.official ? 0 : 1,
        missingRetest: newMaterials.size ? 0 : 1,
      });
    }
  const groups = completeExamGroups(materials);
  const exams: ExamCoverage[] = (["listening", "reading"] as const).map(
    (skill) => {
      const complete = groups.filter(
          (group) => group.skill === skill && group.complete,
        ),
        holdout = complete.filter((group) => group.holdout).length;
      const unseenPractice = complete.filter(
        (group) =>
          !group.holdout &&
          !group.materials.some(
            (material) =>
              used.has(identity(material)) || usedBodies.has(bodyKey(material)),
          ),
      ).length;
      return {
        skill,
        complete: complete.length,
        fullPlayable: complete.filter((group) => group.fullPlayable).length,
        sequential: complete.filter((group) => group.sequential).length,
        holdout,
        holdoutRequired: 8,
        holdoutMissing: Math.max(0, 8 - holdout),
        unseenPractice,
        annualRequired: 69,
        annualMissing: Math.max(0, 69 - unseenPractice),
      };
    },
  );
  const sections: SectionCoverage[] = (["listening", "reading"] as const).map(
    (skill) => {
      const unique = new Map(
        materials
          .filter(
            (material) =>
              material.skill === skill &&
              material.scope === "section" &&
              practice(material),
          )
          .sort(priority)
          .map((material) => [bodyKey(material), material]),
      );
      const remaining = [...unique.values()].filter(unseen).length;
      return {
        skill,
        available: unique.size,
        done: unique.size - remaining,
        remaining,
        daysRemaining: remaining,
        annualRequired: 260,
        annualMissing: Math.max(0, 260 - remaining),
      };
    },
  );
  let pending = 0,
    reviewed = 0,
    keyWrong = 0,
    ambiguous = 0;
  for (const entry of uniqueQuestions.values()) {
    const decision = reviews.get(
      answerReviewTargetKey(
        entry.material.id,
        entry.material.version,
        entry.material.contentHash,
        entry.question.id,
      ),
    );
    if (decision) {
      reviewed++;
      if (decision.payload.verdict === "key-wrong") keyWrong++;
      if (decision.payload.verdict === "ambiguous") ambiguous++;
    } else if (entry.question.answerVerified) reviewed++;
    else pending++;
  }
  const gaps: CoverageGap[] = [
    ...rows.flatMap((row) => [
      ...(row.officialMissing
        ? [
            {
              skill: row.skill,
              questionType: row.questionType,
              purpose: "official-type" as const,
              required: 1,
              available: 0,
              missing: 1,
            },
          ]
        : []),
      ...(row.missing
        ? [
            {
              skill: row.skill,
              questionType: row.questionType,
              purpose: "question-type" as const,
              required: 1,
              available: 0,
              missing: 1,
            },
          ]
        : []),
      ...(row.missingRetest
        ? [
            {
              skill: row.skill,
              questionType: row.questionType,
              purpose: "retest" as const,
              required: 1,
              available: 0,
              missing: 1,
            },
          ]
        : []),
    ]),
    ...sections
      .filter((row) => row.annualMissing)
      .map((row) => ({
        skill: row.skill,
        purpose: "annual-sections" as const,
        required: 260,
        available: row.remaining,
        missing: row.annualMissing,
      })),
    ...exams.flatMap((row) => [
      ...(row.annualMissing
        ? [
            {
              skill: row.skill,
              purpose: "annual-exams" as const,
              required: 69,
              available: row.unseenPractice,
              missing: row.annualMissing,
            },
          ]
        : []),
      ...(row.holdoutMissing
        ? [
            {
              skill: row.skill,
              purpose: "holdout" as const,
              required: 8,
              available: row.holdout,
              missing: row.holdoutMissing,
            },
          ]
        : []),
    ]),
  ];
  return {
    rows,
    exams,
    sections,
    audits: {
      pending,
      reviewed,
      keyWrong,
      ambiguous,
      independentQuestions: uniqueQuestions.size,
      rawQuestionEntries: materials.reduce(
        (sum, material) => sum + material.questions.length,
        0,
      ),
    },
    materialRecords: materials.length,
    gaps,
  };
}
export function exportBankGaps(coverage: ReturnType<typeof bankCoverage>) {
  return { exportVersion: 1, gaps: coverage.gaps.map((gap) => ({ ...gap })) };
}
