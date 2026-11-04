import { useEffect, useRef, useState } from "react";
import type { LocalMaterial } from "../../localBankSchema";
import { getLearningState, saveRecord } from "../../repository";
import type { Revision } from "../../protocol";
import { gradeMaterial } from "../../readingModel";
import {
  completeReadingReview,
  LISTENING_READING_CAUSES,
  LR_CAUSE_LABELS,
  reviewSummary,
  withReviewAnswers,
  type QuestionReview,
} from "../../readingReview";
import { PracticeClock } from "../../practiceDraft";
import { ReadingQuestions } from "./ReadingQuestions";
import { ReadingVocabulary } from "./ReadingVocabulary";
export function ReadingReview({
  material,
  work,
  userId,
  onSaved,
  onEvidence,
  onReplay,
}: {
  material: LocalMaterial;
  work: Revision;
  userId: string | null;
  onSaved: (record: Revision) => void;
  onEvidence?: (quote: string, paragraphId?: string, offset?: number) => void;
  onReplay?: (seconds: number) => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => [
    ...((work.payload.reviewAnswers ?? work.payload.answers) as string[]),
  ]);
  const [reviews, setReviews] = useState<Record<string, QuestionReview>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    inFlight = useRef(false),
    reviewClock = useRef(new PracticeClock());
  useEffect(() => {
    alive.current = true;
    const update = () => {
      if (document.visibilityState === "hidden") reviewClock.current.pause();
      else reviewClock.current.resume();
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      alive.current = false;
      reviewClock.current.pause();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    reviewClock.current = new PracticeClock();
    if (document.visibilityState === "hidden") reviewClock.current.pause();
    const first = gradeMaterial(material, work.payload.answers as string[]);
    setAnswers([
      ...((work.payload.reviewAnswers ?? work.payload.answers) as string[]),
    ]);
    const saved = Array.isArray(work.payload.questionResults)
      ? (work.payload.questionResults as ({
          questionId: string;
        } & QuestionReview)[])
      : [];
    setReviews(
      Object.fromEntries(
        material.questions.map((q, i) => [
          q.id,
          saved.find((result) => result.questionId === q.id) ?? {
            confidence: "unsure",
            errorCause:
              first.questionResults[i].errorCause ??
              (material.skill === "listening" &&
              !q.options &&
              /completion|short-answer/.test(q.type) &&
              !first.questionResults[i].correct
                ? "spelling"
                : null),
          },
        ]),
      ),
    );
  }, [work.revisionId, material.id]);
  const phase = Array.isArray(work.payload.reviewAnswers) ? "b" : "a";
  const complete =
    Array.isArray(work.payload.questionResults) &&
    work.payload.questionResults.length === material.questions.length &&
    work.payload.questionResults.every(
      (q) =>
        typeof (q as { reviewCorrect?: unknown }).reviewCorrect === "boolean",
    );
  const first = gradeMaterial(material, work.payload.answers as string[]);
  const update = (id: string, patch: Partial<QuestionReview>) =>
    setReviews((old) => ({ ...old, [id]: { ...old[id], ...patch } }));
  const save = async (final: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const state = getLearningState();
      if (!state.ready || state.userId !== userId)
        throw new Error("账号已切换，请重新打开作答。");
      const current = state.records.find(
        (r) => r.id === work.id && !r.deleted && !r.conflict,
      );
      if (!current || current.revisionId !== work.revisionId)
        throw new Error("作答版本有变化，请重新打开后复盘。");
      const payload = final
        ? completeReadingReview(work, material, answers, reviews)
        : withReviewAnswers(work, material, answers);
      payload.actualMinutes = Math.min(
        1440,
        Number(work.payload.actualMinutes ?? 0) +
          reviewClock.current.value() / 60,
      );
      const result = await saveRecord({
        id: work.id,
        kind: "attempt",
        payload,
        baseRevision: work.revisionId,
      });
      if (alive.current && getLearningState().userId === userId)
        onSaved(result);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "复盘未保存，请重试。");
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const summary = reviewSummary(work);
  return (
    <section aria-label="听读 A-B 复盘" data-testid="lr-review">
      <h2>{phase === "a" ? "A轮：先自己改答案" : "B轮：核对答案和证据"}</h2>
      {phase === "a" ? (
        <>
          <p>
            先不看答案。重新读一遍，或自由回听，再修改答案。首答得分会保留。
          </p>
          <ReadingQuestions
            material={material}
            answers={answers}
            onChange={setAnswers}
            disabled={busy}
          />
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void save(false)}
          >
            保存A轮，查看答案
          </button>
        </>
      ) : (
        <>
          <p>
            A轮答案已保存；下面核对原文。每道错题请选择错因，或标记答案存疑并说明理由。
          </p>
          {material.notes?.length ? (
            <details>
              <summary>材料勘误与备注</summary>
              {material.notes.map((note, i) => (
                <p key={i}>{note}</p>
              ))}
            </details>
          ) : null}
          {material.questions.map((q, i) => {
            const selected = reviews[q.id] ?? {
              confidence: "unsure",
              errorCause: null,
            };
            const correct = first.questionResults[i].correct;
            const quote = q.evidence.quote;
            return (
              <fieldset key={q.id} data-review-question-id={q.id}>
                <legend>
                  第{q.number ?? i + 1}题 · {correct ? "首答正确" : "首答错误"}{" "}
                  · {q.type}
                </legend>
                <p>{q.prompt}</p>
                {q.selectionCount && q.groupId && (
                  <p>
                    本组按选择集合判分，顺序不限。首答所选：
                    {material.questions
                      .flatMap((item, j) =>
                        item.groupId === q.groupId
                          ? [
                              String(
                                (work.payload.answers as string[])[j] ?? "",
                              ),
                            ]
                          : [],
                      )
                      .join(" / ")}
                    。
                  </p>
                )}
                <p>
                  首答：
                  {String((work.payload.answers as string[])[i] ?? "未作答")} ·
                  A轮：{String(answers[i] ?? "未作答")}
                </p>
                <p>
                  接受答案：{q.answer.accepted.join(" / ")}
                  {!q.answerVerified ? "（答案待核）" : ""}
                </p>
                <p>
                  {q.answer.accepted.includes("NOT GIVEN")
                    ? "相关语境"
                    : "原文证据"}
                  ：{quote ? <mark>{quote}</mark> : "尚未可靠定位，答案待核"}
                </p>
                {q.evidence.rationale && <p>{q.evidence.rationale}</p>}
                {quote && onEvidence && (
                  <button
                    className="btn btn-ghost"
                    onClick={() =>
                      onEvidence(
                        quote,
                        q.evidence.paragraphId ?? q.paragraphId,
                        q.evidence.offset,
                      )
                    }
                  >
                    高亮原文位置
                  </button>
                )}
                {typeof q.evidence.startSeconds === "number" && onReplay && (
                  <button
                    className="btn btn-ghost"
                    onClick={() =>
                      onReplay(Math.max(0, q.evidence.startSeconds! - 5))
                    }
                  >
                    重听这句前5秒
                  </button>
                )}
                <label className="field">
                  <span>确定程度</span>
                  <select
                    aria-label={`第${q.number ?? i + 1}题确定程度`}
                    value={selected.confidence}
                    disabled={busy || complete}
                    onChange={(e) =>
                      update(q.id, {
                        confidence: e.target.value as "sure" | "unsure",
                      })
                    }
                  >
                    <option value="sure">确定</option>
                    <option value="unsure">不确定</option>
                  </select>
                </label>
                {!correct && (
                  <label className="field">
                    <span>错因</span>
                    <select
                      aria-label={`第${q.number ?? i + 1}题错因`}
                      value={selected.errorCause ?? ""}
                      disabled={busy || complete || selected.answerDisputed}
                      onChange={(e) =>
                        update(q.id, { errorCause: e.target.value || null })
                      }
                    >
                      <option value="">请选择错因</option>
                      {LISTENING_READING_CAUSES.map((cause) => (
                        <option key={cause} value={cause}>
                          {LR_CAUSE_LABELS[cause]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="r4-choice">
                  <input
                    type="checkbox"
                    aria-label={`第${q.number ?? i + 1}题答案存疑`}
                    checked={!!selected.answerDisputed}
                    disabled={busy || complete}
                    onChange={(e) =>
                      update(q.id, { answerDisputed: e.target.checked })
                    }
                  />
                  答案存疑（不计为学习者错误）
                </label>
                <label className="field">
                  <span>
                    说明
                    {selected.answerDisputed || selected.errorCause === "other"
                      ? "（必填）"
                      : "（可选）"}
                  </span>
                  <textarea
                    maxLength={4000}
                    aria-label={`第${q.number ?? i + 1}题说明`}
                    value={selected.note ?? ""}
                    disabled={busy || complete}
                    onChange={(e) => update(q.id, { note: e.target.value })}
                  />
                </label>
              </fieldset>
            );
          })}
          {!complete ? (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void save(true)}
            >
              完成B轮复盘
            </button>
          ) : (
            <p role="status">
              复盘已保存：A轮改对 {summary.corrected} 题，仍错{" "}
              {summary.remaining} 题；答案存疑 {summary.disputed}{" "}
              题，已排除错因统计。首答分数保持不变。
            </p>
          )}
          <ReadingVocabulary
            text={
              material.skill === "reading"
                ? (material.passage ?? "")
                : (material.transcript ?? "")
            }
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
