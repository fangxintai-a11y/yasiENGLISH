import { useEffect, useRef, useState } from "react";
import { resolveLocalAudio } from "../../localBank";
import type { LocalMaterial } from "../../localBankSchema";
import type { Revision } from "../../protocol";
import { validateNewListeningReadingAttempt } from "../../protocol";
import type { PracticeContext } from "../../listeningReadingTasks";
import { getLearningState, saveRecord } from "../../repository";
import { wasListeningReadingAttempted } from "../../dailyMaterialPlan";
import { currentAttempts, isFirstMaterialAttempt } from "../../readingModel";
import { saveMission } from "../../missionRecords";
import { ReadingVocabulary } from "./ReadingVocabulary";
export function ShortStudy({
  material,
  plan,
  context,
  userId,
  work,
  onSaved,
}: {
  material: LocalMaterial;
  plan: Revision;
  context: PracticeContext;
  userId: string | null;
  work: Revision | null;
  onSaved: (work: Revision) => void;
}) {
  const [started, setStarted] = useState<number | null>(null),
    [text, setText] = useState(() =>
      String((work?.payload.answers as string[] | undefined)?.[0] ?? ""),
    ),
    [show, setShow] = useState(!!work),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const original =
    material.skill === "reading" ? material.passage : material.transcript;
  const save = async () => {
    if (inFlight.current || started === null || work) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    let recorded = false;
    try {
      const state = getLearningState();
      if (!state.ready || state.userId !== userId)
        throw new Error("账号已切换，请重新进入练习。");
      const elapsed = Math.min(
          86400,
          Math.max(0, (Date.now() - started) / 1000),
        ),
        first = context.mode === "practice" ? !wasListeningReadingAttempted(material, [material], state.records)
          : isFirstMaterialAttempt(state.records, plan.id, material);
      const payload = {
        planId: plan.id,
        date: context.date,
        ...(context.mode !== "practice" && context.day >= 1 && context.day <= 365 ? { day: context.day } : {}),
        ...(context.taskId ? { taskId: context.taskId } : {}),
        contentId: material.id,
        contentVersion: material.version,
        contentHash: material.contentHash,
        skill: material.skill,
        materialSource: material.source.materialSource,
        sourceRef: material.source.sourceRef,
        scope: "short",
        answers: text ? [text] : [],
        firstAttempt: first,
        elapsedSeconds: elapsed,
        actualMinutes: elapsed / 60,
        conditions: {
          timed: false,
          unseen: false,
          firstAttempt: first,
          transcriptViewed: show,
        },
      };
      validateNewListeningReadingAttempt(payload);
      const result = await saveRecord({
        id: `attempt-${crypto.randomUUID()}`,
        kind: "attempt",
        payload,
        baseRevision: null,
      }, userId);
      recorded = true;
      onSaved(result);
      setMessage("对照学习已保存，未换算分数。");
      if (context.block) {
        const actual = currentAttempts(getLearningState().records, plan.id)
          .filter(
            (r) =>
              r.payload.taskId === context.taskId &&
              r.payload.date === context.date,
          )
          .reduce((sum, r) => sum + Number(r.payload.actualMinutes ?? 0), 0);
        await saveMission({
          planId: plan.id,
          day: context.day,
          date: context.date,
          block: context.block,
          status: "partial",
          actualMinutes: actual,
          timeSource: "timer",
          expectedUserId: userId,
        });
      }
    } catch (e) {
      setError(
        (recorded ? "学习记录已保存；任务计时未更新。" : "") +
          (e instanceof Error ? e.message : "保存失败，请重试。"),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="短专项对照学习">
      <h2>文稿／答案对照</h2>
      <p>
        这份材料缺少可完整作答的题目，作为短专项学习，不计分、不充作整套测评或官方题型校准。
      </p>
      {!work && started === null && (
        <button
          className="btn btn-primary"
          disabled={context.mode !== "practice" && (context.day < 1 || context.day > 365)}
          onClick={() => setStarted(Date.now())}
        >
          开始对照学习计时
        </button>
      )}
      {(started !== null || work) && (
        <>
          {material.skill === "listening" && material.audio && (
            <ShortAudio material={material} userId={userId} />
          )}
          <label className="field">
            <span>我的听写或复盘笔记</span>
            <textarea
              aria-label="短专项听写"
              value={text}
              maxLength={20000}
              disabled={busy || !!work}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            className="btn btn-ghost"
            onClick={() => setShow((value) => !value)}
          >
            {show ? "收起" : "显示"}原文与答案对照
          </button>
          {show && (
            <article aria-label="短专项原文对照">
              <p style={{ whiteSpace: "pre-wrap" }}>{original}</p>
              {material.notes?.map((note, i) => (
                <p key={i} style={{ whiteSpace: "pre-wrap" }}>
                  {note}
                </p>
              ))}
            </article>
          )}
          {!work && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              保存对照学习
            </button>
          )}
          {work && (
            <p>
              实际用时 {Number(work.payload.actualMinutes ?? 0).toFixed(1)} 分钟
              · 未判分
            </p>
          )}
          <ReadingVocabulary text={original} />
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function ShortAudio({
  material,
  userId,
}: {
  material: LocalMaterial;
  userId: string | null;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      release: (() => void) | undefined;
    void resolveLocalAudio(userId, material).then(
      (audio) => {
        if (!active) {
          audio.release();
          return;
        }
        release = audio.release;
        setUrl(audio.url);
      },
      () => {
        if (active) setError("这台设备还没有这份音频，请导入带音频的题库包。");
      },
    );
    return () => {
      active = false;
      release?.();
    };
  }, [userId, material.id, material.contentHash]);
  return (
    <>
      {url && <audio controls src={url} aria-label="短专项回听" />}
      {error && <p role="status">{error}</p>}
    </>
  );
}
