import { useState } from "react";
import type { Revision } from "../../protocol";
import {
  availableSpeakingMaterials,
  type SpeakingContext,
} from "../../speakingTasks";
import { RecordingPlayer } from "./RecordingPlayer";
import { SpeakingReview } from "./SpeakingReview";
import {
  useSpeakingAnswer,
  type SpeakingAnswerOptions,
} from "./useSpeakingAnswer";
export function SpeakingQuestionEditor(
  props: SpeakingAnswerOptions & { plan: Revision; context: SpeakingContext },
) {
  const { context } = props;
  const answer = useSpeakingAnswer(props),
    {
      draft,
      setDraft,
      work,
      timing,
      notes,
      setNotes,
      busy,
      message,
      status,
      captureState,
      pending,
      estimated,
    } = answer;
  const material = availableSpeakingMaterials(draft.day ?? context.day).find(
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
  const recording = captureState === "recording";
  const reviewWork = answer.currentWork();
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
      <fieldset
        disabled={busy || !!work || recording}
        style={{ border: 0, padding: 0 }}
      >
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
                  recording ||
                  timing.prep.runningSince !== null ||
                  timing.answer.runningSince !== null
                }
                onClick={answer.prepare}
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
                  disabled={busy}
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
              disabled={
                busy || recording || timing.answer.runningSince !== null
              }
              onClick={() => {
                void answer.beginRecord();
              }}
            >
              开始录音
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !recording}
              onClick={() => {
                void answer.endRecord();
              }}
            >
              停止录音
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                busy || recording || timing.answer.runningSince !== null
              }
              onClick={answer.startManual}
            >
              仅计时作答
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                busy || recording || timing.answer.runningSince === null
              }
              onClick={answer.stopManual}
            >
              结束作答
            </button>
          </div>
          <p role="status">
            {captureState === "requesting"
              ? "正在请求麦克风…"
              : captureState === "stopping"
                ? "正在保存录音…"
                : recording
                  ? "录音中 · "
                  : ""}
            作答计时 {Math.floor(status.answerSeconds)} 秒
            {draft.part === 2
              ? status.part2Full
                ? " · 已到120秒，可以结束或继续"
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
            : ""}
        </p>
      )}
      <RecordingPlayer work={work} pending={pending} />
      {estimated && (
        <p className="muted">
          本段音频无法解码，时长按实际录制计时估计；请回听确认。
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
          disabled={busy || !!work || recording}
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
      <div className="data-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || recording}
          onClick={() => {
            void answer.save();
          }}
        >
          {busy
            ? "保存中…"
            : work
              ? "保存转写"
              : pending
                ? "重试保存录音"
                : "保存作答"}
        </button>
        {!work && (pending || answer.micFailed) && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || recording}
            onClick={() => {
              void answer.onlyTranscript();
            }}
          >
            仅保存转写
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {reviewWork && (
        <SpeakingReview
          work={reviewWork}
          currentWork={answer.currentWork}
          materialSelfCheck={material?.reviewChecklist}
        />
      )}
    </article>
  );
}
