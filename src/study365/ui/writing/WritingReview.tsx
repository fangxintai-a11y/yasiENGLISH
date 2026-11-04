import { Fragment, useEffect, useRef, useState } from "react";
import type { WritingResult } from "../../../ielts/scoring";
import type { Revision } from "../../protocol";
import {
  getLearningState,
  saveRecord,
  useLearning,
  type LearningState,
} from "../../repository";
import {
  buildSelfReviewPayload,
  checkedSpelling,
  feedbackForWork,
  restoreSelfReview,
  runWritingRules,
  spellingTokens,
  toggleSpelling,
  type SelfReview,
} from "../../writingReview";
import {
  WRITING_DIMENSION_LABELS,
  WRITING_RUBRIC_SOURCE,
  writingCauseOptions,
  writingRubric,
} from "../../writingRubric";

export function WritingReview(props: {
  work: Revision;
  materialSelfCheck?: string[];
  onSaved?: () => void;
}) {
  const learning = useLearning();
  return (
    <ReviewBody
      key={`${learning.userId ?? "guest"}:${props.work.revisionId}`}
      {...props}
      learning={learning}
    />
  );
}
function ReviewBody({
  work,
  materialSelfCheck = [],
  onSaved,
  learning,
}: {
  work: Revision;
  materialSelfCheck?: string[];
  onSaved?: () => void;
  learning: LearningState;
}) {
  const existing = feedbackForWork(learning.records, work).find(
    (record) => record.payload.source === "self",
  );
  const [state, setState] = useState<SelfReview>(() =>
    restoreSelfReview(work, existing),
  );
  const [result, setResult] = useState<WritingResult | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<{ start: number; end: number } | null>(
    null,
  );
  const dirty = useRef(false),
    alive = useRef(true),
    original = useRef<HTMLDivElement>(null);
  const taskType = work.payload.taskType as "task1" | "task2",
    text = String(work.payload.text ?? ""),
    userId = learning.userId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dirty.current) setState(restoreSelfReview(work, existing));
  }, [existing?.revisionId, work.revisionId]);
  useEffect(() => {
    let active = true;
    void runWritingRules(work)
      .then(async (value) => {
        if (!active || getLearningState().userId !== userId) return;
        setResult(value.result);
        if (!existing && !dirty.current)
          setState((previous) => ({
            ...previous,
            errorCauses: [...value.result.causes],
          }));
        if (
          !feedbackForWork(getLearningState().records, work).some(
            (record) => record.payload.source === "rules",
          )
        )
          await saveRecord({
            id: `rules-${work.revisionId}`,
            kind: "feedback",
            payload: value.payload,
          });
      })
      .catch((error) => {
        if (active)
          setMessage(
            `本地体检未保存：${error instanceof Error ? error.message : "请重试。"}`,
          );
      });
    return () => {
      active = false;
    };
  }, [work.revisionId, userId]);
  const update = (change: (value: SelfReview) => SelfReview) => {
    dirty.current = true;
    setState(change);
    setMessage("自查有未保存的修改。");
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const payload = await buildSelfReviewPayload(work, state);
      if (getLearningState().userId !== userId)
        throw new Error("账号已经切换，请回原账号继续自查。");
      await saveRecord({
        id: existing?.id ?? `self-${work.revisionId}`,
        kind: "feedback",
        payload,
      });
      if (alive.current) {
        dirty.current = false;
        setMessage("自查已保存在本机，联网后自动同步。");
        onSaved?.();
      }
    } catch (error) {
      if (alive.current)
        setMessage(
          `自查未保存：${error instanceof Error ? error.message : "请重试。"}`,
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const tokens = spellingTokens(text);
  let cursor = 0;
  return (
    <section className="panel" aria-label="写作体检与自查">
      <h2>本地文本体检</h2>
      <p className="muted">查看指标与原文证据，逐项核对。</p>
      {!result && <p>正在读取本地体检…</p>}
      {result &&
        Object.entries(result.criteria).map(([dimension, criterion]) => (
          <div key={dimension}>
            <h3>{WRITING_DIMENSION_LABELS[dimension]}</h3>
            <ul>
              {criterion.evidence.map((evidence, index) => (
                <li key={index}>
                  {evidence.kind === "span" ? (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setFocus({
                          start: evidence.start!,
                          end: evidence.end!,
                        });
                        original.current?.scrollIntoView({ block: "center" });
                      }}
                    >
                      {evidence.message} · 定位原文
                    </button>
                  ) : (
                    evidence.message
                  )}
                  {evidence.kind === "metric" && (
                    <small>（{evidence.value}）</small>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      <h3>原稿与拼写检查</h3>
      <p className="muted">
        点击原文中拼错的词进行标记，再次点击取消。确认检查完后点击“拼写已检查”。
      </p>
      <div
        ref={original}
        aria-label="拼写标记原文"
        style={{ whiteSpace: "pre-wrap", lineHeight: 2 }}
      >
        {tokens.map((token) => {
          const before = text.slice(cursor, token.start);
          cursor = token.end;
          const marked = state.spellingCheck.items.some(
            (item) =>
              item.start === token.start &&
              item.end === token.end &&
              item.confirmed,
          );
          return (
            <Fragment key={token.start}>
              {before}
              <button
                type="button"
                data-start={token.start}
                aria-label={`标记拼写 ${token.text} ${token.start}`}
                aria-pressed={marked}
                onClick={() =>
                  update((previous) => ({
                    ...previous,
                    spellingCheck: toggleSpelling(
                      previous.spellingCheck,
                      token,
                    ),
                  }))
                }
                style={{
                  font: "inherit",
                  color: "inherit",
                  padding: 0,
                  border: 0,
                  borderBottom: marked
                    ? "2px solid #b42318"
                    : "2px solid transparent",
                  background:
                    focus && token.end > focus.start && token.start < focus.end
                      ? "#f8dc8d"
                      : "transparent",
                  cursor: "pointer",
                }}
              >
                {token.text}
              </button>
            </Fragment>
          );
        })}
        {text.slice(cursor)}
      </div>
      <p role="status">
        {state.spellingCheck.status === "unchecked"
          ? "拼写：未检查"
          : `拼写错误：${state.spellingCheck.count}处`}
      </p>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() =>
          update((previous) => ({
            ...previous,
            spellingCheck: checkedSpelling(previous.spellingCheck),
          }))
        }
      >
        拼写已检查
      </button>
      <h3>逐项自查</h3>
      <p className="muted">
        参照7–8分要求整理的练习提示。
        <a href={WRITING_RUBRIC_SOURCE} target="_blank" rel="noreferrer">
          官方评分描述
        </a>
      </p>
      {writingRubric(taskType).map((item) => (
        <label key={item.id} style={{ display: "block", margin: "10px 0" }}>
          <input
            type="checkbox"
            aria-label={item.id}
            checked={state.checklist[item.id] === true}
            onChange={(event) =>
              update((previous) => ({
                ...previous,
                checklist: {
                  ...previous.checklist,
                  [item.id]: event.target.checked,
                },
              }))
            }
          />{" "}
          {WRITING_DIMENSION_LABELS[item.dimension]}：{item.label}
        </label>
      ))}
      {materialSelfCheck.length > 0 && (
        <>
          <h3>本题额外提示</h3>
          <ul>
            {materialSelfCheck.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      <h3>标注错因</h3>
      {writingCauseOptions(taskType).map((option) => (
        <label
          key={option.id}
          style={{ display: "inline-block", margin: "8px 12px 8px 0" }}
        >
          <input
            type="checkbox"
            checked={state.errorCauses.includes(option.id)}
            onChange={(event) =>
              update((previous) => ({
                ...previous,
                errorCauses: event.target.checked
                  ? [...new Set([...previous.errorCauses, option.id])]
                  : previous.errorCauses.filter((id) => id !== option.id),
              }))
            }
          />{" "}
          {option.label}
        </label>
      ))}
      {state.errorCauses.includes("other") && (
        <label>
          其他错因说明
          <textarea
            aria-label="其他错因说明"
            value={state.otherExplanation}
            maxLength={2000}
            onChange={(event) =>
              update((previous) => ({
                ...previous,
                otherExplanation: event.target.value,
              }))
            }
          />
        </label>
      )}
      <h3>自评（可留空）</h3>
      <p className="muted">只属于这一版作品的自我判断。</p>
      {Object.keys(state.bands).map((key) => (
        <label key={key} style={{ display: "block", margin: "10px 0" }}>
          {WRITING_DIMENSION_LABELS[key]}{" "}
          <select
            aria-label={`自评${WRITING_DIMENSION_LABELS[key]}`}
            value={state.bands[key] ?? ""}
            onChange={(event) =>
              update((previous) => ({
                ...previous,
                bands: {
                  ...previous.bands,
                  [key]:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                },
              }))
            }
          >
            <option value="">未评估</option>
            {Array.from({ length: 19 }, (_, index) => index / 2).map(
              (value) => (
                <option key={value} value={value}>
                  {value.toFixed(1)}
                </option>
              ),
            )}
          </select>
        </label>
      ))}
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => {
          void save();
        }}
      >
        {busy ? "保存中…" : "保存自查"}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
