import { useEffect, useRef, useState } from "react";
import { go } from "../../../lib/router";
import { saveMission, selectMission } from "../../missionRecords";
import type { Revision } from "../../protocol";
import {
  getLearningState,
  removeRecord,
  type LearningState,
} from "../../repository";
import {
  newSpeakingDraft,
  rerecordSpeaking,
  speakingDraftFromRevision,
  speakingPart,
  type SpeakingDraft,
  type SpeakingPart,
} from "../../speakingModel";
import {
  availableSpeakingMaterials,
  type SpeakingContext,
} from "../../speakingTasks";
import { RecordingPlayer } from "./RecordingPlayer";
import { SpeakingQuestionEditor } from "./SpeakingQuestionEditor";
import { RecordingsBackup } from "../RecordingsBackup";
import { listSpeakingWorks } from "../../speakingList";
import { SpeakingWorkList } from "./SpeakingWorkList";
function seedFor(
  plan: Revision,
  context: SpeakingContext,
  part: SpeakingPart,
  index = 0,
): SpeakingDraft {
  const material = availableSpeakingMaterials(context.day).find(
      (value) => value.part === part,
    ),
    id = crypto.randomUUID();
  return newSpeakingDraft({
    id,
    planId: plan.id,
    date: context.date,
    day: context.day,
    taskId: context.taskId,
    part,
    prompt: material?.prompts[index] ?? "",
    contentId: material?.id ?? `external-${context.date}-${id}`,
    contentVersion: material?.version,
  });
}
export function SpeakingSession({
  plan,
  context,
  learning,
  initialWorkId,
}: {
  plan: Revision;
  context: SpeakingContext;
  learning: LearningState;
  initialWorkId?: string;
}) {
  const works = listSpeakingWorks(learning.records, plan.id);
  const initial = works.find((work) => work.id === initialWorkId);
  const [selected, setSelected] = useState<Revision | null>(initial ?? null),
    [part, setPart] = useState<SpeakingPart>(
      speakingPart(initial?.payload.part) ?? context.defaultPart,
    ),
    [question, setQuestion] = useState(0),
    [dirty, setDirty] = useState(false),
    [deleting, setDeleting] = useState(false),
    [message, setMessage] = useState("");
  const [seed, setSeed] = useState(() =>
    initial && speakingPart(initial.payload.part)
      ? speakingDraftFromRevision(initial)
      : seedFor(plan, context, context.defaultPart),
  );
  const pendingSeconds = useRef(new Map<string, number>()),
    inFlight = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [learning.userId]);
  const liveSelected = selected
    ? (works.find((work) => work.id === selected.id) ?? selected)
    : null;
  const routeRestored = useRef(!!initial);
  useEffect(() => {
    if (routeRestored.current || !initialWorkId || !initial) return;
    routeRestored.current = true;
    setSelected(initial);
    const value = speakingPart(initial.payload.part);
    if (value) {
      setPart(value);
      setSeed(speakingDraftFromRevision(initial));
    }
  }, [initialWorkId, initial?.revisionId]);
  const updateMission = async (status: "partial" | "completed") => {
    if (!context.block) return;
    const state = getLearningState();
    if (state.userId !== learning.userId)
      throw new Error("账号已经切换，请在原账号继续。");
    const old = selectMission(
        state.records,
        plan.id,
        context.date,
        context.taskId,
      ),
      pending = [...pendingSeconds.current.values()].reduce(
        (sum, value) => sum + value,
        0,
      );
    const recorded = state.records.filter(
      (work) =>
        work.kind === "speaking" &&
        work.planId === plan.id &&
        work.payload.date === context.date &&
        work.payload.taskId === context.taskId &&
        !work.deleted &&
        !work.conflict,
    );
    const prior =
      typeof old?.payload.actualMinutes === "number"
        ? old.payload.actualMinutes
        : recorded.reduce(
            (sum, work) =>
              sum +
              Number(work.payload.durationSeconds ?? 0) +
              Number(work.payload.prepSeconds ?? 0),
            0,
          ) /
            60 -
          pending / 60;
    await saveMission({
      planId: plan.id,
      day: context.day,
      date: context.date,
      block: context.block,
      status: old?.payload.status === "completed" ? "completed" : status,
      actualMinutes: Math.max(0, prior) + pending / 60,
      timeSource: "timer",
      expectedUserId: learning.userId,
    });
    pendingSeconds.current.clear();
  };
  const saved = async (work: Revision, seconds: number, isNew: boolean) => {
    setSelected(work);
    if (isNew) pendingSeconds.current.set(work.id, seconds);
    await updateMission("partial");
  };
  const choosePart = (value: SpeakingPart, index = 0) => {
    setPart(value);
    setQuestion(index);
    setSelected(null);
    setSeed(seedFor(plan, context, value, index));
    setMessage("");
  };
  const open = (work: Revision) => {
    setSelected(work);
    const value = speakingPart(work.payload.part);
    if (value) {
      setPart(value);
      setSeed(speakingDraftFromRevision(work));
    }
    go({
      page: "speaking",
      work: work.id,
      date: String(work.payload.date ?? context.date),
      ...(typeof work.payload.day === "number"
        ? { day: work.payload.day }
        : {}),
      ...(typeof work.payload.taskId === "string"
        ? { task: work.payload.taskId }
        : {}),
    });
  };
  const material = availableSpeakingMaterials(context.day).find(
    (value) => value.part === part,
  );
  const savedQuestionIndex =
    material && selected
      ? material.prompts.indexOf(String(selected.payload.prompt))
      : -1;
  const currentQuestion =
    savedQuestionIndex >= 0 ? savedQuestionIndex : question;
  const finish = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await updateMission("completed");
      setMessage("本次口语任务已完成，实际用时已记录。");
    } catch (error) {
      setMessage(
        `任务未保存：${error instanceof Error ? error.message : "请重试。"}`,
      );
    } finally {
      inFlight.current = false;
    }
  };
  const remove = async () => {
    if (inFlight.current || dirty || !liveSelected) return;
    if (
      !window.confirm(
        "删除这份作答？本机录音、历史版本和备份信息仍保留；删除作答不会释放音频占用的空间。",
      )
    )
      return;
    inFlight.current = true;
    setDeleting(true);
    setMessage("");
    try {
      const state = getLearningState();
      if (state.userId !== learning.userId)
        throw new Error("账号已经切换，请在原账号继续。");
      const current = state.records.find(
        (record) =>
          record.id === liveSelected.id && !record.deleted && !record.conflict,
      );
      if (!current || current.revisionId !== liveSelected.revisionId)
        throw new Error("作答版本已变化，请重新打开后再删除。");
      await removeRecord(current.id);
      if (alive.current && getLearningState().userId === learning.userId) {
        setSelected(null);
        setSeed(seedFor(plan, context, part));
        setMessage("作答已删除；本机录音、历史版本和备份信息仍保留。");
      }
    } catch (error) {
      if (alive.current)
        setMessage(
          `删除未保存：${error instanceof Error ? error.message : "请重试。"}`,
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setDeleting(false);
    }
  };
  return (
    <div className="page">
      <section
        className="panel"
        aria-label="口语练习"
        data-testid="speaking-workbench"
      >
        <p className="eyebrow">365天训练 · {context.date}</p>
        <h1>口语练习</h1>
        <p>
          本块计划 {context.plannedMinutes}{" "}
          分钟。每题独立保存，最后再完成本次任务。
        </p>
        <a href="#/">返回今日</a>
        {context.block || selected ? (
          <>
            <label className="field">
              <span>口语部分</span>
              <select
                aria-label="口语部分"
                value={part}
                disabled={dirty || deleting}
                onChange={(event) =>
                  choosePart(Number(event.target.value) as SpeakingPart)
                }
              >
                <option value={1}>Part 1</option>
                <option value={2}>Part 2</option>
                <option value={3}>Part 3</option>
              </select>
            </label>
            {!selected && material && (
              <label
                style={{
                  display: "block",
                  width: "100%",
                  minWidth: 0,
                  maxWidth: "100%",
                }}
              >
                本组题目
                <select
                  aria-label="本组题目"
                  style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
                  value={question}
                  disabled={dirty || deleting}
                  onChange={(event) =>
                    choosePart(part, Number(event.target.value))
                  }
                >
                  {material.prompts.map((prompt, index) => (
                    <option key={index} value={index}>
                      第{index + 1}题 · {prompt}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {deleting ? (
              <p role="status">正在删除作答…</p>
            ) : liveSelected && !speakingPart(liveSelected.payload.part) ? (
              <>
                <h2>Part未知 · 旧作答只读</h2>
                <p>{String(liveSelected.payload.prompt ?? "")}</p>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {String(liveSelected.payload.transcript ?? "")}
                </p>
              </>
            ) : (
              <SpeakingQuestionEditor
                key={seed.id}
                plan={plan}
                context={context}
                seed={seed}
                initialWork={liveSelected ?? undefined}
                userId={learning.userId}
                onDirty={setDirty}
                onSaved={saved}
              />
            )}
            {selected && speakingPart(selected.payload.part) && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={dirty || deleting}
                onClick={() => {
                  const next = rerecordSpeaking(liveSelected!);
                  if (context.correctionId) Object.assign(next, { correctionId: context.correctionId, date: context.date, day: context.day, taskId: context.taskId });
                  setSeed(next);
                  setSelected(null);
                  setMessage("上一版仍保留，这次是新的作答。");
                }}
              >
                重录这题
              </button>
            )}
            {selected && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={dirty || deleting}
                onClick={() => {
                  void remove();
                }}
              >
                删除作答
              </button>
            )}
            {material && currentQuestion + 1 < material.prompts.length && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={dirty || deleting}
                onClick={() => choosePart(part, currentQuestion + 1)}
              >
                下一题
              </button>
            )}
            {seed.parentRevisionId &&
              works.find(
                (work) => work.revisionId === seed.parentRevisionId,
              ) && (
                <section className="panel" aria-label="上一版口语作答">
                  <h3>上一版作答</h3>
                  <p>
                    {String(
                      works.find(
                        (work) => work.revisionId === seed.parentRevisionId,
                      )!.payload.transcript ?? "转写为空",
                    )}
                  </p>
                  <RecordingPlayer
                    work={works.find(
                      (work) => work.revisionId === seed.parentRevisionId,
                    )!}
                  />
                </section>
              )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                dirty ||
                deleting ||
                !context.block ||
                !works.some(
                  (work) =>
                    work.payload.taskId === context.taskId &&
                    work.payload.date === context.date,
                )
              }
              onClick={() => {
                void finish();
              }}
            >
              完成本次口语
            </button>
          </>
        ) : (
          <p>今天没有口语任务，可以查看已保存的作答。</p>
        )}
        {dirty && (
          <p className="muted">有未保存的转写或计时，请先保存作答再切换。</p>
        )}
        {message && <p role="status">{message}</p>}
        <details>
          <summary>过渡句练习卡</summary>
          <p>只用来帮助组织回答，不背整段模板。</p>
          <ul>
            <li>开头：Let me think for a moment.</li>
            <li>举例：For instance, ...</li>
            <li>转折：On the other hand, ...</li>
            <li>总结：Overall, I would say ...</li>
          </ul>
        </details>
      </section>
      <SpeakingWorkList
        works={works}
        records={learning.records}
        disabled={dirty || deleting}
        onOpen={open}
      />
      <section className="panel" aria-label="口语录音保存说明">
        <h2>本机录音与备份</h2>
        <p>
          题目、手动转写和反馈会随账号同步。音频只保存在录制或导入它的设备浏览器里，不会上传到服务器。
        </p>
        <p>
          换设备回听时，请先在保留录音的设备导出
          ZIP，再到另一设备导入。建议定期把 ZIP 保存到浏览器以外的位置。
        </p>
        <p>
          清除浏览器数据、重装浏览器或使用临时浏览模式可能丢失本机录音；没有 ZIP
          或另一设备的副本时无法恢复。删除作答仍保留录音和备份信息，不会释放音频占用的空间。
        </p>
      </section>
      <RecordingsBackup />
    </div>
  );
}
