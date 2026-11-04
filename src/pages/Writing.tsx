import { useEffect, useMemo, useRef, useState } from "react";
import { go, type Route } from "../lib/router";
import { words } from "../ielts/scoring/rules/text";
import {
  elapsedWritingSeconds,
  newWritingDraft,
  type WritingDraft,
} from "../study365/writingModel";
import type { Revision } from "../study365/protocol";
import { useActivePlan } from "../study365/useActivePlan";
import {
  availableWritingMaterials,
  externalWritingId,
  resolveWritingContext,
  WRITING_OUTLINE_HINTS,
  type WritingContext,
  type WritingMaterial,
  type WritingMode,
} from "../study365/writingTasks";

import {
  listWritingDrafts,
  saveWritingDraft,
  draftFromRevision,
  writingScope,
} from "../study365/writingDrafts";
import {
  checkpointWriting,
  rewriteWriting,
  submitWriting,
} from "../study365/writingWorks";
import { getLearningState, type LearningState } from "../study365/repository";
import { saveMission } from "../study365/missionRecords";
import { WritingReview } from "../study365/ui/writing/WritingReview";
import { ExternalWritingFeedback } from "../study365/ui/writing/ExternalWritingFeedback";
import { WritingHumanCalibration } from "../study365/ui/writing/WritingHumanCalibration";
import { WritingComparison } from "../study365/ui/writing/WritingComparison";
import { WritingRevisionChain } from "../study365/ui/writing/WritingRevisionChain";

type WritingRoute = Extract<Route, { page: "writing" }>;
const labelOf = (draft: WritingDraft) =>
  `写作 ${draft.taskType === "task1" ? "Task 1" : draft.scope === "paragraph" ? "Task 2 段落" : "Task 2"}`;
const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const tableDescription = (material?: WritingMaterial) =>
  material?.taskData?.kind === "table"
    ? [
        material.taskData.description,
        material.taskData.columns.join(" | "),
        ...material.taskData.rows.map((row) => row.join(" | ")),
      ].join("\n")
    : undefined;
function createDraft(
  plan: Revision,
  context: WritingContext,
  taskType: "task1" | "task2",
  paragraph = false,
): WritingDraft {
  const id = crypto.randomUUID();
  const material = availableWritingMaterials(context.day).find(
    (item) => item.taskType === taskType,
  );
  return newWritingDraft({
    id,
    planId: plan.id,
    taskType,
    scope: paragraph ? "paragraph" : "full",
    date: context.date,
    day: context.day,
    taskId: context.taskId,
    prompt: material?.prompt ?? "",
    contentId:
      material?.id ?? `${externalWritingId(context.date, Date.now())}-${id}`,
    contentVersion: material?.version,
    materialSelfCheck: material?.selfCheck ?? [],
    tableDescription: tableDescription(material),
    timer: {
      elapsedSeconds: 0,
      runningSince: null,
      limitSeconds: paragraph
        ? context.plannedMinutes * 60
        : taskType === "task1"
          ? 1200
          : 2400,
      timed: false,
    },
  });
}
export function Writing({ route }: { route: WritingRoute }) {
  const { learning, plan, error } = useActivePlan();
  if (!learning.ready)
    return (
      <div className="page">
        <p>正在读取写作任务…</p>
      </div>
    );
  if (!plan)
    return (
      <div className="page">
        <section className="panel" aria-label="写作工作台">
          <h1>写作工作台</h1>
          <p>请先开启365天计划。</p>
          <a href="#/">前往今日</a>
        </section>
      </div>
    );
  if (error)
    return (
      <div className="page">
        <p role="alert">{error}</p>
      </div>
    );
  try {
    const context = resolveWritingContext(plan, learning.records, route);
    return (
      <WritingEditor
        key={`${learning.userId ?? "guest"}:${plan.id}:${context.date}:${context.taskId}:${route.work ?? "new"}`}
        plan={plan}
        context={context}
        learning={learning}
        selectedWorkId={route.work}
      />
    );
  } catch (error) {
    return (
      <div className="page">
        <h1>写作工作台</h1>
        <p role="alert">
          {error instanceof Error ? error.message : "任务暂不可用。"}
        </p>
        <a href="#/">返回今日</a>
      </div>
    );
  }
}
function WritingEditor({
  plan,
  context,
  learning,
  selectedWorkId,
}: {
  plan: Revision;
  context: WritingContext;
  learning: LearningState;
  selectedWorkId?: string;
}) {
  const scope = writingScope(learning.userId),
    userId = learning.userId;
  const [mode, setMode] = useState<WritingMode>(context.defaultMode),
    [now, setNow] = useState(Date.now);
  const [drafts, setDrafts] = useState<WritingDraft[]>([]),
    [loaded, setLoaded] = useState(false),
    [localStatus, setLocalStatus] = useState("正在恢复本机草稿…"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    draftsRef = useRef(drafts),
    busyRef = useRef(false),
    queue = useRef<Promise<void>>(Promise.resolve()),
    autoTimer = useRef<number | undefined>(undefined);
  draftsRef.current = drafts;
  const works = learning.records
    .filter(
      (record) =>
        record.kind === "essay" &&
        record.planId === plan.id &&
        !record.deleted &&
        !record.conflict,
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
  const selected = works.find((work) => work.id === selectedWorkId);
  const checkAccount = () => {
    const state = getLearningState();
    if (!state.ready || state.userId !== userId)
      throw new Error("账号已经切换，请在原账号继续写作。");
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(autoTimer.current);
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (busyRef.current) return;
    let active = true;
    setLoaded(false);
    void listWritingDrafts(scope)
      .then((all) => {
        if (!active) return;
        let restored: WritingDraft[] = [];
        if (selectedWorkId) {
          const local = all.find(
            (draft) =>
              draft.planId === plan.id && draft.recordId === selectedWorkId,
          );
          if (local) {
            const head = selected;
            restored = [
              head &&
              head.payload.stage !== "draft" &&
              head.payload.text === local.text
                ? {
                    ...draftFromRevision(head),
                    outline: local.outline,
                    materialSelfCheck: local.materialSelfCheck,
                  }
                : local,
            ];
          } else if (selected) restored = [draftFromRevision(selected)];
          if (!restored.length) {
            setMessage(
              "本机尚未读到这份作品，请联网同步后从作品列表重新打开。",
            );
            setDrafts([]);
            setLoaded(true);
            return;
          }
          setMode(
            restored[0].scope === "paragraph"
              ? "paragraph"
              : restored[0].taskType,
          );
        } else {
          const candidates = all.filter(
            (draft) =>
              draft.planId === plan.id &&
              draft.date === context.date &&
              draft.taskId === context.taskId,
          );
          const byType = new Map<string, WritingDraft>();
          for (const draft of candidates)
            if (!byType.has(`${draft.taskType}:${draft.scope}`))
              byType.set(`${draft.taskType}:${draft.scope}`, draft);
          restored = [...byType.values()].map((local) => {
            const head = works.find((work) => work.id === local.recordId);
            return head &&
              head.payload.stage !== "draft" &&
              head.payload.text === local.text
              ? {
                  ...draftFromRevision(head),
                  outline: local.outline,
                  materialSelfCheck: local.materialSelfCheck,
                }
              : local;
          });
          if (restored.length)
            setMode(
              restored[0].scope === "paragraph"
                ? "paragraph"
                : restored[0].taskType,
            );
          if (!restored.length && context.block)
            restored =
              context.defaultMode === "pair"
                ? [
                    createDraft(plan, context, "task1"),
                    createDraft(plan, context, "task2"),
                  ]
                : [
                    createDraft(
                      plan,
                      context,
                      context.defaultMode === "task1" ? "task1" : "task2",
                      context.defaultMode === "paragraph",
                    ),
                  ];
        }
        setDrafts(restored);
        setLoaded(true);
        setLocalStatus(
          restored.every((draft) => draft.stage === "submitted")
            ? "已提交原稿只读。"
            : "草稿已恢复，修改后自动保存在本机。",
        );
      })
      .catch((error) => {
        if (active) {
          setLoaded(true);
          setDrafts(context.block ? [createDraft(plan, context, "task1")] : []);
          setLocalStatus(
            `草稿未保存：${error instanceof Error ? error.message : "读取失败，请保留正文。"}`,
          );
        }
      });
    return () => {
      active = false;
    };
  }, [scope, selectedWorkId, selected?.revisionId]);
  useEffect(() => {
    if (
      !loaded ||
      busyRef.current ||
      !drafts.some((draft) => draft.stage === "draft")
    )
      return;
    setLocalStatus("草稿有未保存的修改…");
    const snapshot = drafts;
    autoTimer.current = window.setTimeout(() => {
      const task = queue.current
        .catch(() => {})
        .then(async () => {
          for (const draft of snapshot.filter(
            (value) => value.stage === "draft",
          ))
            await saveWritingDraft(scope, draft);
        });
      queue.current = task;
      void task
        .then(() => {
          if (alive.current && draftsRef.current === snapshot)
            setLocalStatus("草稿已保存在本机。");
        })
        .catch((error) => {
          if (alive.current)
            setLocalStatus(
              `草稿未保存：${error instanceof Error ? error.message : "请保留正文并重试。"}`,
            );
        });
    }, 300);
    return () => window.clearTimeout(autoTimer.current);
  }, [drafts, loaded, scope]);
  const visible = useMemo(
    () =>
      drafts.filter((draft) =>
        mode === "pair"
          ? draft.scope === "full"
          : mode === "paragraph"
            ? draft.taskType === "task2" && draft.scope === "paragraph"
            : draft.taskType === mode && draft.scope === "full",
      ),
    [drafts, mode],
  );
  const activeSubmitted = useRef<WritingDraft[]>([]);
  activeSubmitted.current = visible.filter(
    (draft) => draft.stage === "submitted",
  );
  const currentSubmittedWork = (id: string) => {
    if (!activeSubmitted.current.some((draft) => draft.recordId === id))
      return null;
    return (
      getLearningState().records.find(
        (work) =>
          work.kind === "essay" &&
          work.id === id &&
          !work.deleted &&
          !work.conflict &&
          work.payload.stage !== "draft",
      ) ?? null
    );
  };
  const update = (id: string, change: (draft: WritingDraft) => WritingDraft) =>
    setDrafts((previous) =>
      previous.map((draft) =>
        draft.id === id && draft.stage !== "submitted"
          ? { ...change(draft), updatedAt: Date.now() }
          : draft,
      ),
    );
  const changeMode = (next: WritingMode) => {
    setMode(next);
    setDrafts((previous) => {
      const values = [...previous];
      for (const type of next === "pair"
        ? (["task1", "task2"] as const)
        : ([next === "task1" ? "task1" : "task2"] as const))
        if (
          !values.some(
            (draft) =>
              draft.taskType === type &&
              draft.scope === (next === "paragraph" ? "paragraph" : "full"),
          )
        )
          values.push(createDraft(plan, context, type, next === "paragraph"));
      return values;
    });
  };
  const start = (id: string) => {
    const at = Date.now();
    setDrafts((previous) =>
      previous.map((draft) =>
        draft.stage === "submitted"
          ? draft
          : {
              ...draft,
              timer: {
                ...draft.timer,
                elapsedSeconds: elapsedWritingSeconds(draft, at),
                runningSince: draft.id === id ? at : null,
                timed: draft.id === id ? true : draft.timer.timed,
              },
              updatedAt: at,
            },
      ),
    );
    setNow(at);
  };
  const pause = (id: string) =>
    update(id, (draft) => ({
      ...draft,
      timer: {
        ...draft.timer,
        elapsedSeconds: elapsedWritingSeconds(draft),
        runningSince: null,
      },
    }));
  const unresolved = (draft: WritingDraft) => {
    const head = works.find((work) => work.id === draft.recordId);
    return learning.conflicts.some(
      (conflict) =>
        conflict.kind === "essay" &&
        conflict.id === draft.recordId &&
        (!head || head.seq <= conflict.seq),
    );
  };
  const updateMission = async () => {
    if (!context.block) return;
    checkAccount();
    const submitted = getLearningState().records.filter(
      (work) =>
        work.kind === "essay" &&
        work.planId === plan.id &&
        !work.deleted &&
        !work.conflict &&
        work.payload.stage !== "draft" &&
        work.payload.date === context.date &&
        work.payload.taskId === context.taskId,
    );
    const complete =
      context.plannedMinutes < 60
        ? submitted.length > 0
        : ["task1", "task2"].every((type) =>
            submitted.some(
              (work) =>
                work.payload.taskType === type &&
                work.payload.scope !== "paragraph",
            ),
          );
    const seconds = submitted.reduce(
      (sum, work) => sum + Number(work.payload.elapsedSeconds ?? 0),
      0,
    );
    await saveMission({
      planId: plan.id,
      day: context.day,
      date: context.date,
      block: context.block,
      status: complete ? "completed" : "partial",
      actualMinutes: seconds / 60,
      timeSource: "timer",
      expectedUserId: userId,
    });
  };
  const publish = async (draft: WritingDraft, submit: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    window.clearTimeout(autoTimer.current);
    try {
      checkAccount();
      if (draft.contentId?.startsWith("external-") && !draft.sourceRef?.trim())
        throw new Error("外部题请填写出处。");
      await queue.current.catch(() => {});
      checkAccount();
      const result = await (submit ? submitWriting : checkpointWriting)(draft, {
        scope,
        expectedUserId: userId,
        hasUnresolvedConflict: unresolved(draft),
      });
      if (!alive.current) return;
      setDrafts((previous) =>
        previous.map((value) => (value.id === draft.id ? result.draft : value)),
      );
      setLocalStatus(
        submit
          ? "这版原稿已提交，正文只读。"
          : userId
            ? "检查点已保存在本机，等待同步到账号。"
            : "本机检查点已保存。要跨设备同步，请先登录后在账号下写作。",
      );
      if (submit) {
        try {
          await updateMission();
          if (alive.current)
            setMessage("作品已提交，今日任务已按实际计时更新。");
        } catch (error) {
          if (alive.current)
            setMessage(
              `作品已提交；今日任务未更新：${error instanceof Error ? error.message : "请重试。"}`,
            );
        }
      } else {
        setMessage(
          userId
            ? "检查点已加入账号同步队列，联网后自动同步。"
            : "本机检查点已保存。要跨设备同步，请先登录后在账号下写作。",
        );
      }
    } catch (error) {
      if (alive.current) {
        const head = getLearningState().records.find(
          (work) =>
            work.id === draft.recordId &&
            work.kind === "essay" &&
            !work.deleted &&
            !work.conflict &&
            work.payload.stage === "submitted" &&
            work.payload.text === draft.text,
        );
        if (head)
          setDrafts((previous) =>
            previous.map((value) =>
              value.id === draft.id
                ? {
                    ...draftFromRevision(head),
                    outline: draft.outline,
                    materialSelfCheck: draft.materialSelfCheck,
                  }
                : value,
            ),
          );
        setMessage(
          `${head ? "作品已提交；本机草稿未保存：" : "未保存："}${error instanceof Error ? error.message : "请保留正文并重试。"}`,
        );
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const rewrite = async (work: Revision) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    try {
      checkAccount();
      const next = rewriteWriting(work);
      const result = await checkpointWriting(next, {
        scope,
        expectedUserId: userId,
      });
      if (!alive.current) return;
      go({
        page: "writing",
        work: result.work.id,
        date: String(result.work.payload.date),
        ...(typeof result.work.payload.day === "number"
          ? { day: result.work.payload.day }
          : {}),
        ...(typeof result.work.payload.taskId === "string"
          ? { task: result.work.payload.taskId }
          : {}),
      });
    } catch (error) {
      if (alive.current)
        setMessage(
          `修改稿未保存：${error instanceof Error ? error.message : "请重试，上一版原稿仍保留。"}`,
        );
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="page">
      <section
        className="panel"
        aria-label="写作工作台"
        data-testid="writing-workbench"
      >
        <p className="eyebrow">365天训练 · {context.date}</p>
        <h1>写作工作台</h1>
        <p>今日写作计划 {context.plannedMinutes} 分钟。提纲时间计入写作。</p>
        <a href="#/">返回今日任务</a>
        {!loaded ? (
          <p role="status">正在恢复本机草稿…</p>
        ) : !context.block && !drafts.length ? (
          <p>这一天没有写作任务。可以打开已保存作品。</p>
        ) : (
          <>
            <label className="field">
              <span>练习类型</span>
              <select
                aria-label="练习类型"
                value={mode}
                disabled={busy || !!selectedWorkId}
                onChange={(event) =>
                  changeMode(event.target.value as WritingMode)
                }
              >
                <option value="task1">Task 1</option>
                <option value="task2">Task 2</option>
                <option value="paragraph">Task 2 段落练习</option>
                <option value="pair">Task 1 + Task 2（20 + 40分钟）</option>
              </select>
            </label>
            {mode === "paragraph" && (
              <p>这是段落练习，不计作完整 Task 2 测评。</p>
            )}
            {visible.map((draft) => (
              <div key={draft.id}>
                <fieldset
                  disabled={busy}
                  style={{ border: 0, padding: 0, minWidth: 0 }}
                >
                  <DraftEditor
                    draft={draft}
                    now={now}
                    materials={availableWritingMaterials(context.day)}
                    onChange={(change) => update(draft.id, change)}
                    onStart={() => start(draft.id)}
                    onPause={() => pause(draft.id)}
                  />
                </fieldset>
                {unresolved(draft) && (
                  <p role="alert">
                    有两个版本，请先在冲突区选择一份。原稿和两个版本均已保留。
                  </p>
                )}
                {draft.stage === "submitted" ? (
                  <>
                    <p role="status">这版原稿已提交，只读。</p>
                    {works.find(
                      (work) => work.revisionId === draft.submittedRevisionId,
                    ) && (
                      <WritingReview
                        work={works.find(
                          (work) =>
                            work.revisionId === draft.submittedRevisionId,
                        )!}
                        materialSelfCheck={draft.materialSelfCheck}
                      />
                    )}
                    {works.find(
                      (work) => work.revisionId === draft.submittedRevisionId,
                    ) && (
                      <ExternalWritingFeedback
                        work={works.find(
                          (work) =>
                            work.revisionId === draft.submittedRevisionId,
                        )!}
                        currentWork={() => currentSubmittedWork(draft.recordId)}
                      />
                    )}
                    {works.find(
                      (work) => work.revisionId === draft.submittedRevisionId,
                    ) && (
                      <WritingHumanCalibration
                        plan={plan}
                        work={works.find(
                          (work) =>
                            work.revisionId === draft.submittedRevisionId,
                        )!}
                        currentWork={() => currentSubmittedWork(draft.recordId)}
                      />
                    )}
                    {works.find(
                      (work) => work.revisionId === draft.submittedRevisionId,
                    ) && (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || unresolved(draft)}
                          onClick={() => {
                            void rewrite(
                              works.find(
                                (work) =>
                                  work.revisionId === draft.submittedRevisionId,
                              )!,
                            );
                          }}
                        >
                          写修改稿
                        </button>
                        <WritingRevisionChain
                          work={works.find(
                            (work) =>
                              work.revisionId === draft.submittedRevisionId,
                          )!}
                          records={learning.records}
                          onSelect={(work) =>
                            go({
                              page: "writing",
                              work: work.id,
                              date: String(work.payload.date),
                              ...(typeof work.payload.day === "number"
                                ? { day: work.payload.day }
                                : {}),
                              ...(typeof work.payload.taskId === "string"
                                ? { task: work.payload.taskId }
                                : {}),
                            })
                          }
                        />
                        {works.find(
                          (work) => work.revisionId === draft.parentRevisionId,
                        ) && (
                          <WritingComparison
                            previous={works.find(
                              (work) =>
                                work.revisionId === draft.parentRevisionId,
                            )!}
                            current={works.find(
                              (work) =>
                                work.revisionId === draft.submittedRevisionId,
                            )!}
                          />
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <div className="data-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-testid="writing-checkpoint"
                      disabled={busy || unresolved(draft)}
                      onClick={() => {
                        void publish(draft, false);
                      }}
                    >
                      {userId ? "存到云端" : "保存本机检查点"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="writing-submit"
                      disabled={busy || unresolved(draft)}
                      onClick={() => {
                        void publish(draft, true);
                      }}
                    >
                      {draft.parentRevisionId ? "提交修改稿" : "提交首稿"}
                    </button>
                  </div>
                )}
              </div>
            ))}
            <p role="status" data-testid="writing-local-status">
              {localStatus}
            </p>
          </>
        )}
        {message && <p role="status">{message}</p>}
      </section>
      <section
        className="panel"
        aria-label="我的写作作品"
        data-testid="writing-work-list"
      >
        <h2>我的作品</h2>
        {!works.length ? (
          <p>暂无已保存作品。</p>
        ) : (
          <ul>
            {works.map((work) => (
              <li key={work.id}>
                <a
                  data-work-id={work.id}
                  data-revision-id={work.revisionId}
                  href={`#/writing?work=${encodeURIComponent(work.id)}&date=${String(work.payload.date ?? context.date)}${work.payload.day ? `&day=${work.payload.day}` : ""}${work.payload.taskId ? `&task=${work.payload.taskId}` : ""}`}
                >
                  {String(work.payload.date ?? "日期未记录")} ·{" "}
                  {work.payload.taskType === "task1" ? "Task 1" : "Task 2"}
                  {work.payload.scope === "paragraph" ? "段落" : ""} ·{" "}
                  {work.payload.stage === "draft" ? "检查点" : "已提交"} ·{" "}
                  {Number(
                    work.payload.wordCount ??
                      words(String(work.payload.text ?? "")).length,
                  )}
                  词
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
function DraftEditor({
  draft,
  materials,
  now,
  onChange,
  onStart,
  onPause,
}: {
  draft: WritingDraft;
  materials: WritingMaterial[];
  now: number;
  onChange: (change: (draft: WritingDraft) => WritingDraft) => void;
  onStart: () => void;
  onPause: () => void;
}) {
  const available = materials.filter(
    (material) => material.taskType === draft.taskType,
  );
  const material = available.find((item) => item.id === draft.contentId);
  const [source, setSource] = useState<"builtin" | "external" | "custom">(
    material
      ? "builtin"
      : draft.sourceRef
        ? "external"
        : draft.contentId?.startsWith("custom-")
          ? "custom"
          : "external",
  );
  const elapsed = elapsedWritingSeconds(draft, now),
    remaining = Math.max(0, draft.timer.limitSeconds - elapsed),
    count = words(draft.text).length;
  const chooseSource = (value: "builtin" | "external" | "custom") => {
    setSource(value);
    onChange((previous) => {
      const selected = value === "builtin" ? available[0] : undefined;
      return {
        ...previous,
        prompt: selected?.prompt ?? "",
        contentId: selected?.id ?? `${value}-${previous.date}-${previous.id}`,
        contentVersion: selected?.version,
        sourceRef: undefined,
        tableDescription: tableDescription(selected),
        materialSelfCheck: selected?.selfCheck ?? [],
      };
    });
  };
  return (
    <article
      className="panel"
      aria-label={labelOf(draft)}
      data-testid="writing-editor"
      data-draft-id={draft.id}
    >
      <h2>{labelOf(draft).replace("写作 ", "")}</h2>
      <fieldset
        disabled={draft.stage === "submitted"}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        <label className="field">
          <span>题目来源</span>
          <select
            aria-label="题目来源"
            value={source}
            onChange={(event) =>
              chooseSource(event.target.value as typeof source)
            }
          >
            {available.length > 0 && (
              <option value="builtin">当天内置题</option>
            )}
            <option value="external">外部题</option>
            <option value="custom">自定义题</option>
          </select>
        </label>
        {source === "builtin" && (
          <>
            <label>
              内置题目
              <select
                aria-label="内置题目"
                value={draft.contentId}
                onChange={(event) => {
                  const item = available.find(
                    (material) => material.id === event.target.value,
                  )!;
                  onChange((previous) => ({
                    ...previous,
                    prompt: item.prompt,
                    contentId: item.id,
                    contentVersion: item.version,
                    tableDescription: tableDescription(item),
                    materialSelfCheck: item.selfCheck,
                  }));
                }}
              >
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">自编练习材料，尚待独立人工审校。</p>
          </>
        )}
        {source === "external" && (
          <label className="field">
            <span>外部题出处（必填）</span>
            <input
              aria-label="外部题出处"
              value={draft.sourceRef ?? ""}
              maxLength={300}
              placeholder="例如：剑桥20 Test 1 Task 2"
              onChange={(event) =>
                onChange((previous) => ({
                  ...previous,
                  sourceRef: event.target.value,
                }))
              }
            />
          </label>
        )}
        <label style={{ display: "block" }}>
          题目
          <textarea
            aria-label="题目"
            value={draft.prompt}
            readOnly={source === "builtin"}
            maxLength={8000}
            rows={4}
            style={{ width: "100%" }}
            onChange={(event) =>
              onChange((previous) => ({
                ...previous,
                prompt: event.target.value,
              }))
            }
          />
        </label>
        {material?.taskData?.kind === "table" && (
          <div style={{ overflowX: "auto" }}>
            <table aria-label="Task 1题目数据表">
              <caption>{material.taskData.description}</caption>
              <thead>
                <tr>
                  {material.taskData.columns.map((value) => (
                    <th key={value}>{value}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {material.taskData.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((value, i) => (
                      <td key={i}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {source !== "builtin" && draft.taskType === "task1" && (
          <label style={{ display: "block" }}>
            题图文字说明
            <textarea
              aria-label="题图文字说明"
              value={draft.tableDescription ?? ""}
              maxLength={2000}
              rows={2}
              style={{ width: "100%" }}
              placeholder="图在书上看，在这里记下图的对象、单位和时间。"
              onChange={(event) =>
                onChange((previous) => ({
                  ...previous,
                  tableDescription: event.target.value,
                }))
              }
            />
          </label>
        )}
        <div className="data-actions">
          <button
            className="btn btn-primary"
            type="button"
            disabled={draft.timer.runningSince !== null}
            onClick={onStart}
          >
            开始计时
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={draft.timer.runningSince === null}
            onClick={onPause}
          >
            暂停计时
          </button>
        </div>
        <p role="status">
          剩余 {formatTime(remaining)} · 已用 {formatTime(elapsed)}
        </p>
        {elapsed >= draft.timer.limitSeconds && (
          <p role="status">
            时间已到，可以继续写。
            {elapsed > draft.timer.limitSeconds
              ? `已超时 ${formatTime(elapsed - draft.timer.limitSeconds)}。`
              : ""}
          </p>
        )}
        <h3>提纲</h3>
        <ul>
          {WRITING_OUTLINE_HINTS[draft.taskType].map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
        <textarea
          aria-label="提纲"
          data-testid="writing-outline"
          value={draft.outline}
          maxLength={8000}
          rows={3}
          style={{ width: "100%" }}
          onChange={(event) =>
            onChange((previous) => ({
              ...previous,
              outline: event.target.value,
            }))
          }
        />
        <h3>正文</h3>
        <p>
          {count} 词
          {draft.scope === "paragraph"
            ? " · 段落练习"
            : ` · 至少 ${draft.taskType === "task1" ? 150 : 250} 词`}
        </p>
        <textarea
          aria-label="作文正文"
          data-testid="writing-body"
          value={draft.text}
          maxLength={20000}
          rows={14}
          style={{ width: "100%", lineHeight: 1.8 }}
          onChange={(event) =>
            onChange((previous) => ({ ...previous, text: event.target.value }))
          }
        />
        <label>
          <input
            type="checkbox"
            checked={draft.conditions.unseen}
            onChange={(event) =>
              onChange((previous) => ({
                ...previous,
                conditions: {
                  ...previous.conditions,
                  unseen: event.target.checked,
                },
              }))
            }
          />{" "}
          这是未做过的题目
        </label>
      </fieldset>
    </article>
  );
}
