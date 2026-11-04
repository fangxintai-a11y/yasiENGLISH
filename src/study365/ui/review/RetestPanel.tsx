import { resolvePracticeContext } from "../../listeningReadingTasks";
import { currentAttempts } from "../../readingModel";
import { useRef, useState } from "react";
import type { Revision } from "../../protocol";
import type { DayPlan } from "../../planEngine";
import type { LocalMaterial } from "../../localBankSchema";
import {
  selectRetest,
  evaluateRetest,
  type RetestPrompt,
  type RetestContext,
} from "../../retestSelection";
import { getLearningState, saveRecord } from "../../repository";
import { withRevisionReferences } from "../../revisionReferences";
import {
  missionTaskId,
  selectMission,
  saveMission,
} from "../../missionRecords";
import type { CorrectionPayload } from "../../correctionModel";
const labels: Record<string, string> = {
  reading: "阅读",
  listening: "听力",
  writing: "写作",
  speaking: "口语",
};
interface Props {
  plan: Revision;
  dayPlan: DayPlan;
  records: readonly Revision[];
  bank: readonly LocalMaterial[];
  prompts: readonly RetestPrompt[];
  userId: string | null;
  questionResultsFor?: (work: Revision) => RetestContext["questionResults"];
}
export function RetestPanel(props: Props) {
  const corrections = props.records.filter(
    (r) =>
      r.kind === "correction" &&
      r.planId === props.plan.id &&
      !r.deleted &&
      !r.conflict &&
      (r.payload as CorrectionPayload).items.some(
        (item) =>
          item.status === "corrected" || item.status.startsWith("retested-"),
      ),
  );
  return (
    <section className="panel" aria-label="跨天新题复测">
      <h2>跨天新题复测</h2>
      <p>
        完成整轮订正至少隔一个自然日，再用同型未见新题。复测使用当天对应科目的已有预算；听读完成首答和A-B复盘后判定，写说需保存同稿自查或反馈。通过只代表本轮修正。
      </p>
      {!corrections.length && <p>完成订正后，这里显示隔天复测与缺口。</p>}
      {corrections.map((correction) => (
        <RetestRound key={correction.id} {...props} correction={correction} />
      ))}
    </section>
  );
}
function RetestRound({
  plan,
  dayPlan,
  records,
  bank,
  prompts,
  userId,
  questionResultsFor,
  correction,
}: Props & { correction: Revision }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const context: RetestContext = {
    planId: plan.id,
    date: dayPlan.date,
    day: dayPlan.day,
    records: withRevisionReferences(records),
    materials: bank,
    prompts,
  };
  const selected = selectRetest(correction, context),
    skill = String(correction.payload.skill),
    block = dayPlan.blocks.find((item) => item.skill === skill),
    taskId = block ? missionTaskId(dayPlan.day, block.id) : "";
  const used = block
    ? Number(
        selectMission(records, plan.id, dayPlan.date, taskId)?.payload
          .actualMinutes ?? 0,
      )
    : 0;
  const fits =
    !!block &&
    selected.estimatedMinutes !== null &&
    selected.estimatedMinutes <= Math.max(0, block.minutes - used);
  const material = selected.material,
    materialKey = material
      ? `${material.id}@${material.version}@${material.contentHash}`
      : "";
  const href =
    material && selected.retestOf && fits
      ? `#/${skill}?${new URLSearchParams({ material: materialKey, correctionId: correction.id, retestOf: selected.retestOf, date: dayPlan.date, day: String(dayPlan.day), task: taskId })}`
      : undefined;
  const attempts = records.filter(
    (r) =>
      r.planId === plan.id &&
      !r.deleted &&
      !r.conflict &&
      ["attempt", "essay", "speaking"].includes(r.kind) &&
      r.payload.correctionId === correction.id &&
      r.payload.retestOf,
  );
  const evaluate = async (work: Revision) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    let resultSaved = false;
    try {
      const state = getLearningState();
      if (!state.ready || state.userId !== userId)
        throw new Error("账号已经切换，请重新打开复测。");
      const current = state.records.find(
          (r) => r.id === correction.id && !r.conflict,
        ),
        actual = state.records.find((r) => r.id === work.id && !r.conflict);
      if (!current || !actual) throw new Error("记录已变化，请重新打开。");
      const result = evaluateRetest(current, actual, {
        ...context,
        records: withRevisionReferences(state.records),
        ...(questionResultsFor
          ? { questionResults: questionResultsFor(actual) }
          : {}),
      });
      if (result.pending) throw new Error(result.pending);
      if (result.nextRound) {
        if (getLearningState().userId !== userId)
          throw new Error("账号已经切换，下一轮订正保留后重试。");
        if (
          !getLearningState().records.some(
            (r) => r.id === result.nextRound!.id && !r.conflict,
          )
        )
          await saveRecord({ ...result.nextRound, baseRevision: null });
      }
      if (getLearningState().userId !== userId)
        throw new Error("账号已经切换，订正原状态保留。");
      await saveRecord({
        id: current.id,
        kind: "correction",
        payload: result.payload,
        baseRevision: current.revisionId,
      });
      resultSaved = true;
      if (
        actual.kind === "attempt" &&
        (actual.payload.skill === "reading" ||
          actual.payload.skill === "listening")
      ) {
        const fresh = getLearningState();
        const workContext = resolvePracticeContext(
          plan,
          fresh.records,
          {
            date: String(actual.payload.date),
            day: Number(actual.payload.day),
            task: String(actual.payload.taskId),
          },
          actual.payload.skill,
        );
        if (workContext.block) {
          const old = selectMission(
            fresh.records,
            plan.id,
            workContext.date,
            workContext.taskId,
          );
          const minutes = currentAttempts(fresh.records, plan.id)
            .filter(
              (r) =>
                r.payload.date === workContext.date &&
                r.payload.taskId === workContext.taskId,
            )
            .reduce((sum, r) => sum + Number(r.payload.actualMinutes ?? 0), 0);
          await saveMission({
            planId: plan.id,
            date: workContext.date,
            day: workContext.day,
            block: workContext.block,
            status:
              old?.payload.status === "completed" ? "completed" : "partial",
            actualMinutes: Math.max(
              Number(old?.payload.actualMinutes ?? 0),
              minutes,
            ),
            timeSource: "timer",
            expectedUserId: userId,
          });
        }
      }
      setMessage(
        `${result.outcomes.some((item) => item.status === "retested-fail") ? "复测未通过，已建立下一轮订正" : "本轮复测通过"}${result.estimate ? "（自评／机器反馈，估分）" : ""}；原分、门槛和目标差距不变。`,
      );
    } catch (e) {
      setError(
        (resultSaved ? "复测结果已保存；任务计时未更新。" : "") +
          (e instanceof Error ? e.message : "复测结果未保存。"),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <article
      data-retest-correction-id={correction.id}
      style={{ minWidth: 0, overflowWrap: "anywhere", marginTop: 20 }}
    >
      <h3>
        {labels[skill]} · {String(correction.payload.date)}订正
      </h3>
      <p>{selected.notice}</p>
      {material && (
        <>
          <p>新题：{"title" in material ? material.title : material.prompt}</p>
          <p>
            预计 {selected.estimatedMinutes} 分钟；当天{labels[skill]}块剩余{" "}
            {Math.max(0, (block?.minutes ?? 0) - used).toFixed(1)} 分钟。
          </p>
          {!fits && (
            <p role="status">
              当天对应科目预算不足，留到能容纳的同科任务；不挪其他科目分钟。
            </p>
          )}
          <a className="btn btn-primary" aria-disabled={!href} href={href}>
            开始这份新题复测
          </a>
        </>
      )}
      {attempts.map((work) => {
        const result = evaluateRetest(correction, work, {
          ...context,
          ...(questionResultsFor
            ? { questionResults: questionResultsFor(work) }
            : {}),
        });
        return (
          <div key={work.id} data-retest-work-id={work.id}>
            <p>
              已保存复测：{String(work.payload.date)} · {work.id}
            </p>
            {result.pending ? (
              <p>{result.pending}</p>
            ) : (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void evaluate(work)}
              >
                记录本次复测结果
              </button>
            )}
          </div>
        );
      })}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
