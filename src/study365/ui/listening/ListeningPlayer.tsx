import { useEffect, useRef, useState } from "react";
import { resolveLocalAudio } from "../../localBank";
import type { LocalMaterial } from "../../localBankSchema";
import {
  checkSecondsRemaining,
  evidencePlaybackStart,
  firstSeekTarget,
  listeningPlaybackKey,
  listeningReady,
  playbackConditions,
  restoreListeningPlayback,
  transitionListeningPlayback,
  type ListeningConditions,
  type ListeningIdentity,
  type ListeningPlaybackEvent,
  type ListeningPlaybackState,
} from "../../listeningPlayback";

const consumed = new Set<string>();
const identityOf = (
  userId: string | null,
  material: Pick<LocalMaterial, "id" | "contentHash">,
): ListeningIdentity => ({
  userId,
  materialId: material.id,
  contentHash: material.contentHash,
});

/** Call only after the attempt commit succeeds; failed submissions keep progress. */
export function clearListeningPending(
  userId: string | null,
  material: Pick<LocalMaterial, "id" | "contentHash">,
): void {
  const key = listeningPlaybackKey(identityOf(userId, material));
  consumed.add(key);
  try {
    localStorage.removeItem(key);
  } catch {
    /* Inaccessible storage cannot supply a stale restore either. */
  }
}

export interface ListeningPlayerProps {
  userId: string | null;
  material: LocalMaterial;
  review: boolean;
  evidenceVisible?: boolean;
  onConditions: (conditions: ListeningConditions) => void;
  onReady: (ready: boolean) => void;
}
export function ListeningPlayer(props: ListeningPlayerProps) {
  const identity = identityOf(props.userId, props.material);
  return (
    <Playback
      key={listeningPlaybackKey(identity)}
      {...props}
      identity={identity}
    />
  );
}
function Playback({
  userId,
  material,
  identity,
  review,
  evidenceVisible = false,
  onConditions,
  onReady,
}: ListeningPlayerProps & { identity: ListeningIdentity }) {
  const key = listeningPlaybackKey(identity),
    declaredDuration =
      material.skill === "listening"
        ? (material.audio?.durationSeconds ?? 0)
        : 0;
  const [state, setState] = useState<ListeningPlaybackState>(() => {
    let saved: unknown;
    try {
      if (!review && !consumed.has(key))
        saved = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      /* Fresh state remains available. */
    }
    const initial = restoreListeningPlayback(
      saved,
      identity,
      declaredDuration,
      Date.now(),
    );
    return review
      ? transitionListeningPlayback(initial, { type: "review" }, Date.now())
      : initial;
  });
  const [url, setUrl] = useState<string | null>(null),
    [metadataReady, setMetadataReady] = useState(false);
  const [now, setNow] = useState(Date.now),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null),
    stateRef = useRef(state),
    alive = useRef(true);
  const reviewRef = useRef(review),
    conditionsRef = useRef(onConditions),
    readyRef = useRef(onReady),
    internalSeek = useRef<number | null>(null);
  stateRef.current = state;
  reviewRef.current = review;
  conditionsRef.current = onConditions;
  readyRef.current = onReady;
  const send = (event: ListeningPlaybackEvent) => {
    const next = transitionListeningPlayback(
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
        setNotice("播放进度未能写入本机。请保留当前页面，完成后再提交。");
    }
  };
  const checkpoint = () => {
    const element = audio.current;
    if (element && !element.seeking && stateRef.current.phase === "playing")
      send({ type: "progress", seconds: element.currentTime });
    persist();
  };
  const moveAudio = (seconds: number) => {
    const element = audio.current;
    if (!element || Math.abs(element.currentTime - seconds) <= 0.05) return;
    internalSeek.current = seconds;
    element.currentTime = seconds;
  };
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      send({ type: "tick" });
    }, 250);
    const hidden = () => {
      if (document.visibilityState === "hidden") checkpoint();
    };
    window.addEventListener("pagehide", checkpoint);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      checkpoint();
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", checkpoint);
      document.removeEventListener("visibilitychange", hidden);
      audio.current?.pause();
    };
  }, []);
  useEffect(() => {
    let active = true,
      release: (() => void) | undefined;
    void resolveLocalAudio(userId, material).then(
      (resource) => {
        if (!active) {
          resource.release();
          return;
        }
        release = resource.release;
        setUrl(resource.url);
        setError("");
      },
      () => {
        if (active)
          setError("本机音频暂不可用，请检查题库包后重试。原答案仍保留。");
      },
    );
    return () => {
      active = false;
      audio.current?.pause();
      release?.();
    };
  }, [key]);
  useEffect(() => {
    persist();
  }, [state]);
  useEffect(() => {
    conditionsRef.current(playbackConditions(state));
  }, [state.replayed, state.replays, state.transcriptViewed]);
  const ready = review || listeningReady(state, now);
  useEffect(() => {
    readyRef.current(ready);
  }, [ready]);
  useEffect(() => {
    if (review) {
      clearListeningPending(userId, material);
      send({ type: "review" });
    }
  }, [review]);
  useEffect(() => {
    if (review && evidenceVisible) send({ type: "transcript" });
  }, [review, evidenceVisible]);
  const begin = async () => {
    const element = audio.current;
    if (
      !element ||
      !metadataReady ||
      !["idle", "paused"].includes(stateRef.current.phase)
    )
      return;
    setError("");
    if (stateRef.current.phase === "idle") consumed.delete(key);
    moveAudio(stateRef.current.positionSeconds);
    try {
      await element.play();
    } catch {
      if (alive.current)
        setError("音频尚未开始播放，请点继续播放重试。检查计时不会提前开始。");
    }
  };
  const seekEvidence = async (startSeconds: number) => {
    if (!reviewRef.current || !evidenceVisible || !audio.current) return;
    moveAudio(evidencePlaybackStart(startSeconds));
    try {
      await audio.current.play();
    } catch {
      if (alive.current) setError("未能开始回听，请使用音频播放按钮重试。");
    }
  };
  const remaining = checkSecondsRemaining(state, now);
  return (
    <section
      className="panel"
      aria-label="听力播放"
      data-testid="listening-player"
    >
      <audio
        ref={audio}
        src={url ?? undefined}
        preload="auto"
        controls={review}
        aria-label="听力音频"
        data-testid="listening-audio"
        style={{ width: "100%", maxWidth: "100%" }}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          if (Number.isFinite(element.duration) && element.duration > 0)
            send({ type: "metadata", seconds: element.duration });
          setMetadataReady(true);
          if (!reviewRef.current) moveAudio(stateRef.current.positionSeconds);
        }}
        onTimeUpdate={(event) => {
          if (!event.currentTarget.seeking)
            send({
              type: "progress",
              seconds: event.currentTarget.currentTime,
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
          moveAudio(firstSeekTarget(stateRef.current, requested));
          setNotice("首答期间不能拖动或回放，继续从当前已播位置作答。");
        }}
        onSeeked={() => {
          internalSeek.current = null;
        }}
        onPlay={(event) => {
          if (
            !reviewRef.current &&
            ["checking", "ready"].includes(stateRef.current.phase)
          ) {
            event.currentTarget.pause();
            return;
          }
          send({ type: "play" });
        }}
        onPause={(event) => {
          if (!event.currentTarget.ended) send({ type: "pause" });
        }}
        onEnded={() => {
          send({ type: "ended" });
          checkpoint();
        }}
        onError={() => {
          internalSeek.current = null;
          setError(
            "音频读取失败，请检查本机题库。未完成播放时不能提前提交首答。",
          );
        }}
      />
      {!url && !error && <p role="status">正在读取本机音频…</p>}
      {!review && (
        <>
          <p>首答只播放一遍，不能拖动或回放。音频结束后有60秒检查答案。</p>
          <button
            className="btn btn-primary"
            disabled={
              !url ||
              !metadataReady ||
              !["idle", "paused"].includes(state.phase)
            }
            onClick={() => {
              void begin();
            }}
          >
            {state.phase === "paused" ? "继续播放听力" : "开始播放听力"}
          </button>
          {state.phase === "playing" && (
            <p role="status">
              首答播放中 · 已播放 {Math.floor(state.positionSeconds)} 秒
            </p>
          )}
          {state.phase === "paused" && (
            <p role="status">
              已保留播放位置 {Math.floor(state.positionSeconds)}{" "}
              秒，继续时不会从头播放。
            </p>
          )}
          {state.phase === "checking" && (
            <p role="timer" aria-label="听力检查倒计时">
              检查剩余 {remaining} 秒
            </p>
          )}
          {ready && <p role="status">检查完成，可以提交首答。</p>}
        </>
      )}
      {review && <p>复盘阶段可以自由拖动和回听。</p>}
      {review && evidenceVisible && (
        <div aria-label="听力证据回听">
          {material.questions.flatMap((question, index) => {
            const seconds = question.evidence.startSeconds;
            return typeof seconds === "number" && Number.isFinite(seconds) ? (
              <button
                className="btn btn-ghost"
                key={question.id}
                onClick={() => {
                  void seekEvidence(seconds);
                }}
              >
                重听第{question.number ?? index + 1}题证据
              </button>
            ) : (
              []
            );
          })}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
