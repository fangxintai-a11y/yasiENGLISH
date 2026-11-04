import { withRevisionReferences } from "../../revisionReferences";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Revision } from "../../protocol";
import type { LocalMaterial } from "../../localBankSchema";
import type { DayPlan } from "../../planEngine";
import {
  buildCorrection,
  correctionOriginal,
  correctionItemKey,
  updateCorrectionItems,
  type CorrectionItem,
  type CorrectionPayload,
} from "../../correctionModel";
import { CORRECTION_RULES } from "../../correctionRules";
import { reviewBudget } from "../../reviewBudget";
import { getLearningState, saveRecord } from "../../repository";
import { saveMission, selectMission } from "../../missionRecords";
import { PracticeClock } from "../../practiceDraft";
import { ReadingVocabulary } from "../reading/ReadingVocabulary";

export const CORRECTION_STATUS_LABELS = {
  open: "待订正",
  corrected: "已订正，等待新题复测",
  "retested-pass": "本轮复测通过",
  "retested-fail": "本轮复测未通过",
  dropped: "已放弃（保留说明）",
};
const skillLabels: Record<string, string> = {
  listening: "听力",
  reading: "阅读",
  writing: "写作",
  speaking: "口语",
};
interface Props {
  plan: Revision;
  dayPlan: DayPlan;
  records: readonly Revision[];
  bank: readonly LocalMaterial[];
  userId: string | null;
}
function assertAccount(userId: string | null) {
  const state = getLearningState();
  if (!state.ready || state.userId !== userId)
    throw new Error("账号已经切换，请重新打开订正页。");
  return state;
}
export function CorrectionPanel(props: Props) {
  const { plan, dayPlan, records, userId } = props;
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const budget = reviewBudget(dayPlan, records, plan.id);
  const corrections = records.filter(
    (r) =>
      r.kind === "correction" &&
      r.planId === plan.id &&
      !r.deleted &&
      !r.conflict,
  );
  const drafts = useMemo(
    () =>
      records
        .filter(
          (r) =>
            r.planId === plan.id &&
            !r.deleted &&
            !r.conflict &&
            (["attempt", "feedback"].includes(r.kind) ||
              (r.kind === "assessment" &&
                r.payload.kind === "weekly-calibration")),
        )
        .flatMap((source) => {
          try {
            const value = buildCorrection(source, {
              planId: plan.id,
              date: dayPlan.date,
              day: dayPlan.day,
              records: withRevisionReferences(records),
            });
            return value ? [value] : [];
          } catch {
            return [];
          }
        }),
    [plan.id, dayPlan.date, dayPlan.day, records],
  );
  const pending = corrections.reduce(
    (sum, r) =>
      sum +
      (r.payload as CorrectionPayload).items.filter(
        (item) => item.status === "open",
      ).length,
    0,
  );
  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let count = 0;
      for (const candidate of drafts) {
        const state = assertAccount(userId);
        if (state.records.some((r) => r.id === candidate.id && !r.conflict))
          continue;
        await saveRecord({ ...candidate, baseRevision: null });
        count++;
      }
      setMessage(
        `已生成${count}轮订正；完成订正后，至少隔一个自然日再做未见新题。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "订正未保存。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" aria-label="订正任务">
      <h2>待订正 {pending} 项</h2>
      <p>
        今天已有复盘预算 {budget.minutes} 分钟，已记录 {budget.used.toFixed(1)}{" "}
        分钟，剩余 {budget.remaining.toFixed(1)}{" "}
        分钟。排不下的顺延，不增加120分钟。
      </p>
      {!budget.canStart && (
        <p role="status">
          今天没有剩余复盘预算，待订正任务保留到下一次已有复盘块。
        </p>
      )}
      <button
        className="btn btn-primary"
        disabled={busy || !drafts.length || dayPlan.state !== "active"}
        onClick={() => void generate()}
      >
        生成待订正任务（
        {drafts.reduce((sum, d) => sum + d.payload.items.length, 0)}项）
      </button>
      <p>
        听读需完成A-B复盘；写说反馈须明确列出错因。存疑题先进入答案审校，不直接生成订正。
      </p>
      {corrections.map((correction) => (
        <CorrectionRound
          key={correction.id}
          {...props}
          correction={correction}
        />
      ))}
      {!corrections.length && (
        <p>尚无订正记录。完成原题复盘或写说自查后，在这里生成。</p>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function CorrectionRound(props: Props & { correction: Revision }) {
  const { correction, records, bank } = props,
    payload = correction.payload as CorrectionPayload;
  const original = correctionOriginal(
    correction,
    withRevisionReferences(records),
  );
  const material = bank.find(
    (m) =>
      m.id === original?.payload.contentId &&
      m.version === original.payload.contentVersion &&
      m.contentHash === original.payload.contentHash,
  );
  return (
    <article
      data-correction-id={correction.id}
      id={`review-${correction.id}`}
      style={{
        minWidth: 0,
        borderTop: "1px solid var(--line)",
        paddingTop: 16,
        marginTop: 16,
      }}
    >
      <h3>
        {skillLabels[payload.skill]}订正 · {payload.date}
      </h3>
      <p>
        来源：{payload.sourceId} · 修订 {payload.sourceRevisionId}
      </p>
      {!original && (
        <p role="alert">
          当前缺少这版来源，待同步原稿后继续；不会另猜一份作品。
        </p>
      )}
      {payload.items.map((item) => (
        <CorrectionTask
          key={correctionItemKey(item)}
          {...props}
          item={item}
          original={original}
          material={material}
        />
      ))}
      {payload.items.some((item) => item.status === "corrected") && (
        <p>
          已订正只代表完成本轮修改，仍需隔天新题复测，不修改门槛或目标差距。
        </p>
      )}
    </article>
  );
}
function CorrectionTask({
  plan,
  dayPlan,
  records,
  userId,
  correction,
  item,
  original,
  material,
}: Props & {
  correction: Revision;
  item: CorrectionItem;
  original: Revision | null;
  material?: LocalMaterial;
}) {
  const [note, setNote] = useState(item.note ?? ""),
    [working, setWorking] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const clock = useRef(new PracticeClock()),
    lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clock.current.pause();
    };
  }, []);
  useEffect(() => {
    if (!working) return;
    const visibility = () =>
      document.visibilityState === "hidden"
        ? clock.current.pause()
        : clock.current.resume();
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clock.current.pause();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [working]);
  const budget = reviewBudget(dayPlan, records, plan.id),
    writingSpeaking =
      original?.kind === "essay" || original?.kind === "speaking";
  const revised =
    original &&
    records.find(
      (r) =>
        r.planId === plan.id &&
        !r.deleted &&
        !r.conflict &&
        r.kind === original.kind &&
        r.payload.correctionId === correction.id &&
        !r.payload.retestOf &&
        r.payload.parentRevisionId === original.revisionId &&
        (r.kind === "essay"
          ? r.payload.stage === "submitted" &&
            String(r.payload.text).trim() !==
              String(original.payload.text).trim()
          : item.action === "rerecord-segment"
            ? !!r.payload.recordingId &&
              r.payload.recordingId !== original.payload.recordingId
            : (!!r.payload.recordingId &&
                r.payload.recordingId !== original.payload.recordingId) ||
              String(r.payload.transcript ?? "").trim() !==
                String(original.payload.transcript ?? "").trim()),
    );
  const finish = async (status: "corrected" | "dropped") => {
    if (lock.current) return;
    if (!note.trim() && (!writingSpeaking || status === "dropped")) {
      setError("请写下本项订正依据或放弃原因。");
      return;
    }
    if (
      status === "corrected" &&
      ((!budget.canStart && !revised) ||
        (!writingSpeaking && !working) ||
        (writingSpeaking && !revised))
    ) {
      setError("请在已有复盘预算内完成实际订正并保存。");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    let saved = false;
    try {
      const state = assertAccount(userId),
        current = state.records.find(
          (r) => r.id === correction.id && !r.conflict,
        );
      if (!current) throw new Error("订正记录已变化，请重新打开。");
      const payload = updateCorrectionItems(
        current.payload as CorrectionPayload,
        {
          [correctionItemKey(item)]: {
            status,
            note: note.trim() || (revised ? `已保存订正稿 ${revised.id}` : ""),
          },
        },
        dayPlan.date,
        dayPlan.day,
      );
      await saveRecord({
        id: current.id,
        kind: "correction",
        payload,
        baseRevision: current.revisionId,
      });
      saved = true;
      if (!writingSpeaking && working && budget.block) {
        const fresh = assertAccount(userId),
          old = selectMission(
            fresh.records,
            plan.id,
            dayPlan.date,
            budget.taskId,
          );
        await saveMission({
          planId: plan.id,
          date: dayPlan.date,
          day: dayPlan.day,
          block: budget.block,
          status: old?.payload.status === "completed" ? "completed" : "partial",
          actualMinutes:
            Number(old?.payload.actualMinutes ?? 0) +
            clock.current.value() / 60,
          timeSource: "timer",
          expectedUserId: userId,
        });
      }
      clock.current.pause();
      if (alive.current) setWorking(false);
    } catch (e) {
      if (alive.current)
        setError(
          (saved ? "订正已保存；任务计时未更新。" : "") +
            (e instanceof Error ? e.message : "未保存。"),
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const question = material?.questions.find((q) => q.id === item.questionId);
  const href =
    original &&
    `#/${original.kind === "essay" ? "writing" : original.kind === "speaking" ? "speaking" : original.payload.skill}?${new URLSearchParams({ work: original.id, date: dayPlan.date, day: String(dayPlan.day), task: budget.taskId, correctionId: correction.id })}`;
  return (
    <section
      aria-label={`订正项 ${item.questionId ?? item.dimension}`}
      style={{ minWidth: 0, marginTop: 16, overflowWrap: "anywhere" }}
    >
      <h4>
        {item.questionId ?? item.dimension} ·{" "}
        {CORRECTION_STATUS_LABELS[item.status]}
      </h4>
      <p>{CORRECTION_RULES[item.errorCause].label}</p>
      {question && <p>{question.prompt}</p>}
      {material && (
        <details>
          <summary>查看原文依据</summary>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {material.skill === "reading"
              ? material.passage
              : material.transcript}
          </p>
        </details>
      )}
      {item.status === "open" && (
        <>
          {writingSpeaking && href ? (
            <>
              <a
                className="btn btn-ghost"
                aria-disabled={!budget.canStart}
                href={budget.canStart ? href : undefined}
              >
                打开原稿并新建订正稿
              </a>
              <p>
                请在工作台用“修改稿／重录”保存新版本，再回来确认；保留原稿。
              </p>
            </>
          ) : (
            <>
              <button
                className="btn btn-ghost"
                disabled={busy || working || !budget.canStart || !original}
                onClick={() => {
                  clock.current = new PracticeClock();
                  clock.current.resume();
                  setWorking(true);
                }}
              >
                开始本项订正计时
              </button>
              {material && (
                <ReadingVocabulary
                  text={
                    material.skill === "reading"
                      ? material.passage
                      : material.transcript
                  }
                />
              )}
            </>
          )}
          <label className="field">
            <span>我的订正依据／放弃原因</span>
            <textarea
              aria-label={`订正说明 ${correctionItemKey(item)}`}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !original ||
              (writingSpeaking && !revised) ||
              (!writingSpeaking && !working)
            }
            onClick={() => void finish("corrected")}
          >
            {writingSpeaking ? "确认已保存订正稿" : "完成本项订正"}
          </button>{" "}
          <button
            className="btn btn-ghost"
            disabled={busy || !note.trim()}
            onClick={() => void finish("dropped")}
          >
            放弃本项并保留说明
          </button>
        </>
      )}
      {item.note && item.status !== "open" && <p>{item.note}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
