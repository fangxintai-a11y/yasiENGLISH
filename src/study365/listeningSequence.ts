import {
  hashLocalMaterial,
  type LocalMaterial,
  type LocalQuestion,
} from "./localBankSchema";
import {
  createListeningPlayback,
  playbackConditions,
  restoreListeningPlayback,
  transitionListeningPlayback,
  type ListeningConditions,
  type ListeningIdentity,
  type ListeningPlaybackState,
} from "./listeningPlayback";
export const SEQUENCE_CHECK_SECONDS = 120;
export const LISTENING_SEQUENCE_REPLAY_EVENT = "band:listening-sequence-replay";
export type ListeningMaterial = Extract<LocalMaterial, { skill: "listening" }>;
export interface SequenceQuestionOrigin {
  materialId: string;
  contentVersion: string;
  contentHash: string;
  questionId: string;
  partIndex: number;
  startSeconds?: number;
}
export interface ListeningSequence {
  material: ListeningMaterial;
  parts: [
    ListeningMaterial,
    ListeningMaterial,
    ListeningMaterial,
    ListeningMaterial,
  ];
  questionOrigins: Record<string, SequenceQuestionOrigin>;
  previewSeconds: [number, number, number, number];
}
export interface SequenceOptions {
  previewSeconds?: readonly number[];
}
const timing = (
  options: SequenceOptions = {},
): [number, number, number, number] => {
  const values = options.previewSeconds ?? [0, 0, 0, 0];
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isFinite(value) || value < 0 || value > 300)
  )
    throw new Error("四节看题时间须为明确的0至300秒，不额外猜测原录音停顿。");
  return [...values] as [number, number, number, number];
};
const latest = (a: ListeningMaterial, b: ListeningMaterial) =>
  b.version.localeCompare(a.version, undefined, { numeric: true }) ||
  a.id.localeCompare(b.id) ||
  a.contentHash.localeCompare(b.contentHash);
function validPart(material: ListeningMaterial) {
  const part = material.section;
  return (
    material.scope === "section" &&
    !!material.examId &&
    !!part &&
    !!material.audio?.path &&
    material.audio.durationSeconds > 0 &&
    !!material.transcript.trim() &&
    material.questions.length === 10 &&
    new Set(material.questions.map((question) => question.number)).size ===
      10 &&
    Array.from({ length: 10 }, (_, index) => (part - 1) * 10 + index + 1).every(
      (number) =>
        material.questions.some((question) => question.number === number),
    )
  );
}
/** Original preview/check pauses remain in the audio; default extra preview is zero. */
export async function deriveListeningSequences(
  bank: readonly LocalMaterial[],
  options: SequenceOptions = {},
): Promise<ListeningSequence[]> {
  const previews = timing(options),
    groups = new Map<string, ListeningMaterial[]>();
  for (const material of bank) {
    if (material.skill !== "listening" || !validPart(material)) continue;
    const key = JSON.stringify([
      material.examId,
      material.source.materialSource,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), material]);
  }
  const output: ListeningSequence[] = [],
    manifests = new Set<string>();
  for (const candidates of groups.values()) {
    if (
      new Set(candidates.map((material) => material.pool ?? "practice"))
        .size !== 1
    )
      continue;
    const versions = [
      ...new Set(candidates.map((material) => material.version)),
    ].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const selections = [
      candidates,
      ...versions.map((version) =>
        candidates.filter((material) => material.version === version),
      ),
    ];
    for (const selection of selections) {
      const parts = [1, 2, 3, 4].map(
        (section) =>
          selection
            .filter((material) => material.section === section)
            .sort(latest)[0],
      );
      if (parts.some((part) => !part)) continue;
      const ordered = parts as ListeningSequence["parts"];
      if (new Set(ordered.map((part) => part.audio!.path)).size !== 4) continue;
      const hashes = ordered.flatMap((part) =>
        part.audio!.sha256 ? [part.audio!.sha256] : [],
      );
      if (hashes.length === 4 && new Set(hashes).size !== 4) continue;
      const manifest = ordered.map((part) => ({
        id: part.id,
        version: part.version,
        contentHash: part.contentHash,
      }));
      const manifestHash = await hashLocalMaterial({
        sequenceVersion: 1,
        parts: manifest,
        previewSeconds: previews,
      });
      if (manifests.has(manifestHash)) continue;
      manifests.add(manifestHash);
      const examId = ordered[0].examId!,
        source = ordered[0].source.materialSource;
      const idStem = `sequence-${source}-${examId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
      const id =
        idStem.length <= 145
          ? idStem
          : `${idStem.slice(0, 120)}-${manifestHash.slice(0, 20)}`;
      const allIds = ordered.flatMap((part) =>
          part.questions.map((question) => question.id),
        ),
        uniqueIds = new Set(allIds).size === 40;
      const questionOrigins: ListeningSequence["questionOrigins"] = {},
        questions: LocalQuestion[] = [];
      ordered.forEach((part, partIndex) => {
        const groupIds = new Map<string, string>();
        for (const question of [...part.questions].sort(
          (a, b) => a.number! - b.number!,
        )) {
          const questionId = uniqueIds
            ? question.id
            : `sequence-q${question.number}`;
          if (question.groupId && !groupIds.has(question.groupId))
            groupIds.set(
              question.groupId,
              `sequence-p${partIndex + 1}-g${groupIds.size + 1}`,
            );
          questions.push({
            ...question,
            id: questionId,
            ...(question.groupId
              ? { groupId: groupIds.get(question.groupId)! }
              : {}),
          });
          questionOrigins[questionId] = {
            materialId: part.id,
            contentVersion: part.version,
            contentHash: part.contentHash,
            questionId: question.id,
            partIndex,
            ...(typeof question.evidence.startSeconds === "number"
              ? { startSeconds: question.evidence.startSeconds }
              : {}),
          };
        }
      });
      const body = {
        id,
        version: `sequence-v1-${manifestHash.slice(0, 24)}`,
        title: `${examId} · 四节顺序听力`,
        skill: "listening" as const,
        scope: "full" as const,
        deliveryMode: "local-import" as const,
        examId,
        pool: (ordered[0].pool ?? "practice") as "practice" | "holdout",
        source: {
          materialSource: source,
          sourceRef: examId,
          rights: "四节原件许可分别见对应本机来源记录，不改变原许可。",
          answerVerified: ordered.every((part) => part.source.answerVerified),
        },
        transcript: ordered.map((part) => part.transcript).join("\n\n"),
        questions,
        instructions: [
          "四节按原顺序播放，首答不能拖动或回放；第4节结束后统一检查120秒。",
          "原录音内已有的读题、检查和说明停顿完整保留，不额外叠加通用固定节间时间。",
        ],
        notes: [
          `四节来源清单：${JSON.stringify(manifest)}`,
          `明确额外看题秒数：${previews.join(",")}（默认0，沿用原音轨内停顿）`,
        ],
        estimatedMinutes: Math.max(
          1,
          Math.min(
            180,
            Math.ceil(
              (ordered.reduce(
                (sum, part) => sum + part.audio!.durationSeconds,
                0,
              ) +
                previews.reduce((sum, value) => sum + value, 0) +
                SEQUENCE_CHECK_SECONDS) /
                60,
            ),
          ),
        ),
      };
      const material: ListeningMaterial = {
        ...body,
        contentHash: await hashLocalMaterial(body),
      };
      output.push({
        material,
        parts: ordered,
        questionOrigins,
        previewSeconds: [...previews],
      });
    }
  }
  return output;
}
export function isListeningSequenceMaterial(material: LocalMaterial): boolean {
  return (
    material.skill === "listening" &&
    material.scope === "full" &&
    !material.audio &&
    material.id.startsWith("sequence-") &&
    material.version.startsWith("sequence-v1-")
  );
}
export async function withListeningSequences(
  bank: readonly LocalMaterial[],
  options: SequenceOptions = {},
): Promise<LocalMaterial[]> {
  const originals = bank.filter(
    (material) => !isListeningSequenceMaterial(material),
  );
  return [
    ...(await deriveListeningSequences(originals, options)).map(
      (sequence) => sequence.material,
    ),
    ...originals,
  ];
}
export type SequencePhase =
  | "idle"
  | "preview"
  | "loading"
  | "playing"
  | "paused"
  | "checking"
  | "ready"
  | "review";
export interface ListeningSequenceState extends ListeningIdentity {
  version: 1;
  phase: SequencePhase;
  partIndex: number;
  parts: ListeningPlaybackState[];
  previewSeconds: [number, number, number, number];
  previewEndsAt: number | null;
  checkingEndsAt: number | null;
}
export type ListeningSequenceEvent =
  | {
      type:
        | "start"
        | "play"
        | "pause"
        | "blocked"
        | "ended"
        | "tick"
        | "review"
        | "transcript";
      partIndex?: number;
    }
  | { type: "progress" | "metadata"; seconds: number; partIndex?: number }
  | { type: "select"; index: number };
export const sequencePlaybackKey = (identity: ListeningIdentity) =>
  `band:listening-sequence-pending:v1:${JSON.stringify([identity.userId, identity.materialId, identity.contentHash])}`;
const identityOf = (
  userId: string | null,
  sequence: ListeningSequence,
): ListeningIdentity => ({
  userId,
  materialId: sequence.material.id,
  contentHash: sequence.material.contentHash,
});
export function createListeningSequence(
  userId: string | null,
  sequence: ListeningSequence,
): ListeningSequenceState {
  const identity = identityOf(userId, sequence);
  return {
    ...identity,
    version: 1,
    phase: "idle",
    partIndex: 0,
    parts: sequence.parts.map((part, index) =>
      createListeningPlayback(
        {
          userId,
          materialId: `${sequence.material.id}:part-${index + 1}`,
          contentHash: part.contentHash,
        },
        part.audio!.durationSeconds,
      ),
    ),
    previewSeconds: [...sequence.previewSeconds],
    previewEndsAt: null,
    checkingEndsAt: null,
  };
}
const finiteTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const finished = (part: ListeningPlaybackState) =>
  part.hasPlayed &&
  ["checking", "ready"].includes(part.phase) &&
  part.positionSeconds >= part.durationSeconds - 0.25;
export function restoreListeningSequence(
  saved: unknown,
  userId: string | null,
  sequence: ListeningSequence,
  now: number,
): ListeningSequenceState {
  const initial = createListeningSequence(userId, sequence);
  if (!saved || typeof saved !== "object" || Array.isArray(saved))
    return initial;
  const value = saved as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.userId !== userId ||
    value.materialId !== initial.materialId ||
    value.contentHash !== initial.contentHash ||
    ![
      "idle",
      "preview",
      "loading",
      "playing",
      "paused",
      "checking",
      "ready",
    ].includes(String(value.phase)) ||
    !Number.isInteger(value.partIndex) ||
    Number(value.partIndex) < 0 ||
    Number(value.partIndex) > 3 ||
    !Array.isArray(value.parts) ||
    value.parts.length !== 4 ||
    JSON.stringify(value.previewSeconds) !==
      JSON.stringify(initial.previewSeconds) ||
    !(value.previewEndsAt === null || finiteTime(value.previewEndsAt)) ||
    !(value.checkingEndsAt === null || finiteTime(value.checkingEndsAt))
  )
    return initial;
  const index = Number(value.partIndex),
    parts: ListeningPlaybackState[] = [];
  for (let at = 0; at < 4; at++) {
    const raw = value.parts[at];
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.userId !== userId ||
      raw.materialId !== initial.parts[at].materialId ||
      raw.contentHash !== initial.parts[at].contentHash ||
      (at < index && !finished(raw as ListeningPlaybackState)) ||
      (at > index && (raw.phase !== "idle" || raw.hasPlayed !== false))
    )
      return initial;
    const restored = restoreListeningPlayback(
      raw,
      initial.parts[at],
      sequence.parts[at].audio!.durationSeconds,
      now,
    );
    if (raw.hasPlayed && !restored.hasPlayed) return initial;
    parts.push(restored);
  }
  const phase = value.phase as SequencePhase;
  if (
    (phase === "checking" || phase === "ready") &&
    (index !== 3 ||
      parts.some((part) => !finished(part)) ||
      value.checkingEndsAt === null)
  )
    return initial;
  if (
    (phase === "preview" &&
      (value.previewEndsAt === null || parts[index].hasPlayed)) ||
    (phase === "idle" &&
      (index !== 0 || parts.some((part) => part.hasPlayed))) ||
    ((phase === "playing" || phase === "paused") &&
      !["idle", "paused"].includes(parts[index].phase))
  )
    return initial;
  const restored: ListeningSequenceState = {
    ...initial,
    partIndex: index,
    parts,
    phase:
      phase === "playing"
        ? "paused"
        : phase === "ready" &&
            typeof value.checkingEndsAt === "number" &&
            now < value.checkingEndsAt
          ? "checking"
          : phase,
    previewEndsAt: value.previewEndsAt as number | null,
    checkingEndsAt: value.checkingEndsAt as number | null,
  };
  const rawCurrent = value.parts[index] as ListeningPlaybackState;
  if (
    restored.phase === "paused" &&
    rawCurrent.hasPlayed &&
    rawCurrent.positionSeconds >= rawCurrent.durationSeconds - 0.0001
  )
    return transitionListeningSequence(restored, { type: "ended" }, now);
  return transitionListeningSequence(restored, { type: "tick" }, now);
}
export function transitionListeningSequence(
  state: ListeningSequenceState,
  event: ListeningSequenceEvent,
  now: number,
): ListeningSequenceState {
  if (
    event.type !== "select" &&
    event.partIndex !== undefined &&
    event.partIndex !== state.partIndex
  )
    return state;
  const at = state.partIndex,
    current = state.parts[at];
  const replace = (
    part: ListeningPlaybackState,
    patch: Partial<ListeningSequenceState> = {},
  ) => ({
    ...state,
    ...patch,
    parts: state.parts.map((value, index) => (index === at ? part : value)),
  });
  switch (event.type) {
    case "start":
      if (!["idle", "paused"].includes(state.phase)) return state;
      return state.phase === "idle" && state.previewSeconds[at] > 0
        ? {
            ...state,
            phase: "preview",
            previewEndsAt: now + state.previewSeconds[at] * 1000,
          }
        : { ...state, phase: "loading", previewEndsAt: null };
    case "play":
      if (state.phase === "review")
        return replace(
          transitionListeningPlayback(current, { type: "play" }, now),
        );
      return ["loading", "paused", "idle"].includes(state.phase) &&
        !(state.phase === "idle" && state.previewSeconds[at] > 0)
        ? replace(transitionListeningPlayback(current, { type: "play" }, now), {
            phase: "playing",
          })
        : state;
    case "pause":
      return state.phase === "playing"
        ? replace(
            transitionListeningPlayback(current, { type: "pause" }, now),
            { phase: "paused" },
          )
        : state;
    case "blocked":
      return state.phase === "loading" ? { ...state, phase: "paused" } : state;
    case "metadata":
      return replace(
        transitionListeningPlayback(
          current,
          { type: "metadata", seconds: event.seconds },
          now,
        ),
      );
    case "progress":
      return state.phase === "playing" || state.phase === "review"
        ? replace(
            transitionListeningPlayback(
              current,
              { type: "progress", seconds: event.seconds },
              now,
            ),
          )
        : state;
    case "ended": {
      if (
        !["playing", "paused"].includes(state.phase) ||
        !current.hasPlayed ||
        current.positionSeconds < current.durationSeconds - 0.25
      )
        return state;
      const ended = replace(
        transitionListeningPlayback(current, { type: "ended" }, now),
      );
      if (at === 3)
        return {
          ...ended,
          phase: "checking",
          previewEndsAt: null,
          checkingEndsAt: now + SEQUENCE_CHECK_SECONDS * 1000,
        };
      const next = at + 1,
        seconds = state.previewSeconds[next];
      return {
        ...ended,
        partIndex: next,
        phase: seconds > 0 ? "preview" : "loading",
        previewEndsAt: seconds > 0 ? now + seconds * 1000 : null,
        checkingEndsAt: null,
      };
    }
    case "tick":
      if (
        state.phase === "preview" &&
        state.previewEndsAt !== null &&
        now >= state.previewEndsAt
      )
        return { ...state, phase: "loading", previewEndsAt: null };
      if (
        state.phase === "checking" &&
        state.checkingEndsAt !== null &&
        now >= state.checkingEndsAt &&
        state.parts.every(finished)
      )
        return { ...state, phase: "ready" };
      return state;
    case "review":
      return {
        ...state,
        phase: "review",
        partIndex: 0,
        parts: state.parts.map((part) =>
          transitionListeningPlayback(
            transitionListeningPlayback(part, { type: "review" }, now),
            { type: "progress", seconds: 0 },
            now,
          ),
        ),
        previewEndsAt: null,
      };
    case "transcript":
      return state.phase === "review"
        ? replace(
            transitionListeningPlayback(current, { type: "transcript" }, now),
          )
        : state;
    case "select":
      if (
        state.phase !== "review" ||
        !Number.isInteger(event.index) ||
        event.index < 0 ||
        event.index > 3
      )
        return state;
      return {
        ...state,
        partIndex: event.index,
        parts: state.parts.map((part, index) =>
          index === event.index
            ? transitionListeningPlayback(
                part,
                { type: "progress", seconds: 0 },
                now,
              )
            : part,
        ),
      };
  }
}
export function sequenceReady(
  state: ListeningSequenceState,
  now: number,
): boolean {
  return (
    state.phase === "review" ||
    ((state.phase === "ready" ||
      (state.phase === "checking" &&
        state.checkingEndsAt !== null &&
        now >= state.checkingEndsAt)) &&
      state.parts.every(finished))
  );
}
export function sequenceCheckRemaining(
  state: ListeningSequenceState,
  now: number,
) {
  return state.phase === "checking" && state.checkingEndsAt !== null
    ? Math.min(SEQUENCE_CHECK_SECONDS, Math.max(0, Math.floor((state.checkingEndsAt - now) / 1000)))
    : 0;
}
export function sequenceConditions(
  state: ListeningSequenceState,
): ListeningConditions & { sequential: true } {
  const all = state.parts.map(playbackConditions);
  return {
    sequential: true,
    replayed: all.some((part) => part.replayed),
    replays: all.reduce((sum, part) => sum + part.replays, 0),
    transcriptViewed: all.some((part) => part.transcriptViewed),
  };
}
