export interface ListeningIdentity {
  userId: string | null;
  materialId: string;
  contentHash: string;
}
export type ListeningPhase = "idle" | "playing" | "paused" | "checking" | "ready" | "review";
export interface ListeningPlaybackState extends ListeningIdentity {
  version: 1;
  phase: ListeningPhase;
  durationSeconds: number;
  positionSeconds: number;
  checkingEndsAt: number | null;
  hasPlayed: boolean;
  replayed: boolean;
  replays: number;
  transcriptViewed: boolean;
}
export interface ListeningConditions {
  replayed: boolean;
  replays: number;
  transcriptViewed: boolean;
}
export type ListeningPlaybackEvent =
  | { type: "play" | "pause" | "ended" | "tick" | "review" | "transcript" }
  | { type: "progress" | "metadata"; seconds: number };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const duration = (value: number) => finite(value) && value > 0 ? Math.min(value, 86_400) : 0;
const clampPosition = (value: number, maximum: number) => Math.max(0, Math.min(finite(value) ? value : 0, maximum));

/** A JSON tuple keeps guest/account and separator-containing IDs distinct. */
export function listeningPlaybackKey(identity: ListeningIdentity): string {
  return `band:listening-pending:v1:${JSON.stringify([identity.userId, identity.materialId, identity.contentHash])}`;
}
export function createListeningPlayback(identity: ListeningIdentity, durationSeconds: number): ListeningPlaybackState {
  return {
    ...identity, version: 1, phase: "idle", durationSeconds: duration(durationSeconds),
    positionSeconds: 0, checkingEndsAt: null, hasPlayed: false,
    replayed: false, replays: 0, transcriptViewed: false,
  };
}
export function restoreListeningPlayback(saved: unknown, identity: ListeningIdentity, durationSeconds: number, now: number): ListeningPlaybackState {
  const initial = createListeningPlayback(identity, durationSeconds);
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return initial;
  const value = saved as Record<string, unknown>;
  if (value.version !== 1 || value.userId !== identity.userId || value.materialId !== identity.materialId || value.contentHash !== identity.contentHash
    || !["idle", "playing", "paused", "checking", "ready"].includes(String(value.phase))
    || !finite(value.positionSeconds) || value.positionSeconds < 0 || value.positionSeconds > 86_400
    || !finite(value.durationSeconds) || value.durationSeconds <= 0 || value.durationSeconds > 86_400
    || typeof value.hasPlayed !== "boolean" || typeof value.replayed !== "boolean" || typeof value.transcriptViewed !== "boolean"
    || !Number.isSafeInteger(value.replays) || Number(value.replays) < 0
    || !(value.checkingEndsAt === null || (finite(value.checkingEndsAt) && value.checkingEndsAt >= 0))) return initial;
  const phase = value.phase as Exclude<ListeningPhase, "review">;
  if ((phase === "checking" || phase === "ready") && (!value.hasPlayed || value.checkingEndsAt === null)) return initial;
  if ((phase === "playing" || phase === "paused") && !value.hasPlayed) return initial;
  if (phase === "idle" && (value.hasPlayed || value.positionSeconds !== 0)) return initial;
  const resumed = phase === "playing" || phase === "paused";
  const restored: ListeningPlaybackState = {
    ...initial, phase: resumed ? "paused" : phase,
    positionSeconds: clampPosition(value.positionSeconds, initial.durationSeconds),
    checkingEndsAt: value.checkingEndsAt as number | null,
    hasPlayed: value.hasPlayed,
    replayed: value.replayed || resumed,
    replays: Number(value.replays) + (resumed ? 1 : 0),
    transcriptViewed: value.transcriptViewed,
  };
  return transitionListeningPlayback(restored, { type: "tick" }, now);
}
export function transitionListeningPlayback(state: ListeningPlaybackState, event: ListeningPlaybackEvent, now: number): ListeningPlaybackState {
  switch (event.type) {
    case "metadata": {
      const seconds = duration(event.seconds);
      return seconds > 0 ? { ...state, durationSeconds: seconds, positionSeconds: clampPosition(state.positionSeconds, seconds) } : state;
    }
    case "play":
      if (state.phase === "review") return { ...state, replayed: true, replays: state.replays + 1 };
      return state.phase === "idle" || state.phase === "paused" ? { ...state, phase: "playing", hasPlayed: true } : state;
    case "pause": return state.phase === "playing" ? { ...state, phase: "paused" } : state;
    case "progress":
      if (state.phase !== "playing" && state.phase !== "review") return state;
      return { ...state, positionSeconds: clampPosition(state.phase === "review" ? event.seconds : Math.max(state.positionSeconds, event.seconds), state.durationSeconds) };
    case "ended":
      if (!state.hasPlayed || (state.phase !== "playing" && state.phase !== "paused")) return state;
      return { ...state, phase: "checking", positionSeconds: state.durationSeconds, checkingEndsAt: now + 60_000 };
    case "tick":
      return state.phase === "checking" && state.checkingEndsAt !== null && now >= state.checkingEndsAt ? { ...state, phase: "ready" } : state;
    case "review": return { ...state, phase: "review" };
    case "transcript": return state.phase === "review" ? { ...state, transcriptViewed: true } : state;
  }
}
export function listeningReady(state: ListeningPlaybackState, now: number): boolean {
  return state.phase === "review" || state.phase === "ready" || (state.phase === "checking" && state.checkingEndsAt !== null && now >= state.checkingEndsAt);
}
export function checkSecondsRemaining(state: ListeningPlaybackState, now: number): number {
  return state.phase === "checking" && state.checkingEndsAt !== null ? Math.max(0, Math.ceil((state.checkingEndsAt - now) / 1000)) : 0;
}
/** Only review accepts a requested seek. First pass stays at its current position. */
export function firstSeekTarget(state: ListeningPlaybackState, requested: number): number {
  return state.phase === "review" ? clampPosition(requested, state.durationSeconds) : state.positionSeconds;
}
export function evidencePlaybackStart(startSeconds: number): number {
  return finite(startSeconds) ? Math.max(0, startSeconds - 5) : 0;
}
export function playbackConditions(state: ListeningPlaybackState): ListeningConditions {
  return { replayed: state.replayed, replays: state.replays, transcriptViewed: state.transcriptViewed };
}
