import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalMaterial } from "../../localBankSchema";
import { ADJUSTMENT_ACTION_LABELS } from "../../adjustmentRules";
import { CALIBRATION_DIMENSION_LABELS } from "../../calibration";
import { LR_CAUSE_LABELS } from "../../readingReview";
import { getLearningState, saveRecord } from "../../repository";
import { canonical, isObject, type Revision } from "../../protocol";
import { SKILLS, SKILL_LABELS, sourceLabel } from "../../scoresModel";
import {
  acceptedMaterialPreferences,
  adjustmentForSuggestion,
  adjustmentRecordsForWeek,
  adjustmentRecordId,
  buildAdjustmentPayload,
  buildWeeklyReview,
  originalReviewCorrection,
  type AdjustmentSuggestion,
  type WeeklyReviewInput,
} from "../../weeklyReview";

export interface WeeklyReviewProps {
  plan: Revision;
  records: readonly Revision[];
  bank: readonly LocalMaterial[];
  date: string;
  userId: string | null;
  statisticsRecords?: WeeklyReviewInput["statisticsRecords"];
  officialCalibration?: WeeklyReviewInput["officialCalibration"];
}
const decisions = { accepted: "已采纳", rejected: "未采纳", pending: "待决定" };
const statuses: Record<string, string> = {
  open: "待订正",
  corrected: "已订正，待隔天新题复测",
  "retested-pass": "本轮复测通过",
  "retested-fail": "本轮复测未通过",
  dropped: "已放弃并留有说明",
};
const estimateLabels = { self: "自评", ai: "AI估分", rules: "规则估分" };
const taskLabels = {
  task1: "写作 Task 1",
  task2: "写作 Task 2",
  speaking: "口语",
};
const percent = (value: number | null) =>
  value === null ? "暂无已完成样本" : `${(value * 100).toFixed(1)}%`;
const metricLabels: Record<string, string> = {
  "type-accuracy-percent": "题型正确率（%）",
  "error-cause-count": "错因次数",
  "consecutive-retest-fails": "连续复测失败轮数",
  "calibration-delta": "同稿估分与真人分差",
};
const wrapping = {
  minWidth: 0,
  maxWidth: "100%",
  overflowWrap: "anywhere" as const,
};

/** A scope change remounts the panel so an old account's async action cannot paint this account. */
export function WeeklyReview(props: WeeklyReviewProps) {
  return (
    <WeeklyReviewPanel
      key={`${props.userId ?? "guest"}:${props.plan.id}:${props.date}`}
      {...props}
    />
  );
}
function WeeklyReviewPanel(props: WeeklyReviewProps) {
  const {
    plan,
    records,
    bank,
    date,
    userId,
    statisticsRecords,
    officialCalibration,
  } = props;
  const result = useMemo(() => {
    try {
      return {
        model: buildWeeklyReview({
          plan,
          records,
          bank,
          date,
          statisticsRecords,
          officialCalibration,
        }),
        error: "",
      };
    } catch (error) {
      return {
        model: null,
        error: error instanceof Error ? error.message : "本周汇总暂不可用。",
      };
    }
  }, [plan, records, bank, date, statisticsRecords, officialCalibration]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const alive = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const check = () => {
    const current = getLearningState();
    if (
      !alive.current ||
      !current.ready ||
      current.userId !== userId ||
      !current.records.some(
        (record) =>
          record.id === plan.id &&
          record.kind === "plan" &&
          !record.deleted &&
          !record.conflict,
      )
    )
      throw new Error("账号或计划已经切换，请重新进入本周校准。");
    return current;
  };
  const saveOriginalTask = async (
    suggestion: AdjustmentSuggestion,
    adjustment: Revision,
  ) => {
    const current = check(),
      model = buildWeeklyReview({
        plan,
        records: current.records,
        bank,
        date,
        statisticsRecords,
        officialCalibration,
      }),
      issue = model.calibrationIssues.find(
        (item) => item.suggestionId === suggestion.id,
      );
    if (!issue)
      throw new Error("这份原稿的校准证据已经变化，请先查看最新汇总。");
    const draft = originalReviewCorrection(issue, adjustment, {
      plan,
      records: current.records,
      date,
    });
    if (draft) {
      check();
      await saveRecord(draft);
    }
    check();
  };
  const decide = async (
    suggestion: AdjustmentSuggestion,
    decision: "accepted" | "rejected",
  ) => {
    if (!result.model || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    let decisionSaved = false;
    try {
      const current = check(),
        fresh = buildWeeklyReview({
          plan,
          records: current.records,
          bank,
          date,
          statisticsRecords,
          officialCalibration,
        });
      const measured = fresh.suggestions.find(
        (item) => item.id === suggestion.id,
      );
      if (
        decision === "accepted" &&
        (!measured || canonical(measured) !== canonical(suggestion))
      )
        throw new Error("建议证据已经变化，请先查看更新后的建议再采纳。");
      const existing = adjustmentForSuggestion(
        current.records,
        plan.id,
        fresh.weekIndex,
        suggestion.id,
      );
      const id =
        existing?.id ??
        adjustmentRecordId(plan.id, fresh.weekIndex, suggestion.id);
      const occupied = current.records.find((record) => record.id === id);
      if (
        occupied &&
        (occupied.kind !== "adjustment" || occupied.planId !== plan.id)
      )
        throw new Error("建议记录标识不匹配，未覆盖已有记录。");
      const payload = buildAdjustmentPayload(
        plan.id,
        fresh.weekIndex,
        date,
        suggestion,
        decision,
        Date.now(),
      );
      const saved = await saveRecord({
        id,
        kind: "adjustment",
        payload,
        baseRevision: existing?.revisionId ?? null,
      });
      decisionSaved = true;
      check();
      if (decision === "accepted" && suggestion.action === "review-original")
        await saveOriginalTask(suggestion, saved);
      if (alive.current)
        setMessage(
          decision === "accepted"
            ? suggestion.action === "review-original"
              ? "已采纳，并建立原稿复核订正；完成后仍需隔天新题复测。"
              : suggestion.action === "request-human-calibration"
                ? "已保存真人校准建议；请自行带原稿处理，不自动发送，也不改学习分钟。"
                : "已采纳；下周仅按建议调整选材或订正顺序，时长不变。"
            : "已记为不采纳；这条建议不进入下周选材。",
        );
    } catch (cause) {
      if (alive.current)
        setError(
          (decisionSaved
            ? "决定已保存；后续原稿复核任务尚未完成，可在该建议重试。"
            : "") +
            (cause instanceof Error ? cause.message : "决定未保存，请重试。"),
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const retryOriginal = async (suggestion: AdjustmentSuggestion) => {
    if (!result.model || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const current = check(),
        saved = adjustmentForSuggestion(
          current.records,
          plan.id,
          result.model.weekIndex,
          suggestion.id,
        );
      if (!saved || saved.payload.decision !== "accepted")
        throw new Error("请先采纳这条复核原稿建议。");
      await saveOriginalTask(suggestion, saved);
      if (alive.current) setMessage("原稿复核订正已建立，可在订正队列继续。");
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : "原稿复核未建立。");
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  if (!result.model)
    return (
      <section className="panel" aria-label="本周校准" style={wrapping}>
        <h2>本周校准</h2>
        <p>{result.error}</p>
      </section>
    );
  const model = result.model,
    preferences = acceptedMaterialPreferences(
      records,
      plan.id,
      model.weekIndex,
    );
  const saved = adjustmentRecordsForWeek(records, plan.id, model.weekIndex);
  const proposals = new Map(
    model.suggestions.map((suggestion) => [suggestion.id, suggestion]),
  );
  for (const record of saved)
    for (const item of record.payload.suggestions as unknown[])
      if (
        isObject(item) &&
        typeof item.id === "string" &&
        !proposals.has(item.id)
      )
        proposals.set(item.id, item as unknown as AdjustmentSuggestion);
  return (
    <section className="panel" aria-label="本周校准" style={wrapping}>
      <h2>第 {model.weekIndex} 周：本周校准与调整</h2>
      <p>
        近28天统计：{model.since} 至 {date}
        。每7个训练日的汇总与登记使用原15分钟校准块，订正使用原复盘块；每天仍为120分钟。
      </p>
      <h3>门槛有效分差</h3>
      <ul>
        {SKILLS.map((skill) => (
          <li key={skill}>
            {SKILL_LABELS[skill]}：
            {model.scores[skill]
              ? `${model.scores[skill]!.score.toFixed(1)}（${sourceLabel(model.scores[skill]!.source, skill)}）· 差距 ${model.gaps[skill]!.toFixed(1)}`
              : "未评估"}
          </li>
        ))}
      </ul>
      <p>
        {model.recommendedSkill
          ? `当前有效分差最大：${SKILL_LABELS[model.recommendedSkill]}；具体调整仍以题型和错因证据为准。`
          : "尚无门槛合格成绩，不预设弱科。"}
      </p>
      <details>
        <summary>近28天题型、错因与订正复测</summary>
        {model.summaries.map((summary) => {
          const correction = model.correctionStatistics.find(
            (row) => row.skill === summary.skill,
          )!;
          return (
            <section
              key={summary.skill}
              aria-label={`${SKILL_LABELS[summary.skill]}周统计`}
            >
              <h4>{SKILL_LABELS[summary.skill]}</h4>
              {summary.types.length ? (
                <ul>
                  {summary.types.map((row) => (
                    <li key={row.type}>
                      {row.type === "unknown" ? "题型待确认" : row.type}：
                      {row.correct}/{row.total}（{percent(row.accuracy)}）
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无可统计的题型作答。</p>
              )}
              {summary.causes.length ? (
                <ul>
                  {summary.causes.map((row) => (
                    <li key={row.errorCause}>
                      {LR_CAUSE_LABELS[row.errorCause] ?? row.errorCause}：
                      {row.count}次
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无已确认错因；存疑或待补错因不会冒作已确认。</p>
              )}
              <p>
                订正完成 {correction.completed}/{correction.total} ·
                本轮复测通过 {correction.passed}/{correction.retested}（
                {percent(correction.retestPassRate)}）。
              </p>
            </section>
          );
        })}
        <p>
          写说自评和自动反馈仍为估分。订正与复测通过只代表本轮训练，不改变门槛分和距8.0的差距。
        </p>
      </details>
      <details>
        <summary>官方题型首答校准（累计）</summary>
        {model.officialCalibration.length ? (
          <ul>
            {model.officialCalibration.map((row) => (
              <li key={`${row.skill}:${row.questionType}`}>
                {SKILL_LABELS[row.skill]} · {row.questionType}：{row.correct}/
                {row.total}（{percent(row.accuracy)}）
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无可用的官方题型首答校准。</p>
        )}
      </details>
      <h3>写说同稿校准偏差</h3>
      {!model.comparisons.length && (
        <p>近4周尚无可比较的同稿真人基准与估分配对。</p>
      )}
      {model.systematicBias.map((row) => (
        <p
          role="status"
          key={`${row.taskType}:${row.source}:${row.dimension}:${row.weeks[1]}`}
          style={{ color: "#b42318", fontWeight: 700 }}
        >
          {taskLabels[row.taskType]} ·{" "}
          {CALIBRATION_DIMENSION_LABELS[row.dimension] ?? row.dimension}：第
          {row.weeks[0]}、{row.weeks[1]}周的{estimateLabels[row.source]}
          连续同向偏差至少0.5，{estimateLabels[row.source]}系统性偏
          {row.direction === "high" ? "高" : "低"}。仅据这两周已返回的校准样本。
        </p>
      ))}
      {model.comparisons.map((comparison) => (
        <article
          key={`${comparison.workRevisionId}:${comparison.source}`}
          style={wrapping}
        >
          <p>
            第{comparison.weekIndex}周 · {taskLabels[comparison.taskType]} ·{" "}
            {estimateLabels[comparison.source]}：
            {comparison.differences
              .filter((row) => row.needsCalibration)
              .map(
                (row) =>
                  `${CALIBRATION_DIMENSION_LABELS[row.dimension] ?? row.dimension}比真人${row.delta > 0 ? "高" : "低"}${Math.abs(row.delta).toFixed(1)}`,
              )
              .join("；")}
          </p>
          <a
            href={`#/${comparison.taskType === "speaking" ? "speaking" : "writing"}?${new URLSearchParams({ work: comparison.workId })}`}
          >
            查看对应原稿
          </a>
        </article>
      ))}
      <h3>逐条决定</h3>
      <p>
        采纳后，下周只调整日常选材偏重和订正先后。提交真人校准只是一条建议，不会自动发送原稿。
      </p>
      {!proposals.size && <p>当前没有达到阈值的调整建议。</p>}
      {[...proposals.values()].map((suggestion) => {
        const existing = adjustmentForSuggestion(
            records,
            plan.id,
            model.weekIndex,
            suggestion.id,
          ),
          decision = existing?.payload.decision as
            keyof typeof decisions | undefined;
        const issue = model.calibrationIssues.find(
            (item) => item.suggestionId === suggestion.id,
          ),
          correction = issue
            ? records.find(
                (record) =>
                  record.kind === "correction" &&
                  !record.deleted &&
                  !record.conflict &&
                  record.planId === plan.id &&
                  record.payload.sourceRevisionId ===
                    issue.comparison.workRevisionId &&
                  ["essay", "speaking"].includes(
                    String(record.payload.sourceKind),
                  ),
              )
            : undefined;
        const correctionItem =
          correction && Array.isArray(correction.payload.items)
            ? (correction.payload.items.find(
                (item) =>
                  isObject(item) && item.dimension === suggestion.dimension,
              ) as { status?: string } | undefined)
            : undefined;
        return (
          <article
            key={suggestion.id}
            data-suggestion-id={suggestion.id}
            style={{
              ...wrapping,
              borderTop: "1px solid var(--line)",
              paddingBlock: 12,
            }}
          >
            <h4>
              {SKILL_LABELS[suggestion.skill]} ·{" "}
              {ADJUSTMENT_ACTION_LABELS[suggestion.action]}
            </h4>
            <p>{suggestion.reason}</p>
            <p>
              {metricLabels[suggestion.evidence.metric] ??
                suggestion.evidence.metric}
              ：{Number(suggestion.evidence.value.toFixed(2))} · 阈值{" "}
              {suggestion.evidence.threshold}
            </p>
            <details>
              <summary>
                查看证据（{suggestion.evidence.recordIds.length}条记录）
              </summary>
              <ul>
                {suggestion.evidence.recordIds.map((id) => (
                  <li key={id}>
                    <code
                      style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
                    >
                      {id}
                    </code>
                  </li>
                ))}
              </ul>
            </details>
            <p role="status">
              决定：{decision ? decisions[decision] : "待决定"}
            </p>
            <div className="data-actions">
              <button
                className="btn btn-primary"
                disabled={busy || decision === "accepted"}
                onClick={() => void decide(suggestion, "accepted")}
              >
                采纳
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy || decision === "rejected"}
                onClick={() => void decide(suggestion, "rejected")}
              >
                不采纳
              </button>
            </div>
            {suggestion.action === "review-original" &&
              decision === "accepted" && (
                <p>
                  原稿复核：
                  {correctionItem?.status ? (
                    (statuses[correctionItem.status] ?? "状态待确认")
                  ) : (
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => void retryOriginal(suggestion)}
                    >
                      重试建立复核订正
                    </button>
                  )}
                  {correction && (
                    <>
                      {" "}
                      <a
                        href={`#/review?${new URLSearchParams({ correctionId: correction.id })}`}
                      >
                        进入这条订正
                      </a>
                    </>
                  )}
                </p>
              )}
          </article>
        );
      })}
      {preferences.recordIds.length > 0 && (
        <p>
          本周正在执行 {preferences.recordIds.length}{" "}
          条上周采纳的选材或订正优先级调整；各科分钟不变。
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
