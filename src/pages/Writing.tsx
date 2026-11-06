import { useEffect, useMemo, useRef, useState } from "react";
import { go, type Route } from "../lib/router";
import { words } from "../ielts/scoring/rules/text";
import {
  elapsedWritingSeconds,
  newWritingDraft,
  type WritingDraft,
} from "../study365/writingModel";
import { isObject, type Revision } from "../study365/protocol";
import { usePracticePlan } from "../study365/usePracticePlan";
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
import {
  getLearningState,
  listRevisions,
  resolveConflict,
  type LearningState,
} from "../study365/repository";
import { saveMission, selectMission } from "../study365/missionRecords";
import { WritingReview } from "../study365/ui/writing/WritingReview";
import { ExternalWritingFeedback } from "../study365/ui/writing/ExternalWritingFeedback";
import { WritingHumanCalibration } from "../study365/ui/writing/WritingHumanCalibration";
import { WritingComparison } from "../study365/ui/writing/WritingComparison";
import { WritingRevisionChain } from "../study365/ui/writing/WritingRevisionChain";

import {
  adoptCommittedWritingHead,
  recoverWritingDraft,
  restoredWritingMode,
  unresolvedWritingConflicts,
} from "../study365/writingRecovery";
import { feedbackForWork } from "../study365/writingReview";
import { writingCauseOptions } from "../study365/writingRubric";
import { calibrationForWork } from "../study365/writingCalibration";
import { usePromptBank } from "../study365/usePromptBank";
import {
  promptKey,
  canChooseWritingPrompt,
  writingWithPrompt,
  retestWorkId,
  matchesRetestWork,
  selectWritingPrompt,
  writingPromptReferences,
  practicePrompts,
  selectIndependentPracticePrompt,
  unattemptedPrompts,
} from "../study365/promptWorkSelection";
import {
  automaticMaterialForTask,
  promptPoolForDay,
} from "../study365/dailyMaterialPlan";
import {
  PromptPicker,
  PromptStimulus,
} from "../study365/ui/prompts/PromptPicker";
import type { LocalPrompt } from "../study365/promptBankSchema";
import { writingRetestDraft } from "../study365/retestWorkDrafts";
import { withRevisionReferences } from "../study365/revisionReferences";

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
  assigned?: LocalPrompt | null,
): WritingDraft {
  const id = crypto.randomUUID();
  const material =
    assigned === undefined
      ? availableWritingMaterials(context.day).find(
          (item) => item.taskType === taskType,
        )
      : undefined;
  return newWritingDraft({
    id,
    planId: plan.id,
    taskType,
    scope: paragraph ? "paragraph" : "full",
    date: context.date,
    ...(context.day >= 1 && context.day <= 365 ? { day: context.day } : {}),
    taskId: context.taskId,
    prompt: assigned?.prompt ?? material?.prompt ?? "",
    contentId:
      assigned?.id ??
      material?.id ??
      `${externalWritingId(context.date, Date.now())}-${id}`,
    contentVersion: assigned?.version ?? material?.version,
    sourceRef: assigned?.sourceRef,
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
  const { learning, plan, error, creating } = usePracticePlan();
  if (!learning.ready || creating)
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
        key={`${learning.userId ?? "guest"}:${plan.id}:${context.date}:${context.taskId}:${route.work ?? "new"}:${route.correctionId ?? ""}:${route.retestOf ?? ""}:${route.material ?? ""}`}
        plan={plan}
        context={context}
        learning={learning}
        selectedWorkId={route.work}
        selectedMaterial={route.material}
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
  selectedMaterial,
}: {
  plan: Revision;
  context: WritingContext;
  learning: LearningState;
  selectedWorkId?: string;
  selectedMaterial?: string;
}) {
  const scope = writingScope(learning.userId),
    userId = learning.userId;
  const promptBank = usePromptBank(userId),
    retest = !!context.retestOf;
  const [retestError, setRetestError] = useState("");
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
  const [histories, setHistories] = useState<Record<string, Revision[]>>({});
  const [historyWork, setHistoryWork] = useState<string | null>(null);
  const [localArchive, setLocalArchive] = useState<WritingDraft[]>([]);
  const makeDraft = (
    taskType: "task1" | "task2",
    paragraph = false,
    local = localArchive,
    continueCurrent = true,
  ) => {
    const practice = context.mode === "practice";
    const pool = practice
      ? "practice"
      : promptPoolForDay(context.day, "writing");
    const specified =
      selectedMaterial && continueCurrent
        ? promptBank.prompts.find(
            (prompt) => promptKey(prompt) === selectedMaterial,
          )
        : undefined;
    const eligibleSpecified =
      specified?.skill === "writing" &&
      specified.taskType === taskType &&
      specified.ready !== false &&
      (pool === "holdout"
        ? specified.pool === "holdout"
        : practicePrompts(promptBank.prompts).includes(specified));
    const selectionInput = {
      prompts: promptBank.prompts,
      records: learning.records,
      planId: plan.id,
      day: context.day,
      date: context.date,
      taskId: context.taskId,
      plannedMinutes: context.plannedMinutes,
      pool,
      localWorks: writingPromptReferences(local),
      continueCurrent,
      historyScope: practice ? ("account" as const) : ("plan" as const),
    };
    const selection = practice
      ? selectIndependentPracticePrompt(selectionInput, {
          skill: "writing",
          taskType,
        })
      : selectWritingPrompt(selectionInput, taskType);
    const scheduledType =
      context.defaultMode === "pair" ||
      (context.defaultMode === "task1"
        ? taskType === "task1"
        : taskType === "task2");
    const scheduled =
      !practice && continueCurrent && context.block && scheduledType
        ? automaticMaterialForTask(
            {
              plan,
              records: learning.records,
              bank: [],
              prompts: promptBank.prompts,
              localWorks: writingPromptReferences(local),
            },
            context,
          )
        : null;
    const reference = scheduled?.materials.find(
      (material) => material.taskType === taskType,
    );
    const planned = reference
      ? promptBank.prompts.find(
          (prompt) =>
            prompt.id === reference.id &&
            prompt.version === reference.version &&
            prompt.contentHash === reference.contentHash,
        )
      : undefined;
    const wrongType =
      !!specified &&
      (specified.skill !== "writing" || specified.taskType !== taskType) &&
      context.defaultMode !== "pair";
    const chosen =
      selectedMaterial &&
      continueCurrent &&
      (!specified ||
        wrongType ||
        (specified.skill === "writing" &&
          specified.taskType === taskType &&
          !eligibleSpecified))
        ? null
        : eligibleSpecified
          ? specified
          : scheduled
            ? (planned ?? null)
            : selection.prompt;
    const draft = createDraft(plan, context, taskType, paragraph, chosen);
    if (practice && chosen) {
      const repeat = !unattemptedPrompts(selectionInput, "writing").has(chosen);
      draft.conditions = { firstAttempt: !repeat, unseen: !repeat };
    }
    return draft;
  };
  draftsRef.current = drafts;
  const works = learning.records
    .filter(
      (record) =>
        record.kind === "essay" &&
        record.planId === plan.id &&
        !record.deleted &&
        !record.conflict,
    )
    .sort(
      (a, b) =>
        String(b.payload.date ?? "").localeCompare(
          String(a.payload.date ?? ""),
        ) ||
        b.createdAt - a.createdAt ||
        b.seq - a.seq,
    );
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
  const mergeArchive = (values: WritingDraft[]) =>
    setLocalArchive((previous) => {
      const next = new Map(previous.map((draft) => [draft.id, draft]));
      for (const draft of values) next.set(draft.id, draft);
      return [...next.values()];
    });
  const withTaskTimer = (draft: WritingDraft): WritingDraft =>
    !draft.retestOf && draft.scope === "paragraph" && context.plannedMinutes > 0
      ? {
          ...draft,
          timer: { ...draft.timer, limitSeconds: context.plannedMinutes * 60 },
        }
      : draft;
  const rememberHistory = (id: string, values: Revision[]) => {
    if (alive.current)
      setHistories((previous) => ({ ...previous, [id]: values }));
  };
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setRetestError("");
    if (!promptBank.loaded)
      return () => {
        active = false;
      };
    void (async () => {
      const all = (await listWritingDrafts(scope)).filter(
        (draft) => draft.planId === plan.id,
      );
      if (!active) return;
      setLocalArchive(all);
      const reconcile = async (local: WritingDraft) => {
        const head = works.find((work) => work.id === local.recordId);
        if (!head || head.revisionId === local.baseRevision) return local;
        const history = await listRevisions(head.id);
        if (!active) return local;
        rememberHistory(head.id, history);
        return withTaskTimer(
          adoptCommittedWritingHead(local, head) ??
            recoverWritingDraft(local, head, history),
        );
      };
      let restored: WritingDraft[] = [];
      if (retest) {
        const prompt = promptBank.prompts.find(
          (value) =>
            promptKey(value) === selectedMaterial && value.skill === "writing",
        );
        if (!prompt)
          throw new Error(
            "本机缺少复测指定的原版写作题。请到“我的”导入题库，再从订正页进入；当前草稿保留。",
          );
        const id = await retestWorkId(
          scope,
          plan.id,
          context,
          selectedMaterial!,
        );
        const head = works.find((work) =>
          matchesRetestWork(work, id, plan.id, context, prompt),
        );
        const local = all.find(
          (draft) =>
            draft.recordId === id &&
            draft.retestOf === context.retestOf &&
            draft.correctionId === context.correctionId &&
            draft.contentId === prompt.id &&
            draft.contentVersion === prompt.version &&
            prompt.skill === "writing" &&
            draft.taskType === prompt.taskType,
        );
        if (local) restored = [await reconcile(local)];
        else if (head) restored = [draftFromRevision(head)];
        else {
          const next = await writingRetestDraft(
            plan,
            context,
            prompt,
            withRevisionReferences(learning.records),
            promptBank.prompts,
          );
          restored = [{ ...next, id, recordId: id }];
        }
      } else if (selectedWorkId) {
        const local = all.find((draft) => draft.recordId === selectedWorkId);
        if (local) restored = [await reconcile(local)];
        else if (selected)
          restored = [withTaskTimer(draftFromRevision(selected))];
        if (!restored.length) {
          if (active) {
            setMessage(
              "本机尚未读到这份作品，请联网同步后从作品列表重新打开。",
            );
            setDrafts([]);
            setLoaded(true);
          }
          return;
        }
      } else {
        const candidates = all.filter(
          (draft) =>
            ((draft.date === context.date && draft.taskId === context.taskId) ||
              (context.mode === "practice" &&
                draft.taskId?.startsWith("practice-writing-") &&
                draft.stage === "draft" &&
                !!(draft.text.trim() || draft.outline.trim()))) &&
            !draft.retestOf,
        );
        const byType = new Map<string, WritingDraft>();
        for (const draft of candidates)
          if (!byType.has(`${draft.taskType}:${draft.scope}`))
            byType.set(`${draft.taskType}:${draft.scope}`, draft);
        restored = await Promise.all([...byType.values()].map(reconcile));
        if (!restored.length) {
          const remoteTypes = new Map<string, Revision>();
          for (const work of works.filter(
            (work) =>
              work.payload.date === context.date &&
              work.payload.taskId === context.taskId &&
              !work.payload.retestOf,
          ))
            if (
              !remoteTypes.has(`${work.payload.taskType}:${work.payload.scope}`)
            )
              remoteTypes.set(
                `${work.payload.taskType}:${work.payload.scope}`,
                work,
              );
          restored = [...remoteTypes.values()].map((work) =>
            withTaskTimer(draftFromRevision(work)),
          );
        }
        if (!restored.length && context.block)
          restored =
            context.defaultMode === "pair"
              ? [makeDraft("task1", false, all), makeDraft("task2", false, all)]
              : [
                  makeDraft(
                    context.defaultMode === "task1" ? "task1" : "task2",
                    context.defaultMode === "paragraph",
                    all,
                  ),
                ];
      }
      if (!active) return;
      if (
        !retest &&
        !selectedWorkId &&
        context.block &&
        context.defaultMode === "pair" &&
        !restored.some((draft) => draft.scope === "paragraph")
      ) {
        for (const type of ["task1", "task2"] as const) {
          if (
            restored.some(
              (draft) => draft.taskType === type && draft.scope === "full",
            )
          )
            continue;
          const remote = works.find(
            (work) =>
              work.payload.date === context.date &&
              work.payload.taskId === context.taskId &&
              work.payload.taskType === type &&
              work.payload.scope !== "paragraph" &&
              !work.payload.retestOf,
          );
          restored.push(
            remote
              ? withTaskTimer(draftFromRevision(remote))
              : makeDraft(type, false, all),
          );
        }
      }
      restored = restored.map((draft) => {
        if (
          retest ||
          selectedWorkId ||
          draft.prompt.trim() ||
          !canChooseWritingPrompt(draft)
        )
          return draft;
        const scheduled = makeDraft(
          draft.taskType,
          draft.scope === "paragraph",
          all,
        );
        return scheduled.prompt.trim()
          ? {
              ...draft,
              prompt: scheduled.prompt,
              contentId: scheduled.contentId,
              contentVersion: scheduled.contentVersion,
              sourceRef: scheduled.sourceRef,
              tableDescription: scheduled.tableDescription,
              materialSelfCheck: scheduled.materialSelfCheck,
              conditions: scheduled.conditions,
            }
          : draft;
      });
      setMode(
        restoredWritingMode(
          restored,
          selectedWorkId || retest ? restored[0].taskType : context.defaultMode,
        ),
      );
      setDrafts(restored);
      setLoaded(true);
      setLocalStatus(
        restored.every((draft) => draft.stage === "submitted")
          ? "已提交原稿只读。"
          : "草稿已恢复，修改后自动保存在本机。",
      );
    })().catch((error) => {
      if (active) {
        setLoaded(true);
        setDrafts(
          !retest && context.block
            ? [createDraft(plan, context, "task1", false, null)]
            : [],
        );
        if (retest)
          setRetestError(
            error instanceof Error
              ? error.message
              : "复测题未读取，请从订正页重新进入。",
          );
        setLocalStatus(
          `草稿未保存：${error instanceof Error ? error.message : "读取失败，请保留正文。"}`,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [scope, selectedWorkId, promptBank.loaded]);
  // Remote heads are reconciled against the latest in-memory text, including
  // keystrokes still inside the 300ms local-save window. Never reload over it.
  const remoteHeadsKey = works
    .map((work) => `${work.id}:${work.revisionId}`)
    .join("|");
  useEffect(() => {
    if (!loaded || busyRef.current) return;
    let active = true;
    const ids = selectedWorkId
      ? [selectedWorkId]
      : draftsRef.current.map((draft) => draft.recordId);
    void (async () => {
      for (const id of [...new Set(ids)]) {
        const head = works.find((work) => work.id === id);
        if (!head) continue;
        const history = await listRevisions(id);
        if (!active || getLearningState().userId !== userId) return;
        rememberHistory(id, history);
        const current = draftsRef.current.find(
          (draft) => draft.recordId === id,
        );
        if (!current) {
          if (selectedWorkId === id) {
            const restored = withTaskTimer(draftFromRevision(head));
            setDrafts([restored]);
            setMode(restoredWritingMode([restored], context.defaultMode));
            setMessage("");
          }
          continue;
        }
        if (current.baseRevision === head.revisionId) continue;
        const recovered = withTaskTimer(
          adoptCommittedWritingHead(current, head) ??
            recoverWritingDraft(current, head, history),
        );
        if (
          recovered === current ||
          recovered.baseRevision === current.baseRevision
        ) {
          setMessage("云端有新版本，当前未保存编辑及原修订基准已保留。");
          continue;
        }
        setDrafts((previous) =>
          previous.map((draft) =>
            draft.id === current.id && draft === current ? recovered : draft,
          ),
        );
        setLocalStatus("已读取更新的检查点，本机提纲保留。");
      }
    })().catch((error) => {
      if (active)
        setMessage(
          error instanceof Error
            ? error.message
            : "历史暂时未读全，当前正文保持不变。",
        );
    });
    return () => {
      active = false;
    };
  }, [remoteHeadsKey, loaded, selectedWorkId]);
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
          if (alive.current) {
            mergeArchive(snapshot);
            if (draftsRef.current === snapshot)
              setLocalStatus("草稿已保存在本机。");
          }
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
      previous.map((draft) => {
        if (draft.id !== id || draft.stage === "submitted") return draft;
        const next = change(draft);
        if (
          context.mode === "practice" &&
          (next.contentId !== draft.contentId ||
            next.contentVersion !== draft.contentVersion)
        ) {
          const source = promptBank.prompts.find(
            (prompt) =>
              prompt.id === next.contentId &&
              prompt.version === next.contentVersion,
          );
          if (source) {
            const repeat = !unattemptedPrompts(
              {
                prompts: promptBank.prompts,
                records: learning.records.filter(
                  (work) => work.id !== draft.recordId,
                ),
                planId: plan.id,
                historyScope: "account",
              },
              "writing",
            ).has(source);
            next.conditions = { firstAttempt: !repeat, unseen: !repeat };
          }
        }
        return {
          ...next,
          updatedAt: Math.max(Date.now(), draft.updatedAt + 1),
        };
      }),
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
          values.push(
            makeDraft(type, next === "paragraph", [...localArchive, ...values]),
          );
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
              updatedAt: Math.max(at, draft.updatedAt + 1),
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
  const allRevisions = useMemo(() => {
    const merged = new Map<string, Revision>();
    for (const record of [
      ...learning.records,
      ...learning.conflicts,
      ...Object.values(histories).flat(),
    ]) {
      const old = merged.get(record.revisionId);
      if (
        !old ||
        record.seq > old.seq ||
        (record.seq === old.seq && record.conflict && !old.conflict)
      )
        merged.set(record.revisionId, record);
    }
    return [...merged.values()];
  }, [learning.records, learning.conflicts, histories]);
  const unresolvedFor = (draft: WritingDraft) =>
    unresolvedWritingConflicts(
      works.find((work) => work.id === draft.recordId),
      allRevisions,
    );
  const unresolved = (draft: WritingDraft) => unresolvedFor(draft).length > 0;
  const updateMission = async (includeRetestCheckpoint = false) => {
    if (!context.block || context.mode === "practice") return;
    checkAccount();
    const submitted = getLearningState().records.filter(
      (work) =>
        work.kind === "essay" &&
        work.planId === plan.id &&
        !work.deleted &&
        !work.conflict &&
        (work.payload.stage !== "draft" ||
          (includeRetestCheckpoint && !!work.payload.retestOf)) &&
        work.payload.date === context.date &&
        work.payload.taskId === context.taskId,
    );
    const isRetest =
      retest || draftsRef.current.some((draft) => !!draft.retestOf);
    const old = selectMission(
      getLearningState().records,
      plan.id,
      context.date,
      context.taskId,
    );
    const complete =
      !isRetest &&
      (context.plannedMinutes < 60
        ? submitted.length > 0
        : ["task1", "task2"].every((type) =>
            submitted.some(
              (work) =>
                work.payload.taskType === type &&
                work.payload.scope !== "paragraph",
            ),
          ));
    const seconds = submitted.reduce(
      (sum, work) => sum + Number(work.payload.elapsedSeconds ?? 0),
      0,
    );
    await saveMission({
      planId: plan.id,
      day: context.day,
      date: context.date,
      block: context.block,
      status:
        (isRetest && old?.payload.status === "completed") || complete
          ? "completed"
          : "partial",
      actualMinutes: isRetest
        ? Math.max(Number(old?.payload.actualMinutes ?? 0), seconds / 60)
        : seconds / 60,
      timeSource: "timer",
      expectedUserId: userId,
    });
  };
  const loadHistory = async (id: string, show = false) => {
    try {
      checkAccount();
      const values = await listRevisions(id);
      checkAccount();
      if (!alive.current) return;
      rememberHistory(id, values);
      if (show) setHistoryWork(id);
    } catch (error) {
      if (alive.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "历史读取失败，原记录仍保留。",
        );
    }
  };
  const newWork = async () => {
    if (busyRef.current || !context.block) return;
    busyRef.current = true;
    setBusy(true);
    window.clearTimeout(autoTimer.current);
    try {
      checkAccount();
      await queue.current.catch(() => {});
      const at = Date.now();
      const paused = draftsRef.current.map((draft) =>
        draft.stage === "submitted"
          ? draft
          : {
              ...draft,
              timer: {
                ...draft.timer,
                elapsedSeconds: elapsedWritingSeconds(draft, at),
                runningSince: null,
              },
              updatedAt: Math.max(at, draft.updatedAt + 1),
            },
      );
      for (const draft of paused.filter((draft) => draft.stage === "draft"))
        await saveWritingDraft(scope, draft);
      checkAccount();
      if (selectedWorkId && context.mode !== "practice") {
        go({ page: "writing", mode: "practice" });
        return;
      }
      const next =
        context.defaultMode === "pair"
          ? [
              makeDraft("task1", false, [...localArchive, ...paused], false),
              makeDraft("task2", false, [...localArchive, ...paused], false),
            ]
          : [
              makeDraft(
                context.defaultMode === "task1" ? "task1" : "task2",
                context.defaultMode === "paragraph",
                [...localArchive, ...paused],
                false,
              ),
            ];
      const newest =
        Math.max(
          at,
          ...localArchive.map((draft) => draft.updatedAt),
          ...paused.map((draft) => draft.updatedAt),
        ) + 1;
      next.forEach((draft, index) => {
        draft.updatedAt = newest + index;
      });
      for (const draft of next) await saveWritingDraft(scope, draft);
      checkAccount();
      if (!alive.current) return;
      mergeArchive([...paused, ...next]);
      setDrafts(next);
      setMode(context.defaultMode);
      setMessage("新草稿已保存在本机，原作品与历史保留。");
      setHistoryWork(null);
      if (selectedWorkId)
        go({
          page: "writing",
          date: context.date,
          day: context.day,
          task: context.taskId,
        });
    } catch (error) {
      if (alive.current)
        setMessage(
          `新草稿未保存：${error instanceof Error ? error.message : "请先保留当前正文。"}`,
        );
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const chooseVersion = async (draft: WritingDraft, revision: Revision) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    window.clearTimeout(autoTimer.current);
    let chosen = false;
    try {
      checkAccount();
      await queue.current.catch(() => {});
      checkAccount();
      const result = await resolveConflict(draft.recordId, revision.revisionId);
      chosen = true;
      checkAccount();
      if (!alive.current) return;
      const next = withTaskTimer({
        ...draftFromRevision(result),
        id: crypto.randomUUID(),
        outline: result.payload.text === draft.text ? draft.outline : "",
        updatedAt: Math.max(Date.now(), draft.updatedAt + 1),
      });
      rememberHistory(result.id, [
        ...(histories[result.id] ?? []),
        ...allRevisions.filter((record) => record.id === result.id),
        result,
      ]);
      setDrafts((previous) =>
        previous.map((value) => (value.recordId === result.id ? next : value)),
      );
      await saveWritingDraft(scope, next);
      checkAccount();
      if (!alive.current) return;
      mergeArchive([next]);
      setMessage("已选择这一版并生成新修订，两份原文仍在历史中。");
      setLocalStatus("选定版本已保存在本机，联网后自动同步。");
    } catch (error) {
      if (alive.current)
        setMessage(
          `${chosen ? "版本已选定；本机草稿未保存：" : "暂未能选择版本："}${error instanceof Error ? error.message : "请重试，历史仍保留。"}`,
        );
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
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
      mergeArchive([result.draft]);
      setLocalStatus(
        submit
          ? "这版原稿已提交，正文只读。"
          : userId
            ? "检查点已保存在本机，等待同步到账号。"
            : "本机检查点已保存。要跨设备同步，请先登录后在账号下写作。",
      );
      if (submit || draft.retestOf) {
        try {
          await updateMission(!!draft.retestOf);
          if (alive.current)
            setMessage(
              draft.retestOf
                ? `${submit ? "复测作品已提交" : "复测检查点已保存"}，只更新原写作块的部分进度。完成后请回订正页自查；当前没有生成评分。`
                : "作品已提交，今日任务已按实际计时更新。",
            );
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
            !work.conflict,
        );
        const adopted = adoptCommittedWritingHead(draft, head);
        if (adopted)
          setDrafts((previous) =>
            previous.map((value) =>
              value.id === draft.id ? withTaskTimer(adopted) : value,
            ),
          );
        setMessage(
          `${adopted ? (adopted.stage === "submitted" ? "作品已提交；本机草稿未保存：" : "检查点已创建，修订基准已恢复；本机草稿未保存：") : "未保存："}${error instanceof Error ? error.message : "请保留正文并重试。"}`,
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
      if (context.correctionId && !context.retestOf)
        Object.assign(next, {
          correctionId: context.correctionId,
          date: context.date,
          day: context.day,
          taskId: context.taskId,
        });
      const result = await checkpointWriting(next, {
        scope,
        expectedUserId: userId,
      });
      if (!alive.current) return;
      go({
        page: "writing",
        work: result.work.id,
        ...(context.correctionId && !context.retestOf
          ? { correctionId: context.correctionId }
          : {}),
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
        <p className="eyebrow">
          {context.mode === "practice" ? "自主练习" : "365天训练"} ·{" "}
          {context.date}
        </p>
        <h1>写作工作台</h1>
        <p>
          {context.mode === "practice"
            ? "参考40分钟，可随时练习和保存；本次作品不完成当天课程任务。"
            : `今日写作计划 ${context.plannedMinutes} 分钟。提纲时间计入写作。`}
        </p>
        {context.block && !retest && (
          <p>
            平台按本节训练范围自动安排题目；已保存稿件继续使用原题，无需先选择材料。
          </p>
        )}
        <a href="#/">返回今日任务</a>
        {retest && (
          <p>
            跨天新题复测：保留原练习范围和题型。提交后请回订正页完成自查，未做反馈前不会判为通过。
          </p>
        )}
        {retestError ? (
          <p role="alert">
            {retestError} <a href="#/review">返回订正</a>
          </p>
        ) : !loaded ? (
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
                disabled={
                  busy ||
                  !!selectedWorkId ||
                  retest ||
                  drafts.some((draft) => !!draft.retestOf)
                }
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
                {context.mode === "practice" &&
                  !draft.conditions.firstAttempt && (
                    <p role="status">复习已做原题，本次不算未见新题。</p>
                  )}
                {context.mode === "practice" && draft.date !== context.date && (
                  <p>继续 {draft.date} 的未交草稿，题目与正文保留。</p>
                )}
                <fieldset
                  disabled={busy}
                  style={{ border: 0, padding: 0, minWidth: 0 }}
                >
                  <DraftEditor
                    draft={draft}
                    now={now}
                    materials={availableWritingMaterials(context.day)}
                    prompts={promptBank.prompts}
                    promptLocked={retest || !!draft.retestOf}
                    onChange={(change) => update(draft.id, change)}
                    onStart={() => start(draft.id)}
                    onPause={() => pause(draft.id)}
                  />
                </fieldset>
                {unresolved(draft) && (
                  <section
                    className="panel"
                    aria-label="写作版本冲突"
                    data-testid="writing-conflicts"
                  >
                    <h3>有两个版本，请选择一份继续</h3>
                    <p>两份原文会保留，选择后生成新修订。</p>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit,minmax(260px,1fr))",
                        gap: 16,
                      }}
                    >
                      {[
                        works.find((work) => work.id === draft.recordId),
                        ...unresolvedFor(draft),
                      ]
                        .filter((work): work is Revision => !!work)
                        .map((work) => (
                          <article
                            key={work.revisionId}
                            data-revision-id={work.revisionId}
                          >
                            <h4>
                              {work.conflict ? "另一设备版本" : "当前版本"}
                            </h4>
                            <small>{work.revisionId}</small>
                            <pre
                              style={{
                                whiteSpace: "pre-wrap",
                                overflowWrap: "anywhere",
                                font: "inherit",
                              }}
                            >
                              {String(work.payload.text ?? "")}
                            </pre>
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy}
                              onClick={() => {
                                void chooseVersion(draft, work);
                              }}
                            >
                              选择此版本
                            </button>
                          </article>
                        ))}
                    </div>
                  </section>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    void loadHistory(draft.recordId, true);
                  }}
                >
                  查看修订历史
                </button>
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
                        materialSelfCheck={
                          draft.materialSelfCheck ??
                          availableWritingMaterials(
                            draft.day ?? context.day,
                          ).find(
                            (item) =>
                              item.id === draft.contentId &&
                              item.version === draft.contentVersion,
                          )?.selfCheck
                        }
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
                          records={allRevisions}
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
        {context.block &&
          !retest &&
          !drafts.some((draft) => !!draft.retestOf) && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !loaded}
              onClick={() => {
                void newWork();
              }}
            >
              新写一篇
            </button>
          )}
        {!works.length && !localArchive.length && <p>暂无已保存作品。</p>}
        {works.map((work) => {
          const self = feedbackForWork(learning.records, work).find(
            (record) => record.payload.source === "self",
          );
          const spelling = self?.payload.spellingCheck;
          const causes = Array.isArray(self?.payload.errorCauses)
            ? self.payload.errorCauses
            : [];
          const labels = writingCauseOptions(
            work.payload.taskType === "task1" ? "task1" : "task2",
          );
          const human = calibrationForWork(learning.records, work).length > 0;
          const pending = learning.records.some(
            (record) =>
              record.id === `writing-handoff:${work.revisionId}` &&
              !record.deleted &&
              !record.conflict &&
              record.payload.status === "in_progress",
          );
          return (
            <article key={work.id} className="panel">
              <a
                data-work-id={work.id}
                data-revision-id={work.revisionId}
                href={`#/writing?work=${encodeURIComponent(work.id)}&date=${String(work.payload.date ?? context.date)}${work.payload.day ? `&day=${work.payload.day}` : ""}${work.payload.taskId ? `&task=${work.payload.taskId}` : ""}`}
              >
                {String(work.payload.date ?? "日期未记录")} ·{" "}
                {work.payload.taskType === "task1"
                  ? "Task 1"
                  : work.payload.taskType === "task2"
                    ? "Task 2"
                    : "任务类型未记录"}{" "}
                · {work.payload.scope === "paragraph" ? "段落练习" : "整篇"} ·{" "}
                {work.payload.parentRevisionId ? "修改稿" : "首稿"} ·{" "}
                {work.payload.stage === "draft" ? "检查点" : "已提交"}
              </a>
              <p>
                {Number(
                  work.payload.wordCount ??
                    words(String(work.payload.text ?? "")).length,
                )}
                词 ·{" "}
                {typeof work.payload.elapsedSeconds === "number"
                  ? `用时 ${formatTime(work.payload.elapsedSeconds)}`
                  : "用时未记录"}
              </p>
              <p>
                错因：
                {causes.length
                  ? causes
                      .map(
                        (cause) =>
                          labels.find((label) => label.id === cause)?.label ??
                          String(cause),
                      )
                      .join("、")
                  : "未标注"}{" "}
                ·{" "}
                {isObject(spelling) && spelling.status === "checked"
                  ? `拼写错误：${spelling.count}处`
                  : "拼写：未检查"}{" "}
                ·{" "}
                {human
                  ? "已有真人评分"
                  : pending
                    ? "待评阅"
                    : "尚未交付真人评阅"}
              </p>
            </article>
          );
        })}
        {localArchive
          .filter((draft) => !works.some((work) => work.id === draft.recordId))
          .sort(
            (a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt,
          )
          .map((draft) => (
            <article key={draft.id}>
              <a
                data-work-id={draft.recordId}
                href={`#/writing?work=${encodeURIComponent(draft.recordId)}&date=${draft.date}${draft.day ? `&day=${draft.day}` : ""}${draft.taskId ? `&task=${draft.taskId}` : ""}`}
              >
                {draft.date} ·{" "}
                {draft.taskType === "task1" ? "Task 1" : "Task 2"} ·{" "}
                {draft.scope === "paragraph" ? "段落练习" : "整篇"} · 本机草稿 ·{" "}
                {words(draft.text).length}词
              </a>
            </article>
          ))}
      </section>
      {historyWork && (
        <section className="panel" aria-label="写作修订历史">
          <h2>修订历史</h2>
          <p className="muted">原始修订只读，包含冲突版本。</p>
          {(histories[historyWork] ?? [])
            .slice()
            .sort((a, b) => b.seq - a.seq || b.createdAt - a.createdAt)
            .map((work) => (
              <article key={work.revisionId} data-revision-id={work.revisionId}>
                <h3>
                  {work.payload.stage === "draft" ? "检查点" : "提交稿"}
                  {work.conflict ? " · 冲突版本" : ""}
                </h3>
                <small>{work.revisionId}</small>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    font: "inherit",
                    overflowWrap: "anywhere",
                  }}
                >
                  {String(work.payload.text ?? "")}
                </pre>
              </article>
            ))}
        </section>
      )}
    </div>
  );
}
function DraftEditor({
  draft,
  materials,
  prompts,
  promptLocked,
  now,
  onChange,
  onStart,
  onPause,
}: {
  draft: WritingDraft;
  materials: WritingMaterial[];
  prompts: readonly LocalPrompt[];
  promptLocked: boolean;
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
  const imported = prompts.find(
    (prompt): prompt is Extract<LocalPrompt, { skill: "writing" }> =>
      prompt.skill === "writing" &&
      prompt.id === draft.contentId &&
      prompt.version === draft.contentVersion,
  );
  const locked = promptLocked || !!imported;
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
      {imported ? (
        <p role="status">
          平台已安排{draft.taskType === "task1" ? "Task 1" : "Task 2"} ·{" "}
          {imported.questionType}，材料已就绪。
        </p>
      ) : (
        !draft.prompt.trim() && (
          <p role="alert">
            平台暂缺本节已就绪的新题；原题图或材料补齐后会自动安排，不用旧题或生成题充数。
          </p>
        )
      )}
      {!promptLocked && (
        <PromptPicker
          prompts={prompts}
          skill="writing"
          taskType={draft.taskType}
          value={imported && promptKey(imported)}
          disabled={!canChooseWritingPrompt(draft)}
          onChoose={(prompt) =>
            onChange((previous) => writingWithPrompt(previous, prompt))
          }
        />
      )}
      <PromptStimulus prompt={imported} />
      <fieldset
        disabled={draft.stage === "submitted"}
        style={{ border: 0, padding: 0, minWidth: 0 }}
      >
        {!imported && (
          <label className="field">
            <span>题目来源</span>
            <select
              aria-label="题目来源"
              disabled={locked}
              value={imported ? "external" : source}
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
        )}
        {source === "builtin" && !imported && (
          <>
            <label>
              内置题目
              <select
                aria-label="内置题目"
                disabled={locked}
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
        {(source === "external" || imported) && (
          <label className="field">
            <span>{imported ? "平台材料出处" : "外部题出处（必填）"}</span>
            <input
              aria-label="外部题出处"
              readOnly={locked}
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
            readOnly={locked || source === "builtin"}
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
        {source !== "builtin" && !imported && draft.taskType === "task1" && (
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
            disabled={draft.timer.runningSince !== null || !draft.prompt.trim()}
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
            disabled={!draft.conditions.firstAttempt}
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
