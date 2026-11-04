import { useEffect, useRef, useState } from "react";
import type { Revision } from "../../protocol";
import {
  newSpeakingTiming,
  measuredPreparation,
  speakingDraftFromRevision,
  speakingTimingStatus,
  startPracticeTimer,
  stopPracticeTimer,
  type SpeakingDraft,
} from "../../speakingModel";
import {
  availableSpeakingMaterials,
  type SpeakingContext,
} from "../../speakingTasks";
import { saveSpeakingAttempt } from "../../speakingWorks";
export function SpeakingQuestionEditor({
  context,
  seed,
  initialWork,
  userId,
  onSaved,
  onDirty,
}: {
  plan: Revision;
  context: SpeakingContext;
  seed: SpeakingDraft;
  initialWork?: Revision;
  userId: string | null;
  onSaved: (work: Revision, seconds: number, isNew: boolean) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(seed),
    [work, setWork] = useState(initialWork),
    [timing, setTiming] = useState(newSpeakingTiming),
    [notes, setNotes] = useState(""),
    [now, setNow] = useState(Date.now),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const material = availableSpeakingMaterials(context.day).find(
    (value) =>
      value.id === draft.contentId && value.version === draft.contentVersion,
  );
  const [source, setSource] = useState<"builtin" | "external" | "custom">(
    material
      ? "builtin"
      : draft.sourceRef
        ? "external"
        : draft.contentId?.startsWith("custom-")
          ? "custom"
          : "external",
  );
  const alive = useRef(true),
    draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    alive.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, []);
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
  const dirty = work
    ? draft.transcript !== String(work.payload.transcript ?? "")
    : !!draft.transcript.trim() ||
      !!notes.trim() ||
      timing.prep.runningSince !== null ||
      timing.answer.runningSince !== null ||
      timing.prep.elapsedSeconds > 0 ||
      timing.answer.elapsedSeconds > 0;
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
  const start = () => {
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
  const stop = () => {
    const at = Date.now();
    setTiming((value) => ({
      prep: stopPracticeTimer(value.prep, at),
      answer: stopPracticeTimer(value.answer, at),
    }));
    setNow(at);
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const at = Date.now(),
        measured = speakingTimingStatus(draft.part, timing, at),
        isNew = draft.baseRevision === null;
      const next = work
        ? draft
        : {
            ...draft,
            prepSeconds: measuredPreparation(draft.part, timing, at),
            durationSeconds: measured.answerSeconds,
          };
      const result = await saveSpeakingAttempt(next, {
        expectedUserId: userId,
      });
      if (!alive.current) return;
      setTiming((value) => ({
        prep: stopPracticeTimer(value.prep, at),
        answer: stopPracticeTimer(value.answer, at),
      }));
      setDraft(result.draft);
      setWork(result.work);
      onDirty(false);
      try {
        await onSaved(result.work, isNew ? measured.actualSeconds : 0, isNew);
        if (alive.current) setMessage("作答已保存在本机，联网后同步文字记录。");
      } catch (error) {
        if (alive.current)
          setMessage(
            `作答已保存；任务用时未更新：${error instanceof Error ? error.message : "请重试。"}`,
          );
      }
    } catch (error) {
      if (alive.current)
        setMessage(
          `作答未保存：${error instanceof Error ? error.message : "请重试，转写仍保留。"}`,
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const chooseSource = (value: typeof source) => {
    setSource(value);
    const builtin = availableSpeakingMaterials(context.day).find(
      (item) => item.part === draft.part,
    );
    setDraft((previous) => ({
      ...previous,
      prompt: value === "builtin" ? (builtin?.prompts[0] ?? "") : "",
      sourceRef: undefined,
      contentId:
        value === "builtin"
          ? builtin?.id
          : `${value}-${context.date}-${previous.id}`,
      contentVersion: value === "builtin" ? builtin?.version : undefined,
    }));
  };
  return (
    <article
      className="panel"
      aria-label="当前口语作答"
      data-testid="speaking-editor"
      data-work-id={draft.recordId}
      data-revision-id={work?.revisionId}
    >
      <h2>Part {draft.part}</h2>
      <p>
        {draft.part === 1
          ? "每题回答，再补理由或例子，约20–30秒；到时不会强制停止。"
          : draft.part === 2
            ? "准备1分钟，再说满2分钟。到时只提示，可以继续说。"
            : "逐题回答，展开理由、比较与举例。"}
      </p>
      <fieldset disabled={busy || !!work} style={{ border: 0, padding: 0 }}>
        <label>
          题目来源
          <select
            aria-label="口语题目来源"
            value={source}
            onChange={(event) =>
              chooseSource(event.target.value as typeof source)
            }
          >
            {availableSpeakingMaterials(context.day).some(
              (item) => item.part === draft.part,
            ) && <option value="builtin">当天内置题</option>}
            <option value="external">外部题</option>
            <option value="custom">自定义题</option>
          </select>
        </label>
        {source === "external" && (
          <label>
            外部题出处
            <input
              aria-label="口语外部题出处"
              value={draft.sourceRef ?? ""}
              maxLength={300}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  sourceRef: event.target.value,
                }))
              }
            />
          </label>
        )}
        <label style={{ display: "block" }}>
          题目
          <textarea
            aria-label="口语题目"
            value={draft.prompt}
            readOnly={source === "builtin"}
            rows={3}
            maxLength={8000}
            style={{ width: "100%" }}
            onChange={(event) =>
              setDraft((value) => ({ ...value, prompt: event.target.value }))
            }
          />
        </label>
      </fieldset>
      {material && <p className="muted">内置自编练习题，尚待独立人工审校。</p>}
      {!work && (
        <>
          {draft.part === 2 && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={
                  busy ||
                  timing.prep.runningSince !== null ||
                  timing.answer.runningSince !== null
                }
                onClick={prepare}
              >
                开始准备
              </button>
              <p role="status">准备剩余 {status.prepRemaining} 秒</p>
              {status.prepRemaining === 0 &&
                timing.prep.runningSince !== null && (
                  <p role="status">
                    准备时间已到，请开始作答。超过60秒的准备会计入实际用时。
                  </p>
                )}
              <label style={{ display: "block" }}>
                准备笔记
                <textarea
                  aria-label="准备笔记"
                  rows={3}
                  value={notes}
                  style={{ width: "100%" }}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
            </>
          )}
          <div className="data-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || timing.answer.runningSince !== null}
              onClick={start}
            >
              开始作答计时
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || timing.answer.runningSince === null}
              onClick={stop}
            >
              结束作答
            </button>
          </div>
          <p role="status">
            作答计时 {Math.floor(status.answerSeconds)} 秒
            {draft.part === 2
              ? status.part2Full
                ? " · 已说满120秒，可以结束或继续"
                : " · 未说满120秒"
              : ""}
          </p>
        </>
      )}
      {work && (
        <p role="status">
          已存作答时长 {Math.floor(draft.durationSeconds * 10) / 10} 秒
          {draft.part === 2
            ? draft.durationSeconds >= 120
              ? " · 已说满"
              : " · 未说满120秒"
            : ""}{" "}
          · 无本机录音
        </p>
      )}
      <label style={{ display: "block" }}>
        手动转写
        <textarea
          aria-label="手动转写"
          value={draft.transcript}
          disabled={busy}
          maxLength={20000}
          rows={8}
          style={{ width: "100%" }}
          placeholder="回听后写下自己说的话，也可以只记关键片段；允许留空。"
          onChange={(event) =>
            setDraft((value) => ({ ...value, transcript: event.target.value }))
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          disabled={busy || !!work}
          checked={draft.conditions.unseen}
          onChange={(event) =>
            setDraft((value) => ({
              ...value,
              conditions: { ...value.conditions, unseen: event.target.checked },
            }))
          }
        />{" "}
        这是未做过的题目
      </label>
      <p className="muted">
        本步可只写转写或用外部录音，保存为无本机录音的作答。
      </p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => {
          void save();
        }}
      >
        {busy ? "保存中…" : work ? "保存转写" : "保存作答"}
      </button>
      {message && <p role="status">{message}</p>}
    </article>
  );
}
