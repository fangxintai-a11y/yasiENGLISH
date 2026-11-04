import { useEffect, useRef, useState } from "react";
import type { Revision } from "../../protocol";
import { deviceId, getLearningState } from "../../repository";
import {
  measuredPreparation,
  newSpeakingTiming,
  speakingDraftFromRevision,
  speakingTimingStatus,
  startPracticeTimer,
  stopPracticeTimer,
  type SpeakingDraft,
} from "../../speakingModel";
import {
  recordingDeviceLabel,
  startSpeakingRecording,
  type SpeakingCapture,
} from "../../speakingRecording";
import {
  saveSpeakingAttempt,
  SpeakingSaveError,
  type PendingSpeakingRecording,
} from "../../speakingWorks";
export interface SpeakingAnswerOptions {
  seed: SpeakingDraft;
  initialWork?: Revision;
  userId: string | null;
  onSaved: (work: Revision, seconds: number, isNew: boolean) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}
interface PendingTake extends PendingSpeakingRecording {
  stored: boolean;
  estimated: boolean;
  practiceSeconds: number;
}
export function useSpeakingAnswer({
  seed,
  initialWork,
  userId,
  onSaved,
  onDirty,
}: SpeakingAnswerOptions) {
  const [draft, setDraft] = useState(seed),
    [work, setWork] = useState(initialWork),
    [timing, setTiming] = useState(newSpeakingTiming),
    [notes, setNotes] = useState(""),
    [now, setNow] = useState(Date.now),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [captureState, setCaptureState] = useState<
      "idle" | "requesting" | "recording" | "stopping"
    >("idle"),
    [pending, setPending] = useState<PendingTake | null>(null),
    [micFailed, setMicFailed] = useState(false),
    [estimated, setEstimated] = useState(false);
  const alive = useRef(true),
    draftRef = useRef(draft),
    timingRef = useRef(timing),
    capture = useRef<SpeakingCapture | null>(null),
    pendingRef = useRef(pending),
    workRef = useRef(work),
    saving = useRef(false),
    epoch = useRef(0);
  draftRef.current = draft;
  timingRef.current = timing;
  pendingRef.current = pending;
  workRef.current = work;
  const sameAccount = () => getLearningState().userId === userId;
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => {
      alive.current = false;
      epoch.current++;
      window.clearInterval(timer);
      capture.current?.close();
      capture.current = null;
    };
  }, [userId]);
  useEffect(() => {
    if (!initialWork || initialWork.revisionId === work?.revisionId) return;
    if (
      !work ||
      draftRef.current.transcript === String(work.payload.transcript ?? "")
    ) {
      setWork(initialWork);
      setDraft(speakingDraftFromRevision(initialWork));
    } else setMessage("云端有新修订，当前未保存的转写已保留。");
  }, [initialWork?.revisionId]);
  const dirty =
    busy ||
    captureState !== "idle" ||
    (work
      ? draft.transcript !== String(work.payload.transcript ?? "")
      : !!draft.transcript.trim() ||
        !!notes.trim() ||
        timing.prep.runningSince !== null ||
        timing.answer.runningSince !== null ||
        timing.prep.elapsedSeconds > 0 ||
        timing.answer.elapsedSeconds > 0 ||
        pending !== null);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty]);
  const status = speakingTimingStatus(draft.part, timing, now);
  const prepare = () => {
    setTiming((value) => ({ ...value, prep: startPracticeTimer(value.prep) }));
    setDraft((value) => ({
      ...value,
      conditions: { ...value.conditions, timed: true },
    }));
  };
  const startManual = () => {
    const at = Date.now();
    setTiming((value) => ({
      prep: stopPracticeTimer(value.prep, at),
      answer: startPracticeTimer(value.answer, at),
    }));
    setDraft((value) => ({
      ...value,
      conditions: { ...value.conditions, timed: true },
    }));
    setNow(at);
  };
  const stopManual = () => {
    const at = Date.now();
    setTiming((value) => ({
      prep: stopPracticeTimer(value.prep, at),
      answer: stopPracticeTimer(value.answer, at),
    }));
    setNow(at);
  };
  const persist = async (recording?: PendingTake, onlyText = false) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      const at = Date.now(),
        current = draftRef.current,
        measured = speakingTimingStatus(current.part, timingRef.current, at),
        isNew = current.baseRevision === null;
      let next = work
        ? current
        : {
            ...current,
            prepSeconds: measuredPreparation(
              current.part,
              timingRef.current,
              at,
            ),
            durationSeconds:
              recording?.durationSeconds ?? measured.answerSeconds,
          };
      if (onlyText)
        next = {
          ...next,
          recordingId: null,
          recordingStatus: "none",
          recordingDevice: null,
        };
      const result = await saveSpeakingAttempt(next, {
        expectedUserId: userId,
        ...(recording && !onlyText ? { recording } : {}),
      });
      if (!alive.current || !sameAccount()) return;
      setTiming((value) => ({
        prep: stopPracticeTimer(value.prep, at),
        answer: stopPracticeTimer(value.answer, at),
      }));
      setDraft(result.draft);
      setWork(result.work);
      setPending(null);
      if (recording) setEstimated(recording.estimated);
      try {
        await onSaved(
          result.work,
          isNew ? (recording?.practiceSeconds ?? measured.actualSeconds) : 0,
          isNew,
        );
        if (alive.current) setMessage("作答已保存在本机，联网后同步文字记录。");
      } catch (error) {
        if (alive.current)
          setMessage(
            `作答已保存；任务用时未更新：${error instanceof Error ? error.message : "请重试。"}`,
          );
      }
    } catch (error) {
      if (alive.current) {
        if (recording && error instanceof SpeakingSaveError)
          setPending({ ...recording, stored: error.recordingSaved });
        setMessage(
          error instanceof SpeakingSaveError
            ? error.message
            : `${recording ? "录音/作答" : "作答"}未保存：${error instanceof Error ? error.message : "请重试，转写仍保留。"}`,
        );
      }
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const beginRecord = async () => {
    if (capture.current || busy || work) return;
    const ticket = ++epoch.current;
    setCaptureState("requesting");
    setBusy(true);
    setMessage("");
    try {
      const opened = await startSpeakingRecording();
      if (!alive.current || ticket !== epoch.current || !sameAccount()) {
        opened.close();
        return;
      }
      capture.current = opened;
      setMicFailed(false);
      setPending(null);
      startManual();
      setCaptureState("recording");
    } catch {
      if (alive.current) {
        setMicFailed(true);
        setCaptureState("idle");
        setMessage("麦克风不可用或权限被拒绝，可以仅计时作答并保存转写。");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const endRecord = async () => {
    const opened = capture.current;
    if (!opened) return;
    capture.current = null;
    const ticket = epoch.current,
      at = Date.now(),
      practice = speakingTimingStatus(
        draftRef.current.part,
        timingRef.current,
        at,
      ).actualSeconds;
    stopManual();
    setCaptureState("stopping");
    setBusy(true);
    try {
      const audio = await opened.stop();
      if (!alive.current || ticket !== epoch.current || !sameAccount()) return;
      const next: PendingTake = {
        id: crypto.randomUUID(),
        blob: audio.blob,
        durationSeconds: audio.durationSeconds,
        device: recordingDeviceLabel(deviceId()),
        estimated: audio.estimated,
        stored: false,
        practiceSeconds: practice,
      };
      setPending(next);
      pendingRef.current = next;
      await persist(next);
    } catch (error) {
      if (alive.current) {
        setMicFailed(true);
        setMessage(
          `录音未保存：${error instanceof Error ? error.message : "请重试或只保存转写。"}`,
        );
      }
    } finally {
      opened.close();
      if (alive.current) {
        setCaptureState("idle");
        setBusy(false);
      }
    }
  };
  const currentWork = () => {
    const saved = workRef.current,
      current = draftRef.current;
    if (
      !alive.current ||
      !sameAccount() ||
      !saved ||
      current.baseRevision !== saved.revisionId ||
      current.recordId !== saved.id ||
      current.transcript !== String(saved.payload.transcript ?? "") ||
      current.prompt !== String(saved.payload.prompt ?? "") ||
      current.part !== saved.payload.part
    )
      return null;
    return (
      getLearningState().records.find(
        (record) =>
          record.kind === "speaking" &&
          record.id === saved.id &&
          record.revisionId === saved.revisionId &&
          !record.deleted &&
          !record.conflict,
      ) ?? null
    );
  };
  return {
    draft,
    setDraft,
    work,
    timing,
    notes,
    setNotes,
    now,
    busy,
    message,
    status,
    dirty,
    captureState,
    pending,
    micFailed,
    estimated,
    currentWork,
    prepare,
    startManual,
    stopManual,
    beginRecord,
    endRecord,
    save: () => persist(pendingRef.current ?? undefined),
    onlyTranscript: () => persist(pendingRef.current ?? undefined, true),
  };
}
