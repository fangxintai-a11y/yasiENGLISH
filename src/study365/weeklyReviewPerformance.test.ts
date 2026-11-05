import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  canonical,
  SECTION_TARGETS,
  validatePayload,
  type LearningPayload,
  type Revision,
} from "./protocol";
import { buildWeeklyReview } from "./weeklyReview";

/** Same 365-day/15000-record kind distribution as the release probe, with real error causes. */
function historyFixture() {
  const planId = "weekly-scale-plan",
    records: Revision[] = [];
  let sequence = 0;
  const date = (day: number) =>
    new Date(Date.UTC(2026, 10, 9 + day - 1)).toISOString().slice(0, 10);
  const append = (
    kind: Revision["kind"],
    payload: LearningPayload,
    id: string,
  ) => {
    const seq = ++sequence;
    const record: Revision = {
      id,
      kind,
      planId,
      datasetId: null,
      payloadVersion: 2,
      revisionId: `b6000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      baseRevision: null,
      seq,
      createdAt: seq,
      deleted: false,
      conflict: false,
      payload,
      contentHash: createHash("sha256")
        .update(
          kind === "essay"
            ? String(payload.text)
            : kind === "speaking"
              ? String(payload.transcript)
              : canonical(payload),
        )
        .digest("hex"),
    };
    records.push(record);
    return record;
  };
  const plan = append(
    "plan",
    {
      planId,
      startDate: date(1),
      timeZone: "Asia/Shanghai",
      studyBudgetMinutes: 120,
      targetBand: 8,
      sectionTargets: SECTION_TARGETS,
    },
    planId,
  );
  for (let day = 1; day <= 365; day++) {
    const currentDate = date(day),
      works: Revision[] = [];
    for (let i = 0; i < 5; i++)
      append(
        "mission",
        {
          planId,
          date: currentDate,
          day,
          taskId: `scale-d${day}-task${i}`,
          skill: ["listening", "reading", "writing", "speaking", "vocabulary"][
            i
          ],
          status: "partial",
          plannedMinutes: 0,
          actualMinutes: 0,
          timeSource: "timer",
        },
        `scale-d${day}-mission${i}`,
      );
    for (let i = 0; i < 12; i++)
      append(
        "attempt",
        {
          planId,
          date: currentDate,
          day,
          skill: i % 2 ? "reading" : "listening",
          contentId: `scale-material-${i}`,
          contentVersion: "1",
          contentHash: "a".repeat(64),
          materialSource: "unofficial",
          sourceRef: "self-authored:scale",
          scope: "type-drill",
          answers: ["fixture"],
          score: 1,
          correct: 1,
          total: 1,
          firstAttempt: false,
          conditions: {
            timed: true,
            firstAttempt: false,
            unseen: false,
            replayed: false,
            transcriptViewed: false,
            replays: 0,
          },
          questionResults: [
            {
              questionId: `scale-q${i}`,
              correct: true,
              reviewCorrect: true,
              confidence: "sure",
              errorCause: null,
              answerDisputed: false,
            },
          ],
        },
        `scale-d${day}-attempt${i}`,
      );
    for (let i = 0; i < 8; i++)
      works.push(
        append(
          "essay",
          {
            planId,
            date: currentDate,
            day,
            contentId: `scale-essay-${i}`,
            contentVersion: "1",
            taskType: "task2",
            scope: "full",
            stage: "submitted",
            prompt: "Self-authored scaling fixture writing prompt.",
            text: `Self-authored synthetic writing day ${day}, work ${i}.`,
            wordCount: 8,
            elapsedSeconds: 60,
            conditions: { timed: true, firstAttempt: false, unseen: false },
          },
          `scale-d${day}-essay${i}`,
        ),
      );
    for (let i = 0; i < 8; i++)
      works.push(
        append(
          "speaking",
          {
            planId,
            date: currentDate,
            day,
            contentId: `scale-speaking-${i}`,
            contentVersion: "1",
            part: 1,
            prepSeconds: 0,
            prompt: "Self-authored scaling fixture oral question.",
            transcript: `Self-authored synthetic speaking day ${day}, work ${i}.`,
            durationSeconds: 12,
            recordingStatus: "none",
            conditions: { timed: true, firstAttempt: false, unseen: false },
          },
          `scale-d${day}-speaking${i}`,
        ),
      );
    for (const [i, work] of [
      ...works.slice(0, 4),
      ...works.slice(8, 12),
    ].entries()) {
      const speaking = work.kind === "speaking";
      append(
        "feedback",
        {
          planId,
          workId: work.id,
          workRevisionId: work.revisionId,
          inputHash: work.contentHash,
          rubricVersion: "self-authored-scale-v1",
          source: "self",
          sourceText: "Self-authored benchmark estimate.",
          assessedAt: Date.parse(`${currentDate}T04:00:00Z`),
          text: "Self-authored synthetic feedback, not an actual learner result.",
          taskType: speaking ? "speaking" : "task2",
          errorCauses: [speaking ? "fluency-pause" : "grammar"],
          bands: speaking
            ? { fluency: 7, lexical: 7, grammar: 7, pronunciation: 7 }
            : { taskResponse: 7, coherence: 7, lexical: 7, grammar: 7 },
        },
        `scale-d${day}-feedback${i}`,
      );
    }
    if (day <= 35)
      append(
        "assessment",
        {
          planId,
          date: currentDate,
          day,
          kind: "weekly-mock",
          source: "self",
          materialId: `scale-mock-${day}`,
          scores: { listening: 6, reading: 6, writing: 6, speaking: 6 },
          scoreSources: {
            listening: "self",
            reading: "self",
            writing: "self",
            speaking: "self",
          },
          conditions: {
            timed: true,
            unseen: false,
            replayed: false,
            viewedTranscript: false,
          },
          note: "Self-authored unqualified benchmark mock.",
        },
        `scale-d${day}-assessment`,
      );
  }
  return { plan, records, bank: [], date: date(365) };
}
const resultHash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

test("15000 mixed historical records preserve the complete pre-index weekly result and every eligible feedback", () => {
  const fixture = historyFixture();
  assert.equal(fixture.records.length, 15001);
  const counts = fixture.records.reduce(
    (out, row) => {
      out[row.kind] = (out[row.kind] ?? 0) + 1;
      return out;
    },
    {} as Record<string, number>,
  );
  assert.deepEqual(counts, {
    plan: 1,
    mission: 1825,
    attempt: 4380,
    essay: 2920,
    speaking: 2920,
    feedback: 2920,
    assessment: 35,
  });
  for (const record of fixture.records)
    validatePayload(record.kind, record.payload);
  const before = resultHash(fixture.records),
    model = buildWeeklyReview(fixture);
  assert.equal(
    resultHash(fixture.records),
    before,
    "reporting must not change raw records, scores or hashes",
  );
  assert.equal(model.weekIndex, 52);
  assert.equal(model.since, "2027-10-12");
  for (const [skill, errorCause] of [
    ["writing", "grammar"],
    ["speaking", "fluency-pause"],
  ]) {
    const row = model.summaries
      .find((item) => item.skill === skill)!
      .causes.find((item) => item.errorCause === errorCause)!;
    assert.equal(row.count, 28 * 4);
    assert.equal(row.recordIds.length, 28 * 4 * 2);
    assert.ok(
      row.recordIds.includes(
        `scale-d338-${skill === "writing" ? "essay0" : "speaking0"}`,
      ),
    );
    assert.ok(!row.recordIds.some((id) => id.startsWith("scale-d337-")));
    const suggestion = model.suggestions.find(
      (item) => item.skill === skill && item.dimension === errorCause,
    )!;
    assert.deepEqual(suggestion.evidence.recordIds, row.recordIds);
    assert.equal(suggestion.evidence.value, 112);
    assert.equal(suggestion.evidence.threshold, 5);
  }
  // Captured from the complete old linear implementation on this deterministic fixture.
  assert.equal(
    resultHash(model),
    "ad768eb39cf39256527c213938b2b21cad3d12146e04f29dab314f1445c82664",
  );
});

test("feedback binding work grows with feedback count instead of scanning all unrelated history", () => {
  const fixture = historyFixture(),
    feedback = fixture.records.filter((row) => row.kind === "feedback");
  let bindingReads = 0;
  const budget = feedback.length * 8;
  for (const row of feedback) {
    const original = row.payload.workRevisionId;
    Object.defineProperty(row.payload, "workRevisionId", {
      enumerable: true,
      get() {
        bindingReads++;
        if (bindingReads > budget)
          throw new Error(
            "Exact feedback binding exceeded a linear lookup budget",
          );
        return original;
      },
    });
  }
  const model = buildWeeklyReview(fixture);
  assert.ok(bindingReads > 0);
  assert.ok(bindingReads <= budget);
  assert.equal(
    model.summaries.find((row) => row.skill === "writing")!.causes[0].count,
    112,
  );
  assert.equal(
    model.summaries.find((row) => row.skill === "speaking")!.causes[0].count,
    112,
  );
});

test("revision lookup keeps exact IDs, input hashes, trust priority, cutoff boundaries and candidate order", () => {
  const fixture = historyFixture(),
    current = fixture.records.find((row) => row.id === "scale-d338-essay0")!;
  const originalFeedback = fixture.records.find(
    (row) => row.id === "scale-d338-feedback0",
  )!;
  const changed: Revision[] = [];
  const clone = (
    original: Revision,
    id: string,
    patch: LearningPayload,
    offset: number,
  ): Revision => {
    const payload = { ...original.payload, ...patch };
    return {
      ...original,
      id,
      revisionId: `c6000000-0000-4000-8000-${String(offset).padStart(12, "0")}`,
      createdAt: 20000 + offset,
      seq: 20000 + offset,
      payload,
      contentHash: createHash("sha256")
        .update(
          original.kind === "essay"
            ? String(payload.text)
            : original.kind === "speaking"
              ? String(payload.transcript)
              : canonical(payload),
        )
        .digest("hex"),
    };
  };
  // Malformed duplicate revision IDs must not let a Map's last-write overwrite a different exact work.
  const duplicateRevision = clone(
    current,
    "different-work-same-revision",
    { text: "A different self-authored original." },
    1,
  );
  duplicateRevision.revisionId = current.revisionId;
  changed.push(duplicateRevision);
  changed.push(
    clone(
      originalFeedback,
      "scale-human-priority",
      { source: "human", errorCauses: ["coherence"] },
      2,
    ),
  );
  changed.push(
    clone(
      originalFeedback,
      "scale-newer-self",
      { source: "self", errorCauses: ["lexical-misuse"] },
      3,
    ),
  );
  changed.push(
    clone(
      originalFeedback,
      "scale-wrong-hash",
      {
        source: "human",
        inputHash: "e".repeat(64),
        errorCauses: ["task-response"],
      },
      4,
    ),
  );
  changed.push(
    clone(
      originalFeedback,
      "scale-wrong-id",
      {
        source: "human",
        workId: "absent-work",
        errorCauses: ["task-response"],
      },
      5,
    ),
  );
  const result = buildWeeklyReview({
    ...fixture,
    records: [...fixture.records, ...changed],
  });
  const causes = result.summaries.find(
    (row) => row.skill === "writing",
  )!.causes;
  assert.equal(causes.find((row) => row.errorCause === "grammar")?.count, 111);
  assert.equal(causes.find((row) => row.errorCause === "coherence")?.count, 1);
  assert.equal(
    causes.some((row) =>
      ["lexical-misuse", "task-response"].includes(row.errorCause),
    ),
    false,
  );
  assert.deepEqual(
    causes.find((row) => row.errorCause === "coherence")!.recordIds,
    ["scale-human-priority", current.id],
  );
});
