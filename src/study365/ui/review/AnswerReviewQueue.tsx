import { useEffect, useMemo, useRef, useState } from "react";
import {
  answerReviewQueue,
  buildAnswerReviewPayload,
  buildReviewedCorrection,
  exportAnswerReviews,
  reviewedAttempt,
  type AnswerReviewDecision,
  type AnswerReviewTarget,
  type AnswerVerdict,
} from "../../answerReviewModel";
import type { LocalMaterial } from "../../localBankSchema";
import { currentAttempts } from "../../readingModel";
import { LR_CAUSE_LABELS, LISTENING_READING_CAUSES } from "../../readingReview";
import { isObject, type Revision } from "../../protocol";
import { getLearningState, saveRecord } from "../../repository";

function hasCorrection(
  records: readonly Revision[],
  planId: string,
  work: Revision,
  questionId: string,
) {
  const heads = new Map<string, Revision>();
  for (const record of [...records].sort(
    (a, b) => b.createdAt - a.createdAt || b.seq - a.seq,
  ))
    if (!heads.has(record.id)) heads.set(record.id, record);
  return [...heads.values()].some(
    (record) =>
      record.kind === "correction" &&
      record.planId === planId &&
      !record.deleted &&
      !record.conflict &&
      record.payload.sourceRevisionId === work.revisionId &&
      Array.isArray(record.payload.items) &&
      record.payload.items.some(
        (item) => isObject(item) && item.questionId === questionId,
      ),
  );
}
function downloadReviews(records: readonly Revision[], planId: string) {
  const blob = new Blob(
    [JSON.stringify(exportAnswerReviews(records, planId), null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "answer-reviews.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function AnswerReviewQueue({
  records,
  bank,
  planId,
  userId,
  date,
  day,
  onSaved,
}: {
  records: readonly Revision[];
  bank: readonly LocalMaterial[];
  planId: string;
  userId: string | null;
  date?: string;
  day?: number;
  onSaved?: () => void;
}) {
  const [query, setQuery] = useState(""),
    [showReviewed, setShowReviewed] = useState(false),
    [selectedKey, setSelectedKey] = useState(""),
    [limit, setLimit] = useState(40),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const alive = useRef(true),
    inFlight = useRef(false),
    scope = useRef({ planId, userId });
  scope.current = { planId, userId };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const all = useMemo(
    () => answerReviewQueue(records, bank, planId),
    [records, bank, planId],
  );
  const needsCause = (target: AnswerReviewTarget) =>
    target.learners.some(
      (learner) =>
        learner.needsErrorCause &&
        !hasCorrection(records, planId, learner.work, target.question.id),
    );
  const pending = all.filter((target) => target.pending || needsCause(target));
  const filtered = all.filter(
    (target) =>
      (showReviewed || target.pending || needsCause(target)) &&
      (!query.trim() ||
        `${target.material.title} ${target.material.source.sourceRef} ${target.question.id} ${target.question.prompt}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const shown = filtered.slice(0, limit),
    selected =
      shown.find((target) => target.key === selectedKey) ?? shown[0] ?? null;
  const live = () => {
    const state = getLearningState();
    if (
      !alive.current ||
      !state.ready ||
      state.userId !== userId ||
      scope.current.planId !== planId ||
      scope.current.userId !== userId
    )
      throw new Error("账号或计划已经切换，请重新进入答案审校。");
    return state;
  };
  const mutate = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      live();
      await action();
      if (alive.current && getLearningState().userId === userId) onSaved?.();
    } catch (cause) {
      if (alive.current && getLearningState().userId === userId)
        setError(
          cause instanceof Error ? cause.message : "审校记录未保存，请重试。",
        );
    } finally {
      inFlight.current = false;
      if (alive.current && getLearningState().userId === userId) setBusy(false);
    }
  };
  const decide = async (
    target: AnswerReviewTarget,
    decision: AnswerReviewDecision,
  ) =>
    mutate(async () => {
      const first = live(),
        current = answerReviewQueue(first.records, bank, planId).find(
          (item) => item.key === target.key,
        );
      const payload = buildAnswerReviewPayload(
        planId,
        target.material,
        target.question.id,
        decision,
      );
      const bytes = new TextEncoder().encode(
        JSON.stringify([planId, target.key]),
      );
      const digest = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      live();
      await saveRecord({
        id: current?.review?.id ?? `answer-review:${digest}`,
        kind: "answerReview",
        payload,
        baseRevision: current?.review?.revisionId ?? null,
      });
      live();
      setMessage("审校结论已保存；首答原分不变，统计使用校正结果。");
    });
  const supplement = async (
    target: AnswerReviewTarget,
    work: Revision,
    errorCause: string,
    note: string,
  ) =>
    mutate(async () => {
      const state = live(),
        current = currentAttempts(state.records, planId).find(
          (record) => record.id === work.id,
        );
      if (!current || current.revisionId !== work.revisionId)
        throw new Error("原作答已更新，请重新选择这一题。");
      if (!date || !day || day < 1 || day > 365)
        throw new Error(
          "当前不在有效计划日内，可先保存审校，进入计划后再生成订正。",
        );
      const draft = buildReviewedCorrection(
        work,
        target.material,
        state.records,
        planId,
        date,
        day,
        { [target.question.id]: { errorCause, note } },
      );
      if (!draft) {
        setMessage("这项订正已经存在，原已完成项目没有重复生成。");
        return;
      }
      live();
      await saveRecord(draft);
      live();
      setMessage("错因已保存到订正任务；原首答与分数没有改写。");
    });
  return (
    <section
      className="panel"
      aria-label="答案审校"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>答案审校</h2>
      <p>
        待审或待补错因 {pending.length}{" "}
        项。审校按材料ID、版本、hash和题号生效，换版后重新核对；原分始终保留。
      </p>
      <div className="data-actions">
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => {
            try {
              const state = live();
              downloadReviews(state.records, planId);
              setMessage(
                "已导出answer-reviews.json，交内容方回写；本机原题未改。",
              );
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : "未能导出审校记录。",
              );
            }
          }}
        >
          导出审校结果JSON
        </button>
        <label>
          <input
            type="checkbox"
            aria-label="显示已审校题目"
            checked={showReviewed}
            disabled={busy}
            onChange={(event) => setShowReviewed(event.target.checked)}
          />
          显示已审校题目
        </label>
      </div>
      <label className="field">
        <span>查找题目</span>
        <input
          aria-label="查找审校题目"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label
        className="field"
        style={{
          display: "block",
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        <span>审校题目</span>
        <select
          aria-label="审校题目"
          disabled={busy || !shown.length}
          value={selected?.key ?? ""}
          onChange={(event) => setSelectedKey(event.target.value)}
          style={{
            display: "block",
            width: "100%",
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          {!shown.length && <option value="">没有待处理题目</option>}
          {shown.map((target) => (
            <option key={target.key} value={target.key}>
              {target.material.source.sourceRef} · 第
              {target.question.number ?? target.question.id}题 · 存疑
              {target.disputeCount}次
            </option>
          ))}
        </select>
      </label>
      {filtered.length > limit && (
        <button
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => setLimit((value) => value + 40)}
        >
          再显示40项（还有{filtered.length - limit}项）
        </button>
      )}
      {selected && (
        <ReviewForm
          key={selected.key}
          target={selected}
          records={records}
          planId={planId}
          busy={busy}
          canCorrect={!!date && !!day && day >= 1 && day <= 365}
          onDecide={decide}
          onSupplement={supplement}
        />
      )}
      {!all.length && (
        <p>当前没有存疑或待核题目；本机缺原件时请先导入同版题库。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
function ReviewForm({
  target,
  records,
  planId,
  busy,
  canCorrect,
  onDecide,
  onSupplement,
}: {
  target: AnswerReviewTarget;
  records: readonly Revision[];
  planId: string;
  busy: boolean;
  canCorrect: boolean;
  onDecide: (
    target: AnswerReviewTarget,
    decision: AnswerReviewDecision,
  ) => Promise<void>;
  onSupplement: (
    target: AnswerReviewTarget,
    work: Revision,
    errorCause: string,
    note: string,
  ) => Promise<void>;
}) {
  const { material, question, review } = target;
  const [verdict, setVerdict] = useState<AnswerVerdict>(
      (review?.payload.verdict as AnswerVerdict | undefined) ?? "key-correct",
    ),
    [answers, setAnswers] = useState(
      ((review?.payload.correctedAnswers as string[] | undefined) ?? []).join(
        "\n",
      ),
    ),
    [note, setNote] = useState(String(review?.payload.note ?? "")),
    [reviewer, setReviewer] = useState<"self" | "human">(
      review?.payload.reviewer === "human" ? "human" : "self",
    );
  const [causes, setCauses] = useState<Record<string, string>>({}),
    [causeNotes, setCauseNotes] = useState<Record<string, string>>({});
  const paragraph =
    material.skill === "reading"
      ? (material.paragraphs.find(
          (item) =>
            item.id === (question.evidence.paragraphId ?? question.paragraphId),
        )?.text ?? question.evidence.quote)
      : material.transcript;
  return (
    <article aria-label="当前审校题目">
      <h3>
        {material.title} · 第{question.number ?? question.id}题
      </h3>
      <p>{question.prompt}</p>
      {!!question.options?.length && (
        <ul>
          {question.options.map((option) => (
            <li key={option.id}>
              {option.id} · {option.text}
            </li>
          ))}
        </ul>
      )}
      <p>
        原答案：{question.answer.accepted.join(" / ")} · 每空最多
        {question.answer.maxWords}词
        {question.answer.allowNumber ? "，另允许一个数字" : ""}
      </p>
      <p>存疑次数：{target.disputeCount}</p>
      {!!target.reasons.length && (
        <ul>
          {target.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>
          {material.skill === "reading" ? "证据段与原文" : "听力原文"}
        </summary>
        <p style={{ whiteSpace: "pre-wrap" }}>
          {paragraph || "原材料没有提供可靠证据定位，请核对原文。"}
        </p>
        {material.skill === "reading" && (
          <details>
            <summary>完整原文（只在本机）</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{material.passage}</p>
          </details>
        )}
      </details>
      {target.learners.slice(0, 10).map((learner) => {
        const projection = reviewedAttempt(
            learner.work,
            material,
            records,
            planId,
          ),
          key = learner.work.revisionId;
        const exists = hasCorrection(
          records,
          planId,
          learner.work,
          question.id,
        );
        return (
          <div key={key}>
            <p>
              学习者答案：{learner.answer || "未作答"} ·{" "}
              {String(learner.work.payload.date ?? "日期未记录")} · 原始首答
              {projection.originalScore ?? "未知"}/{projection.originalTotal}
              ；校正后{projection.correctedScore ?? "未知"}/{projection.total}
              {projection.excluded ? `（${projection.excluded}题排除）` : ""}
            </p>
            {learner.needsErrorCause &&
              (exists ? (
                <p>此题已生成订正；原首答未改。</p>
              ) : (
                <div>
                  <p>
                    审定后此题计为错题，请明确选择错因再生成订正。时间仍使用原复盘预算。
                  </p>
                  <label className="field">
                    <span>补选错因</span>
                    <select
                      aria-label={`第${question.number ?? question.id}题补选错因`}
                      value={causes[key] ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        setCauses((value) => ({
                          ...value,
                          [key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">请选择</option>
                      {LISTENING_READING_CAUSES.map((cause) => (
                        <option key={cause} value={cause}>
                          {LR_CAUSE_LABELS[cause]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {causes[key] === "other" && (
                    <label className="field">
                      <span>错因说明</span>
                      <textarea
                        aria-label="补选错因说明"
                        maxLength={2000}
                        value={causeNotes[key] ?? ""}
                        onChange={(event) =>
                          setCauseNotes((value) => ({
                            ...value,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  )}
                  <button
                    className="btn btn-primary"
                    disabled={busy || !canCorrect || !causes[key]}
                    onClick={() =>
                      void onSupplement(
                        target,
                        learner.work,
                        causes[key] ?? "",
                        causeNotes[key] ?? "",
                      )
                    }
                  >
                    补错因并生成订正
                  </button>
                  {!canCorrect && <p>进入有效计划日后可生成订正。</p>}
                  <a
                    className="btn btn-ghost"
                    href={`#/${material.skill}?${new URLSearchParams({ work: learner.work.id, date: String(learner.work.payload.date ?? "") })}`}
                  >
                    返回原复盘与证据
                  </a>
                </div>
              ))}
          </div>
        );
      })}
      <label className="field">
        <span>审校结论</span>
        <select
          aria-label="审校结论"
          value={verdict}
          disabled={busy}
          onChange={(event) => setVerdict(event.target.value as AnswerVerdict)}
        >
          <option value="key-correct">答案无误</option>
          <option value="key-wrong">答案有误</option>
          <option value="ambiguous">题目有歧义</option>
        </select>
      </label>
      {verdict === "key-wrong" && (
        <label className="field">
          <span>更正答案（每行一种可接受答案）</span>
          <textarea
            aria-label="更正答案"
            maxLength={2000}
            value={answers}
            disabled={busy}
            onChange={(event) => setAnswers(event.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>审校说明</span>
        <textarea
          aria-label="审校说明"
          maxLength={2000}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <label className="field">
        <span>审校者</span>
        <select
          aria-label="审校者"
          value={reviewer}
          disabled={busy}
          onChange={(event) =>
            setReviewer(event.target.value as "self" | "human")
          }
        >
          <option value="self">自己核对</option>
          <option value="human">真人审校</option>
        </select>
      </label>
      <button
        className="btn btn-primary"
        disabled={
          busy || !note.trim() || (verdict === "key-wrong" && !answers.trim())
        }
        onClick={() =>
          void onDecide(target, {
            verdict,
            correctedAnswers:
              verdict === "key-wrong" ? answers.split(/\r?\n/) : [],
            note,
            reviewer,
          })
        }
      >
        保存审校结论
      </button>
    </article>
  );
}
