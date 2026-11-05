import { useEffect, useRef, useState } from "react";
import { resolveLocalAudio } from "../../localBank";
import type { ListeningPlayerProps } from "./ListeningPlayer";
import {
  evidencePlaybackStart,
  firstSeekTarget,
  type ListeningConditions,
} from "../../listeningPlayback";
import {
  LISTENING_SEQUENCE_REPLAY_EVENT,
  restoreListeningSequence,
  sequenceCheckRemaining,
  sequenceConditions,
  sequencePlaybackKey,
  sequenceReady,
  transitionListeningSequence,
  type ListeningSequence,
  type ListeningSequenceEvent,
  type ListeningSequenceState,
} from "../../listeningSequence";

const consumed = new Set<string>();
export function clearListeningSequencePending(
  userId: string | null,
  material: { id: string; contentHash: string },
) {
  const key = sequencePlaybackKey({
    userId,
    materialId: material.id,
    contentHash: material.contentHash,
  });
  consumed.add(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* The successful attempt remains saved. */
  }
}
export interface ListeningSequencePlayerProps extends Omit<
  ListeningPlayerProps,
  "onConditions"
> {
  sequence: ListeningSequence;
  onConditions: (
    conditions: ListeningConditions & { sequential: true },
  ) => void;
}
export function ListeningSequencePlayer(props: ListeningSequencePlayerProps) {
  const identity = {
    userId: props.userId,
    materialId: props.material.id,
    contentHash: props.material.contentHash,
  };
  return <SequencePlayback key={sequencePlaybackKey(identity)} {...props} />;
}
function SequencePlayback({
  userId,
  material,
  sequence,
  review,
  evidenceVisible = false,
  onConditions,
  onReady,
}: ListeningSequencePlayerProps) {
  const key = sequencePlaybackKey({
    userId,
    materialId: material.id,
    contentHash: material.contentHash,
  });
  const compatible =
    material.id === sequence.material.id &&
    material.contentHash === sequence.material.contentHash;
  const [state, setState] = useState<ListeningSequenceState>(() => {
    let saved: unknown;
    try {
      if (!review && !consumed.has(key))
        saved = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      /* Fresh state. */
    }
    const initial = restoreListeningSequence(
      saved,
      userId,
      sequence,
      Date.now(),
    );
    return review
      ? transitionListeningSequence(initial, { type: "review" }, Date.now())
      : initial;
  });
  const [resource, setResource] = useState<{ key: string; url: string } | null>(
      null,
    ),
    [metadataKey, setMetadataKey] = useState(""),
    [now, setNow] = useState(Date.now),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [retry, setRetry] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null),
    stateRef = useRef(state),
    alive = useRef(true),
    reviewRef = useRef(review),
    evidenceRef = useRef(evidenceVisible),
    conditionsRef = useRef(onConditions),
    readyRef = useRef(onReady),
    internalSeek = useRef<number | null>(null),
    pendingEvidence = useRef<{ partIndex: number; seconds: number } | null>(
      null,
    ),
    playPending = useRef(false);
  stateRef.current = state;
  reviewRef.current = review;
  evidenceRef.current = evidenceVisible;
  conditionsRef.current = onConditions;
  readyRef.current = onReady;
  const current = sequence.parts[state.partIndex],
    partKey = `${key}:part-${state.partIndex + 1}:${current.contentHash}`,
    url = resource?.key === partKey ? resource.url : null,
    metadataReady = metadataKey === partKey;
  const send = (event: ListeningSequenceEvent) => {
    const next = transitionListeningSequence(
      stateRef.current,
      event,
      Date.now(),
    );
    if (next !== stateRef.current) {
      stateRef.current = next;
      if (alive.current) setState(next);
    }
    return next;
  };
  const persist = () => {
    if (
      reviewRef.current ||
      consumed.has(key) ||
      stateRef.current.phase === "idle"
    )
      return;
    try {
      localStorage.setItem(key, JSON.stringify(stateRef.current));
    } catch {
      if (alive.current)
        setNotice("四节播放进度暂时无法写入本机，请保留本页完成后提交。");
    }
  };
  const checkpoint = () => {
    const element = audio.current;
    if (element && !element.seeking && stateRef.current.phase === "playing")
      send({ type: "progress", seconds: element.currentTime });
    persist();
  };
  const move = (seconds: number) => {
    const element = audio.current;
    if (!element || Math.abs(element.currentTime - seconds) <= 0.05) return;
    internalSeek.current = seconds;
    element.currentTime = seconds;
  };
  const play = async () => {
    const element = audio.current;
    if (!element || playPending.current) return;
    playPending.current = true;
    try {
      await element.play();
    } catch {
      send({ type: "blocked" });
      if (alive.current)
        setError("音频未能开始，请点击继续播放；不会跳过本节或提前检查。");
    } finally {
      playPending.current = false;
    }
  };
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      send({ type: "tick" });
      checkpoint();
    }, 250);
    const visibility = () => {
      if (document.visibilityState === "hidden") checkpoint();
    };
    window.addEventListener("pagehide", checkpoint);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      checkpoint();
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", checkpoint);
      document.removeEventListener("visibilitychange", visibility);
      audio.current?.pause();
    };
  }, []);
  useEffect(() => {
    let active = true,
      release: (() => void) | undefined;
    setMetadataKey("");
    setError("");
    internalSeek.current = null;
    if (!compatible) {
      readyRef.current(false);
      setError("整套与四节原件版本不一致，请重新导入同版材料。");
      return;
    }
    void resolveLocalAudio(userId, current).then(
      (value) => {
        if (!active) {
          value.release();
          return;
        }
        release = value.release;
        setResource({ key: partKey, url: value.url });
      },
      () => {
        if (active)
          setError(
            `本机第${state.partIndex + 1}节音频暂不可用，原答案和播放位置已保留。`,
          );
      },
    );
    return () => {
      active = false;
      audio.current?.pause();
      release?.();
    };
  }, [partKey, retry]);
  useEffect(() => {
    persist();
  }, [state]);
  const conditions = sequenceConditions(state);
  useEffect(() => {
    conditionsRef.current(conditions);
  }, [conditions.replayed, conditions.replays, conditions.transcriptViewed]);
  const ready = compatible && (review || sequenceReady(state, now));
  useEffect(() => {
    readyRef.current(ready);
  }, [ready]);
  useEffect(() => {
    if (review && stateRef.current.phase !== "review") send({ type: "review" });
  }, [review]);
  useEffect(() => {
    if (review && evidenceVisible) send({ type: "transcript" });
  }, [review, evidenceVisible, state.partIndex]);
  useEffect(() => {
    if (state.phase === "loading" && url && metadataReady) void play();
  }, [state.phase, url, metadataReady, partKey]);
  const seekEvidence = (questionId: string, requested?: number) => {
    if (!reviewRef.current || !evidenceRef.current) return;
    const origin = sequence.questionOrigins[questionId];
    if (!origin) return;
    const seconds = Math.max(
      0,
      Math.min(
        requested ?? evidencePlaybackStart(origin.startSeconds ?? 0),
        sequence.parts[origin.partIndex].audio!.durationSeconds,
      ),
    );
    pendingEvidence.current = { partIndex: origin.partIndex, seconds };
    if (stateRef.current.partIndex === origin.partIndex && metadataReady) {
      move(seconds);
      pendingEvidence.current = null;
      void play();
    } else send({ type: "select", index: origin.partIndex });
  };
  useEffect(() => {
    const replay = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        detail?.materialId === material.id &&
        detail.contentHash === material.contentHash &&
        typeof detail.questionId === "string"
      )
        seekEvidence(
          detail.questionId,
          typeof detail.seconds === "number" && Number.isFinite(detail.seconds)
            ? detail.seconds
            : undefined,
        );
    };
    window.addEventListener(LISTENING_SEQUENCE_REPLAY_EVENT, replay);
    return () =>
      window.removeEventListener(LISTENING_SEQUENCE_REPLAY_EVENT, replay);
  }, [partKey, metadataReady]);
  const begin = () => {
    if (
      !compatible ||
      !url ||
      !metadataReady ||
      !["idle", "paused"].includes(stateRef.current.phase)
    )
      return;
    if (stateRef.current.phase === "idle") consumed.delete(key);
    setError("");
    const next = send({ type: "start" });
    if (next.phase === "loading") {
      move(next.parts[next.partIndex].positionSeconds);
      void play();
    }
  };
  const index = state.partIndex,
    previewRemaining =
      state.phase === "preview" && state.previewEndsAt !== null
        ? Math.max(0, Math.ceil((state.previewEndsAt - now) / 1000))
        : 0;
  return (
    <section
      className="panel"
      aria-label="四节听力连播"
      data-testid="listening-sequence-player"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h3>
        {sequence.material.examId} · 第{index + 1}/4节（题{index * 10 + 1}–
        {(index + 1) * 10}）
      </h3>
      <p>
        四节按原顺序播放，不合成或改动音频。原音轨中的说明、看题及检查停顿全部保留，默认不再叠加固定30秒；四节结束后统一检查120秒。
      </p>
      <audio
        key={partKey}
        ref={audio}
        src={url ?? undefined}
        controls={review}
        preload="auto"
        aria-label={`第${index + 1}节听力音频`}
        data-testid="listening-sequence-audio"
        style={{ width: "100%", maxWidth: "100%" }}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          if (!Number.isFinite(element.duration) || element.duration <= 0) {
            setError("本节音频时长不可用，未开放提交。");
            return;
          }
          send({
            type: "metadata",
            seconds: element.duration,
            partIndex: index,
          });
          setMetadataKey(partKey);
          const pending = pendingEvidence.current;
          if (reviewRef.current && pending?.partIndex === index) {
            move(pending.seconds);
            pendingEvidence.current = null;
            void play();
          } else move(stateRef.current.parts[index].positionSeconds);
        }}
        onTimeUpdate={(event) => {
          if (!event.currentTarget.seeking)
            send({
              type: "progress",
              seconds: event.currentTarget.currentTime,
              partIndex: index,
            });
        }}
        onSeeking={(event) => {
          if (reviewRef.current) return;
          const requested = event.currentTarget.currentTime;
          if (
            internalSeek.current !== null &&
            Math.abs(requested - internalSeek.current) <= 0.25
          )
            return;
          move(firstSeekTarget(stateRef.current.parts[index], requested));
          setNotice("首答不能拖动或回放，继续从本节已播位置作答。");
        }}
        onSeeked={() => {
          internalSeek.current = null;
        }}
        onPlay={(event) => {
          if (
            !reviewRef.current &&
            !["idle", "loading", "paused", "playing"].includes(
              stateRef.current.phase,
            )
          ) {
            event.currentTarget.pause();
            return;
          }
          send({ type: "play", partIndex: index });
        }}
        onPause={(event) => {
          if (!event.currentTarget.ended) {
            send({
              type: "progress",
              seconds: event.currentTarget.currentTime,
              partIndex: index,
            });
            send({ type: "pause", partIndex: index });
          }
        }}
        onEnded={(event) => {
          if (
            !event.currentTarget.ended ||
            !Number.isFinite(event.currentTarget.duration) ||
            event.currentTarget.currentTime <
              event.currentTarget.duration - 0.25
          )
            return;
          send({
            type: "progress",
            seconds: event.currentTarget.currentTime,
            partIndex: index,
          });
          send({ type: "ended", partIndex: index });
          persist();
        }}
        onError={() => {
          internalSeek.current = null;
          send({ type: "pause", partIndex: index });
          setError(
            "本节音频读取失败，播放位置与原答案保留；未听完四节不会提前开放提交。",
          );
        }}
      />
      {!url && !error && <p role="status">正在准备第{index + 1}节本机音频…</p>}
      {!review && (
        <>
          <button
            className="btn btn-primary"
            disabled={
              !compatible ||
              !url ||
              !metadataReady ||
              !["idle", "paused"].includes(state.phase)
            }
            onClick={begin}
          >
            {state.phase === "idle" ? "开始四节连续播放" : "继续四节播放"}
          </button>
          {state.phase === "preview" && (
            <p role="timer" aria-label="本节额外看题倒计时">
              本节明确额外看题剩余 {previewRemaining}{" "}
              秒（原音频无此停顿时才设置）。
            </p>
          )}
          {state.phase === "loading" && (
            <p role="status">正在切换下一节原音频…</p>
          )}
          {state.phase === "playing" && (
            <p role="status">
              首答连续播放中 · 本节已播
              {Math.floor(state.parts[index].positionSeconds)}秒
            </p>
          )}
          {state.phase === "paused" && (
            <p role="status">
              已保留第{index + 1}节
              {Math.floor(state.parts[index].positionSeconds)}
              秒，继续时不从头重放。
            </p>
          )}
          {state.phase === "checking" && (
            <p role="timer" aria-label="整套听力检查倒计时">
              整套检查剩余 {sequenceCheckRemaining(state, now)} 秒
            </p>
          )}
          {ready && (
            <p role="status">四节与统一检查已完成，可以提交整套首答。</p>
          )}
        </>
      )}
      {review && (
        <>
          <p>复盘可按节自由回听；A轮不显示标准答案或原文证据。</p>
          <label
            className="field"
            style={{
              display: "block",
              width: "100%",
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            <span>回听分节</span>
            <select
              aria-label="回听分节"
              value={index}
              onChange={(event) => {
                pendingEvidence.current = null;
                send({ type: "select", index: Number(event.target.value) });
              }}
              style={{ width: "100%", minWidth: 0 }}
            >
              {sequence.parts.map((part, at) => (
                <option key={`${part.id}:${part.contentHash}`} value={at}>
                  第{at + 1}节 · {part.source.sourceRef}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {review && evidenceVisible && (
        <div aria-label="整套听力证据回听">
          {material.questions.flatMap((question) =>
            typeof sequence.questionOrigins[question.id]?.startSeconds ===
            "number"
              ? [
                  <button
                    className="btn btn-ghost"
                    key={question.id}
                    onClick={() => seekEvidence(question.id)}
                  >
                    重听第{question.number ?? question.id}题证据
                  </button>,
                ]
              : [],
          )}
        </div>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            className="btn btn-ghost"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试读取第{index + 1}节
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
