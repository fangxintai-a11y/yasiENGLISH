import { useEffect, useMemo, useRef, useState } from "react";
import { go, useLocation } from "../../../lib/router";
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
import { usePromptBank } from "../../usePromptBank";
import {
  promptKey,
  speakingWithPrompt,
  retestWorkId,
  matchesRetestWork,
  selectScheduledSpeakingPrompts,
  selectSpeakingPrompt,
  practicePrompts,
  selectIndependentPracticePrompt,
  unattemptedPrompts,
} from "../../promptWorkSelection";
import {
  automaticMaterialForTask,
  promptPoolForDay,
} from "../../dailyMaterialPlan";
import type { LocalPrompt } from "../../promptBankSchema";
import { PromptPicker } from "../prompts/PromptPicker";
import { speakingRetestDraft } from "../../retestWorkDrafts";
import { withRevisionReferences } from "../../revisionReferences";
function seedFor(
  plan: Revision,
  context: SpeakingContext,
  part: SpeakingPart,
  index = 0,
  assigned?: LocalPrompt | null,
): SpeakingDraft {
  const material =
      assigned === undefined
        ? availableSpeakingMaterials(context.day).find(
            (value) => value.part === part,
          )
        : undefined,
    id = crypto.randomUUID();
  return newSpeakingDraft({
    id,
    planId: plan.id,
    date: context.date,
    ...(context.day >= 1 && context.day <= 365 ? { day: context.day } : {}),
    taskId: context.taskId,
    part,
    prompt: assigned?.prompt ?? material?.prompts[index] ?? "",
    contentId: assigned?.id ?? material?.id ?? `external-${context.date}-${id}`,
    contentVersion: assigned?.version ?? material?.version,
    sourceRef: assigned?.sourceRef,
  });
}
type SessionProps = {
  plan: Revision;
  context: SpeakingContext;
  learning: LearningState;
  initialWorkId?: string;
};
export function SpeakingSession(props: SessionProps) {
  const { route } = useLocation();
  const selectedMaterial =
    route.page === "speaking" ? route.material : undefined;
  return (
    <SpeakingSessionEditor
      key={`${props.context.correctionId ?? ""}:${props.context.retestOf ?? ""}:${selectedMaterial ?? ""}`}
      {...props}
      selectedMaterial={selectedMaterial}
    />
  );
}
function SpeakingSessionEditor({
  plan,
  context,
  learning,
  initialWorkId,
  selectedMaterial,
}: {
  plan: Revision;
  context: SpeakingContext;
  learning: LearningState;
  initialWorkId?: string;
  selectedMaterial?: string;
}) {
  const retest = !!context.retestOf,
    promptBank = usePromptBank(learning.userId);
  const [retestReady, setRetestReady] = useState(!retest),
    [retestError, setRetestError] = useState("");
  const [automaticReady, setAutomaticReady] = useState(!!initialWorkId);
  const works = listSpeakingWorks(learning.records, plan.id);
  const scheduleInput = {
    prompts: promptBank.prompts,
    records: learning.records,
    planId: plan.id,
    day: context.day,
    date: context.date,
    taskId: context.taskId,
    plannedMinutes: context.plannedMinutes,
    historyScope:
      context.mode === "practice" ? ("account" as const) : ("plan" as const),
    pool:
      context.mode === "practice"
        ? ("practice" as const)
        : promptPoolForDay(context.day, "speaking"),
  };
  const assignments = useMemo(() => {
    if (context.mode === "practice")
      return ([1, 2, 3] as const).map((part) =>
        selectIndependentPracticePrompt(scheduleInput, {
          skill: "speaking",
          part,
        }),
      );
    if (!context.block) return selectScheduledSpeakingPrompts(scheduleInput);
    const scheduled = automaticMaterialForTask(
      {
        plan,
        records: learning.records,
        bank: [],
        prompts: promptBank.prompts,
      },
      context,
    );
    return ([1, 2, 3] as const).map((part) => {
      const reference = scheduled?.materials.find(
        (material) => material.part === part,
      );
      const prompt = reference
        ? (promptBank.prompts.find(
            (prompt) =>
              prompt.id === reference.id &&
              prompt.version === reference.version &&
              prompt.contentHash === reference.contentHash,
          ) ?? null)
        : null;
      return {
        skill: "speaking" as const,
        part,
        prompt,
        status: prompt ? ("assigned" as const) : ("missing" as const),
        notice: scheduled?.notice ?? `缺少本课 Part ${part} 的平台材料。`,
      };
    });
  }, [
    promptBank.prompts,
    learning.records,
    plan.id,
    context.day,
    context.date,
    context.taskId,
    context.plannedMinutes,
    context.mode,
  ]);
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
  const automaticSeed = (value: SpeakingPart, continueCurrent = true) => {
    const specified =
      selectedMaterial && continueCurrent
        ? promptBank.prompts.find(
            (prompt) => promptKey(prompt) === selectedMaterial,
          )
        : undefined;
    const selectedForPart =
      specified?.skill === "speaking" && specified.part === value;
    const allowed =
      selectedForPart &&
      specified.ready !== false &&
      (scheduleInput.pool === "holdout"
        ? specified.pool === "holdout"
        : practicePrompts(promptBank.prompts).includes(specified));
    const assignment =
      context.mode === "practice"
        ? selectIndependentPracticePrompt(scheduleInput, {
            skill: "speaking",
            part: value,
          })
        : continueCurrent
          ? assignments.find((item) => item.part === value)
          : selectSpeakingPrompt({ ...scheduleInput, continueCurrent }, value);
    const prompt =
      selectedMaterial &&
      continueCurrent &&
      (!specified || (selectedForPart && !allowed))
        ? null
        : allowed
          ? specified
          : (assignment?.prompt ?? null);
    const next = seedFor(plan, context, value, 0, prompt);
    if (context.mode === "practice" && prompt) {
      const repeat = !unattemptedPrompts(scheduleInput, "speaking").has(prompt);
      next.conditions = {
        timed: false,
        firstAttempt: !repeat,
        unseen: !repeat,
      };
    }
    return next;
  };
  const automaticInitialized = useRef(false);
  useEffect(() => {
    if (retest || !promptBank.loaded || automaticInitialized.current) return;
    automaticInitialized.current = true;
    if (initialWorkId || !context.block) {
      setAutomaticReady(true);
      return;
    }
    const specified = selectedMaterial
      ? promptBank.prompts.find(
          (prompt) =>
            promptKey(prompt) === selectedMaterial &&
            prompt.skill === "speaking",
        )
      : undefined;
    const value =
      specified?.skill === "speaking"
        ? specified.part
        : (([1, 2, 3] as const).find(
            (part) =>
              !works.some(
                (work) =>
                  work.payload.date === context.date &&
                  work.payload.taskId === context.taskId &&
                  work.payload.part === part,
              ),
          ) ?? 1);
    const existing = works.find(
      (work) =>
        work.payload.date === context.date &&
        work.payload.taskId === context.taskId &&
        work.payload.part === value,
    );
    setPart(value);
    if (existing) {
      setSelected(existing);
      setSeed(speakingDraftFromRevision(existing));
    } else setSeed(automaticSeed(value));
    setAutomaticReady(true);
  }, [retest, promptBank.loaded]);
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
  useEffect(() => {
    if (!retest || !promptBank.loaded) return;
    let active = true;
    void (async () => {
      const prompt = promptBank.prompts.find(
        (value) =>
          promptKey(value) === selectedMaterial && value.skill === "speaking",
      );
      if (!prompt)
        throw new Error(
          "本机缺少复测指定的原版口语题。请到“我的”导入题库，再从订正页进入。",
        );
      const id = await retestWorkId(
        learning.userId ?? "guest",
        plan.id,
        context,
        selectedMaterial!,
      );
      const head = works.find((work) =>
        matchesRetestWork(work, id, plan.id, context, prompt),
      );
      const next = head
        ? speakingDraftFromRevision(head)
        : {
            ...(await speakingRetestDraft(
              plan,
              context,
              prompt,
              withRevisionReferences(learning.records),
              promptBank.prompts,
            )),
            id,
            recordId: id,
          };
      if (!active) return;
      setSelected(head ?? null);
      setPart(next.part);
      setSeed(next);
      setRetestReady(true);
    })().catch((error) => {
      if (active) {
        setRetestError(
          error instanceof Error ? error.message : "复测题未读到，请重新进入。",
        );
        setRetestReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [retest, promptBank.loaded]);
  const updateMission = async (status: "partial" | "completed") => {
    if (!context.block || context.mode === "practice") return;
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
      status:
        old?.payload.status === "completed"
          ? "completed"
          : retest || seed.retestOf
            ? "partial"
            : status,
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
  const choosePart = (value: SpeakingPart, index?: number) => {
    setPart(value);
    setQuestion(index ?? 0);
    const existing =
      index === undefined
        ? works.find(
            (work) =>
              work.payload.date === context.date &&
              work.payload.taskId === context.taskId &&
              work.payload.part === value,
          )
        : undefined;
    setSelected(existing ?? null);
    setSeed(
      existing
        ? speakingDraftFromRevision(existing)
        : index === undefined
          ? automaticSeed(value)
          : seedFor(plan, context, value, index),
    );
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
      setMessage(
        context.mode === "practice"
          ? "自主口语作品已保留，不完成当天课程任务。"
          : retest || seed.retestOf
            ? "复测作答与用时已保存。请回订正页完成自查；本次作答只记入原口语块的部分进度。"
            : "本次口语任务已完成，实际用时已记录。",
      );
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
        setSeed(automaticSeed(part));
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
        <p className="eyebrow">
          {context.mode === "practice" ? "自主练习" : "365天训练"} ·{" "}
          {context.date}
        </p>
        <h1>口语练习</h1>
        {context.mode === "practice" ? (
          <p>参考20分钟，Part 1、2、3随时可练；保存作品不完成当天课程任务。</p>
        ) : (
          <p>
            本块计划 {context.plannedMinutes}{" "}
            分钟。每题独立保存，最后再完成本次任务。
          </p>
        )}
        <a href="#/">返回今日</a>
        {context.block && !retest && (
          <p>
            平台已按本节安排 Part 1 → Part 2 → Part
            3，保存本题后可直接继续下一部分，无需先选材料。
          </p>
        )}
        {retest && (
          <p>
            跨天新题复测：保留原Part。请先保存转写或录音，再离开页面；已保存作答可从同一链接恢复。
          </p>
        )}
        {!retestReady || !promptBank.loaded || (!retest && !automaticReady) ? (
          <p role="status">正在准备本节口语材料…</p>
        ) : retestError ? (
          <p role="alert">
            {retestError} <a href="#/review">返回订正</a>
          </p>
        ) : context.block || selected ? (
          <>
            {context.mode === "practice" && !seed.conditions.firstAttempt && (
              <p role="status">复习已做原题，本次不算未见新题。</p>
            )}
            {!retest && !seed.prompt.trim() && (
              <p role="alert">
                {assignments.find((assignment) => assignment.part === part)
                  ?.notice ?? "平台暂缺本节就绪新题；已有作答与录音保留。"}
              </p>
            )}
            <label className="field">
              <span>口语部分</span>
              <select
                aria-label="口语部分"
                value={part}
                disabled={dirty || deleting || retest || !!seed.retestOf}
                onChange={(event) =>
                  choosePart(Number(event.target.value) as SpeakingPart)
                }
              >
                <option value={1}>Part 1</option>
                <option value={2}>Part 2</option>
                <option value={3}>Part 3</option>
              </select>
            </label>
            {!retest && !seed.retestOf && !selected && (
              <PromptPicker
                prompts={promptBank.prompts}
                skill="speaking"
                part={part}
                value={(() => {
                  const prompt = promptBank.prompts.find(
                    (value) =>
                      value.id === seed.contentId &&
                      value.version === seed.contentVersion,
                  );
                  return prompt && promptKey(prompt);
                })()}
                disabled={dirty || deleting}
                onChoose={(prompt) => {
                  if (dirty || deleting) return;
                  const next = speakingWithPrompt(seed, prompt);
                  if (next !== seed) {
                    if (context.mode === "practice") {
                      const repeat = !unattemptedPrompts(
                        scheduleInput,
                        "speaking",
                      ).has(prompt);
                      next.conditions = {
                        timed: false,
                        firstAttempt: !repeat,
                        unseen: !repeat,
                      };
                    }
                    setSeed(next);
                    setSelected(null);
                    setMessage("已选择本机原题，作答后保留本题。");
                  }
                }}
              />
            )}
            {!retest &&
              !seed.retestOf &&
              !selected &&
              material &&
              !promptBank.prompts.some(
                (prompt) =>
                  prompt.id === seed.contentId &&
                  prompt.version === seed.contentVersion,
              ) && (
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
                promptLocked={
                  retest ||
                  !!seed.retestOf ||
                  promptBank.prompts.some(
                    (prompt) =>
                      prompt.id === seed.contentId &&
                      prompt.version === seed.contentVersion,
                  )
                }
              />
            )}
            {!retest && liveSelected && part < 3 && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  dirty ||
                  deleting ||
                  assignments.find((assignment) => assignment.part === part + 1)
                    ?.status !== "assigned"
                }
                onClick={() => choosePart((part + 1) as SpeakingPart)}
              >
                继续平台安排：Part {part + 1}
              </button>
            )}
            {context.mode === "practice" && !retest && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={dirty || deleting}
                onClick={() => {
                  setSelected(null);
                  setSeed(automaticSeed(part, false));
                  setMessage("已安排下一道自主练习，已有作答仍保留。");
                }}
              >
                再练一道 Part {part}
              </button>
            )}
            {!retest &&
              !seed.retestOf &&
              selected &&
              speakingPart(selected.payload.part) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={dirty || deleting}
                  onClick={() => {
                    const next = rerecordSpeaking(liveSelected!);
                    if (context.mode === "practice") {
                      next.date = context.date;
                      next.taskId = context.taskId;
                      delete next.day;
                      if (context.day >= 1 && context.day <= 365)
                        next.day = context.day;
                    }
                    if (context.correctionId && !context.retestOf)
                      Object.assign(next, {
                        correctionId: context.correctionId,
                        date: context.date,
                        day: context.day,
                        taskId: context.taskId,
                      });
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
            {!retest &&
              !seed.retestOf &&
              !promptBank.prompts.some(
                (prompt) =>
                  prompt.id === seed.contentId &&
                  prompt.version === seed.contentVersion,
              ) &&
              material &&
              currentQuestion + 1 < material.prompts.length && (
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
                !(context.mode === "practice" || retest || seed.retestOf
                  ? works.some(
                      (work) =>
                        work.payload.taskId === context.taskId &&
                        work.payload.date === context.date,
                    )
                  : ([1, 2, 3] as const).every((part) =>
                      works.some(
                        (work) =>
                          work.payload.taskId === context.taskId &&
                          work.payload.date === context.date &&
                          work.payload.part === part,
                      ),
                    ))
              }
              onClick={() => {
                void finish();
              }}
            >
              {context.mode === "practice"
                ? "结束本次自主练习"
                : retest || seed.retestOf
                  ? "保存本次复测进度"
                  : "完成本次口语"}
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
