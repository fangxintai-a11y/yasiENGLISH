import {
  isListeningSequenceMaterial,
  LISTENING_SEQUENCE_REPLAY_EVENT,
} from "../../listeningSequence";
import {
  applyAnswerReviewsToMaterial,
  projectReviewedAttempts,
  reviewedAttempt,
  reviewedOfficialTypeCalibration,
} from "../../answerReviewModel";
import { acceptedMaterialPreferences } from "../../weeklyReview";
import { calibrationWeekIndex } from "../../writingCalibration";
import {
  isHeldOutListeningReading,
  assertRetestMaterialEligible,
  selectRetest,
  estimatedRetestMinutes,
} from "../../retestSelection";
import { correctionOriginal } from "../../correctionModel";
import { withRevisionReferences } from "../../revisionReferences";
import {
  ListeningReadingPlan,
  readingDailyRequirements,
  MATERIAL_SOURCE_LABELS,
  PRACTICE_SCOPE_LABELS,
} from "./ListeningReadingPlan";
import { ShortStudy } from "./ShortStudy";
import { useAtlas } from "../../../atlas/context";
import { store } from "../../../store/store";
import { OfficialResources } from "../OfficialResources";
import { ReadingReview } from "./ReadingReview";
import { ReadingErrorBook } from "./ReadingErrorBook";
import {
  PracticeClock,
  practiceDraftKey,
  readPracticeDraft,
  savePracticeDraft,
  clearPracticeDraft,
} from "../../practiceDraft";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDailyMaterialLibrary } from "../../useDailyMaterialLibrary";
import { automaticMaterialForTask, selectIndependentListeningReading, wasListeningReadingAttempted } from "../../dailyMaterialPlan";
import type { LocalMaterial } from "../../localBankSchema";
import { useLearning, getLearningState, saveRecord } from "../../repository";
import { selectMission, saveMission } from "../../missionRecords";
import {
  attemptPayload,
  countReadingWords,
  currentAttempts,
  estimatedReadingListeningBand,
  gradeMaterial,
  orderedReadingQuestions,
  readingCoverage,
  readingCoverageLabel,
} from "../../readingModel";
import { go } from "../../../lib/router";
import type { PracticeContext } from "../../listeningReadingTasks";
import type { Revision } from "../../protocol";
import { ReadingQuestions } from "./ReadingQuestions";
import { ListeningMethodCard } from "../listening/ListeningMethodCard";
import { listeningSectionForDay } from "../../listeningLadder";

export interface PlaybackConditions {
  replayed: boolean;
  transcriptViewed: boolean;
  replays: number;
  sequential?: boolean;
}
export function ReadingSession({
  plan,
  context,
  userId,
  initialWorkId,
  initialMaterialId,
  workflow,
  skill = "reading",
  playback,
  onAttemptSaved,
}: {
  plan: Revision;
  context: PracticeContext;
  userId: string | null;
  initialWorkId?: string;
  initialMaterialId?: string;
  workflow?: { correctionId?: string; retestOf?: string };
  skill?: "reading" | "listening";
  playback?: (
    material: LocalMaterial,
    review: boolean,
    onConditions: (conditions: PlaybackConditions) => void,
    onReady: (ready: boolean) => void,
    evidenceVisible: boolean,
  ) => ReactNode;
  onAttemptSaved?: (material: LocalMaterial) => void;
}) {
  const learning = useLearning();
  const atlas = useAtlas();
  const library = useDailyMaterialLibrary(userId, plan.id);
  const { bank, ready: loaded } = library;
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [holdout, setHoldout] = useState(false);
  const [ignoreLocalResume, setIgnoreLocalResume] = useState(false);
  const [chosen, setChosen] = useState(initialMaterialId ?? ""),
    [answers, setAnswers] = useState<string[]>([]),
    [started, setStarted] = useState<number | null>(null),
    [now, setNow] = useState(Date.now);
  const [activeWorkId, setActiveWorkId] = useState<string | null>(
    initialWorkId ?? null,
  );
  const [busy, setBusy] = useState(false),
    [pane, setPane] = useState<"passage" | "questions">(
      skill === "reading" ? "passage" : "questions",
    );
  const [playbackReady, setPlaybackReady] = useState(skill === "reading");
  const playbackReadyRef = useRef(skill === "reading");
  const activeClock = useRef(new PracticeClock());
  const submittedDraftKey = useRef<string | null>(null);
  const [highlight, setHighlight] = useState<{
    quote: string;
    paragraphId?: string;
    offset?: number;
  } | null>(null);
  const inFlight = useRef(false),
    alive = useRef(true),
    conditions = useRef<PlaybackConditions>({
      replayed: false,
      transcriptViewed: false,
      replays: 0,
    });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const work = activeWorkId
    ? (currentAttempts(learning.records, plan.id).find(
        (record) =>
          record.id === activeWorkId && record.payload.skill === skill,
      ) ?? null)
    : null;
  const materialKey = (m: LocalMaterial) =>
    `${m.id}@${m.version}@${m.contentHash}`;
  const preferences = useMemo(
    () =>
      acceptedMaterialPreferences(
        learning.records,
        plan.id,
        context.day < 1 ? 0 : calibrationWeekIndex(plan, context.date),
      ),
    [learning.records, plan, context.date, context.day],
  );
  const automatic = useMemo(() => {
    if (!loaded || !context.block || workflow?.retestOf) return null;
    return automaticMaterialForTask({ plan, records: learning.records, bank,
      prompts: library.prompts, localWorks: library.localWorks,
      localMaterials: library.localMaterials }, { day: context.day, taskId: context.taskId });
  }, [loaded, plan, learning.records, bank, library.prompts, library.localWorks, library.localMaterials,
    context.block, context.day, context.taskId, workflow?.retestOf]);
  const independent = useMemo(() => context.mode === "practice"
    ? selectIndependentListeningReading({ skill, bank, records: learning.records,
        preferredSection: skill === "listening" ? listeningSectionForDay(context.day) : undefined,
        preferredQuestionTypes: preferences.questionTypes[skill] }) : null,
    [context.mode, context.day, skill, bank, learning.records, preferences]);
  const plannedRef = automatic?.materials.find(ref => !ref.completed) ?? automatic?.materials[0];
  const plannedMaterial = plannedRef ? bank.find(m => m.id === plannedRef.id &&
    m.version === plannedRef.version && m.contentHash === plannedRef.contentHash) ?? null : null;
  const localRef = context.mode === "practice" && !ignoreLocalResume ? library.localMaterials.find(ref =>
    ref.date === context.date && ref.taskId === context.taskId && (!ref.skill || ref.skill === skill)) : null;
  const restoredMaterial = localRef ? bank.find(m => m.skill === skill && m.contentHash === localRef.contentHash &&
    (!localRef.id || m.id === localRef.id) && (!localRef.version || m.version === localRef.version)) ?? null : null;
  const materials = bank.filter(m => m.skill === skill &&
    ((holdout ? m.pool === "holdout" : !isHeldOutListeningReading(m, bank)) ||
      (m.id === plannedMaterial?.id && m.contentHash === plannedMaterial.contentHash) ||
      m.id === work?.payload.contentId));
  const preferred = !loaded ? null : holdout
    ? (materials.find(m => m.pool === "holdout" && (!context.requiresFull ||
      (m.scope === "full" && m.questions.length === 40))) ?? null)
    : context.mode === "practice"
      ? localRef ? restoredMaterial : independent?.material ?? null
      : plannedMaterial;
  const selected = work
    ? materials.find(
        (m) =>
          m.id === work.payload.contentId &&
          m.version === work.payload.contentVersion &&
          m.contentHash === work.payload.contentHash,
      )
    : chosen
      ? (materials.find((m) => materialKey(m) === chosen || m.id === chosen) ??
        null)
      : preferred;
  const material = selected
    ? {
        ...selected,
        questions:
          skill === "reading"
            ? orderedReadingQuestions(selected)
            : selected.questions,
      }
    : null;
  const isReferenceShort =
    material?.scope === "short" && material.questions.length === 0;
  const passage = material?.skill === "reading" ? material.passage : "";
  const paragraphs = material?.skill === "reading" ? material.paragraphs : [];
  const transcript = material?.skill === "listening" ? material.transcript : "";
  const minutes =
    material?.skill === "listening"
      ? isListeningSequenceMaterial(material)
        ? (material.estimatedMinutes ?? 30)
        : material.audio
          ? Math.ceil(material.audio.durationSeconds / 60) + 1
          : 20
      : material?.scope === "full"
        ? 60
        : material?.scope === "type-drill"
          ? 5
          : 20;
  const elapsed = started === null ? 0 : Math.max(0, (now - started) / 1000);
  const liveAccount = () => {
    const state = getLearningState();
    if (!state.ready || state.userId !== userId)
      throw new Error("账号已经切换，请重新进入练习。");
    return state;
  };
  const draftKey = material
    ? practiceDraftKey(
        userId,
        plan.id,
        material.contentHash,
        context.date,
        context.taskId,
      )
    : null;
  useEffect(() => {
    if (work || !material || !draftKey) return;
    const draft = readPracticeDraft(draftKey, material.questions.length);
    activeClock.current = new PracticeClock(draft?.activeSeconds ?? 0);
    if (!draft) activeClock.current.pause();
    setAnswers(draft?.answers ?? material.questions.map(() => ""));
    setStarted(draft?.startedAt ?? null);
    setNow(Date.now());
    playbackReadyRef.current = skill === "reading";
    setPlaybackReady(playbackReadyRef.current);
    if (draft) {
      setChosen(materialKey(material));
      setMessage("已恢复本机未提交答案与原始计时。");
    }
  }, [draftKey, work?.id]);
  useEffect(() => {
    if (work || !draftKey || started === null) return;
    const checkpoint = () => {
      if (submittedDraftKey.current === draftKey) return;
      try {
        savePracticeDraft(draftKey, {
          answers,
          startedAt: started,
          activeSeconds: activeClock.current.value(),
        });
      } catch {
        setMessage("未提交答案暂时无法写入本机，请保留当前页面完成后提交。");
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") activeClock.current.pause();
      else activeClock.current.resume();
      checkpoint();
    };
    const hide = () => {
      activeClock.current.pause();
      checkpoint();
    };
    activeClock.current.resume();
    visibility();
    const timer = window.setInterval(checkpoint, 5000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    return () => {
      activeClock.current.pause();
      checkpoint();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
    };
  }, [draftKey, work?.id, started, answers]);
  const assertRetest = () => {
    if (!material) throw new Error("材料不在当前可选题库，请重新选题。");
    if (!workflow?.retestOf) {
      if (!holdout && isHeldOutListeningReading(material, bank) &&
          !(automatic?.checkpoint && automatic.materials.some(ref => ref.id === material.id &&
            ref.version === material.version && ref.contentHash === material.contentHash)))
        throw new Error(
          "这是独立检查池的原件或别名；日常练习请选其他材料，检查测评请明确打开独立检查池。",
        );
      return;
    }
    if (!material || !workflow.correctionId)
      throw new Error("复测关联不完整，请从订正页重新进入。");
    const state = liveAccount(),
      records = withRevisionReferences(state.records);
    const correction = state.records.find(
      (r) =>
        r.id === workflow.correctionId &&
        r.kind === "correction" &&
        r.planId === plan.id &&
        !r.conflict,
    );
    if (!correction) throw new Error("这条订正尚未同步，请先回订正页。");
    const ctx = {
      planId: plan.id,
      date: context.date,
      day: context.day,
      records,
      materials: bank,
      prompts: [],
    };
    if (selectRetest(correction, ctx).retestOf !== workflow.retestOf)
      throw new Error("复测未绑定原问题的准确修订。");
    assertRetestMaterialEligible(correction, material, ctx);
    const original = correctionOriginal(correction, records)!;
    const used = Number(
      selectMission(state.records, plan.id, context.date, context.taskId)
        ?.payload.actualMinutes ?? 0,
    );
    if (
      !context.block ||
      estimatedRetestMinutes(material, original) >
        Math.max(0, context.plannedMinutes - used)
    )
      throw new Error("当天同科预算不足，复测留到能容纳的任务。");
  };
  const start = () => {
    try {
      assertRetest();
    } catch (e) {
      setError(e instanceof Error ? e.message : "复测不能开始。");
      return;
    }
    if (context.mode !== "practice" && (context.day < 1 || context.day > 365)) {
      setError("当天不在365天计划内，可以查看已有作答，或从今日进入有效任务。");
      return;
    }
    setError("");
    if (material) setChosen(materialKey(material));
    setHighlight(null);
    setMessage("");
    activeClock.current = new PracticeClock();
    submittedDraftKey.current = null;
    playbackReadyRef.current = skill === "reading";
    setPlaybackReady(playbackReadyRef.current);
    conditions.current = {
      replayed: false,
      transcriptViewed: false,
      replays: 0,
    };
    setAnswers(material?.questions.map(() => "") ?? []);
    setStarted(Date.now());
    setNow(Date.now());
  };
  const submit = async () => {
    if (!material || started === null || inFlight.current) return;
    if (skill === "listening" && !playbackReadyRef.current) {
      setError(
        isListeningSequenceMaterial(material)
          ? "请顺序听完四节并完成统一两分钟检查，再提交。"
          : "请完整听完首答音频并完成一分钟检查，再提交。",
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      assertRetest();
      const state = liveAccount();
      const seconds = Math.min(
        86400,
        Math.max(0, (Date.now() - started) / 1000),
      );
      const payload = attemptPayload(
        applyAnswerReviewsToMaterial(material, state.records, plan.id),
        material.questions.map((_, i) => answers[i] ?? ""),
        {
          planId: plan.id,
          date: context.date,
          ...(context.mode !== "practice" && context.day >= 1 && context.day <= 365 ? { day: context.day } : {}),
          ...(context.taskId ? { taskId: context.taskId } : {}),
        },
        state.records,
        seconds,
        { timed: seconds <= minutes * 60, ...conditions.current },
        skill === "reading"
          ? readingCoverage(
              passage,
              store.get().progress.mistakes.flatMap((id) => {
                const word = atlas.byId.get(id);
                return word ? [word] : [];
              }),
            )
          : undefined,
      );
      if (context.mode === "practice" && wasListeningReadingAttempted(material, bank, state.records)) {
        payload.firstAttempt = false;
        payload.conditions = { ...(payload.conditions as Record<string, unknown>), firstAttempt: false, unseen: false };
      }
      // Persist only known-correct first outcomes; wrong answers acquire a real cause in B review.
      payload.questionResults = gradeMaterial(
        applyAnswerReviewsToMaterial(material, state.records, plan.id),
        payload.answers as string[],
      )
        .questionResults.filter((q) => q.correct)
        .map((q) => ({
          questionId: q.questionId,
          correct: true,
          confidence: "unsure",
          errorCause: null,
        }));
      if (workflow?.retestOf && workflow.correctionId)
        Object.assign(payload, {
          retestOf: workflow.retestOf,
          correctionId: workflow.correctionId,
        });
      payload.actualMinutes = activeClock.current.value() / 60;
      const record = await saveRecord({
        id: `attempt-${crypto.randomUUID()}`,
        kind: "attempt",
        payload,
        baseRevision: null,
      }, userId);
      if (alive.current && getLearningState().userId === userId) {
        submittedDraftKey.current = draftKey;
        activeClock.current.pause();
        setActiveWorkId(record.id);
        setMessage("首答已保存。");
        try {
          if (draftKey) clearPracticeDraft(draftKey);
          onAttemptSaved?.(material);
        } catch {
          setMessage("首答已保存；本机草稿清理未完成，请勿重复提交。");
        }
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "作答未保存，请重试。");
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const complete = async () => {
    if (!work || !context.block || busy) return;
    if (!reviewFinished) {
      setError("请先完成A-B复盘并为错题选择错因，或标答案存疑并说明。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      liveAccount();
      const daily =
        context.day <= 14 && skill === "reading"
          ? readingDailyRequirements(
              getLearningState().records,
              plan.id,
              context.date,
              context.taskId,
            )
          : null;
      const fullMissing =
        context.requiresFull &&
        !currentAttempts(getLearningState().records, plan.id).some(
          (r) =>
            r.payload.skill === skill &&
            r.payload.taskId === context.taskId &&
            r.payload.date === context.date &&
            r.payload.scope === "full" &&
            r.payload.total === 40 &&
            Array.isArray(r.payload.questionResults) &&
            r.payload.questionResults.length === 40 &&
            r.payload.questionResults.every(
              (q) =>
                !!q &&
                typeof q === "object" &&
                "reviewCorrect" in q &&
                typeof q.reviewCorrect === "boolean",
            ),
        );
      await saveMission({
        planId: plan.id,
        day: context.day,
        date: context.date,
        block: context.block,
        status:
          fullMissing || (daily && !daily.complete) ? "partial" : "completed",
        actualMinutes: currentAttempts(getLearningState().records, plan.id)
          .filter(
            (r) =>
              r.payload.taskId === context.taskId &&
              r.payload.date === context.date,
          )
          .reduce((sum, r) => sum + Number(r.payload.actualMinutes ?? 0), 0),
        timeSource: "timer",
        expectedUserId: userId,
      });
      if (alive.current)
        setMessage(
          fullMissing
            ? "单节或单篇已保存为部分完成；完整测评还需完成整套内容。"
            : daily && !daily.complete
              ? "本次进度已保存；前14天阅读还需完成官方题型练习和一篇新正篇的复盘。"
              : "本次任务已完成，按实际用时记录。",
        );
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "任务未保存。");
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const evidenceVisible = !!work && Array.isArray(work.payload.reviewAnswers);
  const reviewFinished =
    !!work &&
    Array.isArray(work.payload.questionResults) &&
    work.payload.questionResults.length === material?.questions.length &&
    work.payload.questionResults.every(
      (q) =>
        typeof (q as { reviewCorrect?: unknown }).reviewCorrect === "boolean",
    );
  const effectiveMaterial = material
    ? applyAnswerReviewsToMaterial(material, learning.records, plan.id)
    : null;
  const reviewed =
    material && work
      ? reviewedAttempt(work, material, learning.records, plan.id)
      : null;
  const projection = useMemo(
    () => projectReviewedAttempts(learning.records, bank, plan.id),
    [learning.records, bank, plan.id],
  );
  const officialCalibration = useMemo(
    () => reviewedOfficialTypeCalibration(learning.records, bank, plan.id),
    [learning.records, bank, plan.id],
  );
  const result =
    material && work
      ? gradeMaterial(material, work.payload.answers as string[])
      : null;
  return (
    <div className="page r4-page">
      <section
        className="panel"
        aria-label={`${skill === "reading" ? "阅读" : "听力"}练习`}
        data-testid="lr-workbench"
      >
        <p className="eyebrow">365天训练 · {context.date}</p>
        <h1>{skill === "reading" ? "阅读" : "听力"}练习</h1>
        <a href="#/">返回今日</a>
        {context.mode !== "practice" && context.day < 1 && (
          <p>365天计划尚未开始（开始日期：{String(plan.payload.startDate)}）。可以先浏览材料，到开始日后再进行限时首答。</p>
        )}
        {context.mode !== "practice" && context.day > 365 && (
          <p>当天不在365天计划内；已有作答继续保留。</p>
        )}
        {context.mode === "practice" && <p role="status">自主练习 · 随时可学。平台自动选题，学习成果正常保存，不计入今日课程完成度。</p>}
        {loaded && context.mode === "practice" && <p>{independent?.notice}</p>}
        {loaded && automatic && <section aria-label="本节自动安排">
          <h2>本节平台已安排</h2><ol>{automatic.materials.map(ref => <li key={`${ref.id}:${ref.contentHash}`}>
            {ref.title}{ref.role === "calibration" ? " · 题型热身" : ""}{ref.role === "assessment" ? " · 独立检查" : ""}{ref.completed ? " · 已复盘" : ""}
          </li>)}</ol><p>{automatic.notice}</p>
        </section>}
        {!loaded && <p role="status">正在自动准备练习材料…</p>}
        {library.issues.length > 0 && <details><summary>材料准备提示</summary><ul>{library.issues.map((issue,index) => <li key={index}>{issue}</li>)}</ul></details>}
        {loaded && !materials.some((m) => !m.id.endsWith("-sample-01")) && (
          <p>
            题库导入后自动加入。还没导入题库，当前仅有离线样例。
            <a href="#/me">我的 → 题库</a>
          </p>
        )}
        <details className="r4-material-options"><summary>查看或更换材料（可选）</summary>
        {loaded && (
          <ListeningReadingPlan
            bank={bank}
            records={learning.records}
            planId={plan.id}
            day={context.day}
            date={context.date}
            skill={skill}
            requiresFull={context.requiresFull}
            preferences={preferences}
            officialCalibration={officialCalibration}
            disabled={started !== null || !!work || busy}
            onChoose={(m) => {
              if (started !== null || work || busy) return;
              setChosen(materialKey(m));
              setHighlight(null);
            }}
          />
        )}
        <OfficialResources />
        {!work && (
          <label className="r4-choice">
            <input
              type="checkbox"
              aria-label="独立检查池"
              disabled={started !== null || busy || !!workflow?.retestOf}
              checked={holdout}
              onChange={(e) => {
                setHoldout(e.target.checked);
                setChosen("");
              }}
            />
            查看独立检查池（不用于日常选材）
          </label>
        )}
        {workflow?.retestOf && (
          <p role="status">
            这是隔天未见新题复测。完成首答和A-B复盘后，请返回订正页记录本轮结果。
          </p>
        )}
        {!work && (
          <label className="field" style={{ display: "block", width: "100%", minWidth: 0, maxWidth: "100%" }}>
            <span>练习材料</span>
            <select
              aria-label="练习材料"
              style={{
                display: "block",
                width: "100%",
                maxWidth: "100%",
                minWidth: 0,
              }}
              disabled={started !== null || busy || !!workflow?.retestOf}
              value={selected ? materialKey(selected) : ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              <option value="" disabled>
                请选择材料；重做会保留重复练习标记
              </option>
              {materials.map((m) => (
                <option key={`${m.id}:${m.version}`} value={materialKey(m)}>
                  {m.title} · {m.version} ·{" "}
                  {MATERIAL_SOURCE_LABELS[m.source.materialSource]}
                </option>
              ))}
            </select>
          </label>
        )}
        </details>
        {material && (
          <>
            <h2>{material.title}</h2>
            {!!material.instructions?.length && (
              <ul>
                {material.instructions.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            )}
            <p>
              {material.source.materialSource === "official"
                ? "官方样题"
                : material.source.materialSource === "cambridge"
                  ? "剑桥材料"
                  : "参考"}{" "}
              · {material.source.sourceRef} ·{" "}
              {PRACTICE_SCOPE_LABELS[material.scope]}
            </p>
            {skill === "reading" && (
              <p>
                篇幅 {countReadingWords(passage)} 词 · 单篇20分钟 /
                整套60分钟。短专项单独记录，不计入长文库存。
              </p>
            )}
            <p>{context.mode === "practice" ? `自主练习参考 ${minutes} 分钟，按自己的节奏进行；实际用时单独保存。` : `本块计划 ${context.plannedMinutes} 分钟；实际计时单独保存。`}</p>
            {isReferenceShort ? (
              <ShortStudy
                key={material.contentHash}
                material={material}
                plan={plan}
                context={context}
                userId={userId}
                work={work}
                onSaved={(record) => setActiveWorkId(record.id)}
              />
            ) : (
              <>
                {skill === "listening" && (
                  <ListeningMethodCard
                    material={material}
                    day={context.day}
                    collapsed={started !== null || !!work}
                  />
                )}
                {!work && started === null && (
                  <button
                    className="btn btn-primary"
                    onClick={start}
                    disabled={
                      busy ||
                      !!activeWorkId ||
                      (context.mode !== "practice" && (context.day < 1 || context.day > 365))
                    }
                  >
                    开始限时首答
                  </button>
                )}
                {!work && started !== null && (
                  <p role="timer">
                    已用 {Math.floor(elapsed / 60)}:
                    {String(Math.floor(elapsed % 60)).padStart(2, "0")}
                    {elapsed > minutes * 60
                      ? " · 已超时，提交时记为非限时"
                      : ""}
                  </p>
                )}
                {(started !== null || work) && (
                  <>
                    {skill === "listening" &&
                      playback?.(
                        material,
                        !!work,
                        (value) => {
                          conditions.current = value;
                        },
                        (ready) => {
                          playbackReadyRef.current = ready;
                          setPlaybackReady(ready);
                        },
                        evidenceVisible,
                      )}
                    <div className="r4-mobile-switch">
                      {(skill === "reading" || evidenceVisible) && (
                        <button
                          className="btn btn-ghost"
                          onClick={() => setPane("passage")}
                        >
                          查看原文
                        </button>
                      )}
                      <button
                        className="btn btn-ghost"
                        onClick={() => setPane("questions")}
                      >
                        查看题目
                      </button>
                    </div>
                    <div
                      className={`r4-columns r4-show-${pane} ${skill === "listening" ? "r4-listening" : ""} ${evidenceVisible ? "r4-has-transcript" : ""}`}
                    >
                      <article className="r4-passage" aria-label="阅读原文">
                        {skill === "reading" &&
                          paragraphs.map((p, i) => (
                            <p key={p.id} data-paragraph-id={p.id}>
                              <b>{p.label ?? String.fromCharCode(65 + i)}.</b>{" "}
                              {evidenceVisible &&
                              highlight &&
                              (!highlight.paragraphId ||
                                highlight.paragraphId === p.id) &&
                              p.text.includes(highlight.quote) ? (
                                <>
                                  {p.text.slice(
                                    0,
                                    highlight.offset ??
                                      p.text.indexOf(highlight.quote),
                                  )}
                                  <mark>{highlight.quote}</mark>
                                  {p.text.slice(
                                    (highlight.offset ??
                                      p.text.indexOf(highlight.quote)) +
                                      highlight.quote.length,
                                  )}
                                </>
                              ) : (
                                p.text
                              )}
                            </p>
                          ))}
                        {skill === "listening" && evidenceVisible && (
                          <p>{transcript}</p>
                        )}
                      </article>
                      <section className="r4-questions" aria-label="作答题目">
                        <ReadingQuestions
                          material={material}
                          answers={
                            work ? (work.payload.answers as string[]) : answers
                          }
                          disabled={!!work || busy}
                          onChange={setAnswers}
                        />
                      </section>
                    </div>
                    {!work && (
                      <button
                        className="btn btn-primary"
                        disabled={
                          busy || (skill === "listening" && !playbackReady)
                        }
                        onClick={() => void submit()}
                      >
                        提交首答
                      </button>
                    )}
                  </>
                )}
                {work && result && (
                  <section aria-label="首答结果">
                    <h2>
                      首答 {work.payload.score as number}/
                      {work.payload.total as number}
                    </h2>
                    {reviewed?.questions.some((q) => q.verdict) && (
                      <p role="status">
                        原分 {reviewed.originalScore}/{reviewed.originalTotal} ·
                        校正后 {reviewed.correctedScore}/{reviewed.total} · 排除{" "}
                        {reviewed.excluded} 题；首答原分保留。
                        <a href="#/review?tab=answers">
                          查看答案审校与补选错因
                        </a>
                      </p>
                    )}
                    <p>
                      {work.payload.firstAttempt
                        ? "新材料首答"
                        : "重复练习，不算新首答"}{" "}
                      ·{" "}
                      {material.source.materialSource === "official" ||
                      material.source.materialSource === "cambridge"
                        ? "官方/剑桥材料"
                        : "参考"}
                    </p>
                    {estimatedReadingListeningBand(
                      Number(work.payload.score),
                      Number(work.payload.total),
                      String(work.payload.scope),
                    ) !== null && (
                      <p>
                        整套估算分{" "}
                        {estimatedReadingListeningBand(
                          Number(work.payload.score),
                          Number(work.payload.total),
                          String(work.payload.scope),
                        )}
                        （练习换算，非正式成绩）
                      </p>
                    )}
                    {work.payload.scope === "full" &&
                      work.payload.total === 40 && (
                        <p>
                          <a
                            href="https://ielts.idp.com/thailand/results/how-ielts-is-marked"
                            target="_blank"
                            rel="noreferrer"
                          >
                            估算换算参考
                          </a>
                          ：实际试卷分界可能不同；原始分低于本表范围时仅保留正确数。
                        </p>
                      )}
                    <ReadingReview
                      key={work.id}
                      material={effectiveMaterial ?? material}
                      originalMaterial={material}
                      onReplay={
                        isListeningSequenceMaterial(material)
                          ? (seconds, questionId) => {
                              window.dispatchEvent(
                                new CustomEvent(
                                  LISTENING_SEQUENCE_REPLAY_EVENT,
                                  {
                                    detail: {
                                      materialId: material.id,
                                      contentHash: material.contentHash,
                                      questionId,
                                      seconds,
                                    },
                                  },
                                ),
                              );
                            }
                          : undefined
                      }
                      work={work}
                      userId={userId}
                      onSaved={(record) => setActiveWorkId(record.id)}
                      onEvidence={(quote, paragraphId, offset) => {
                        setHighlight({ quote, paragraphId, offset });
                        setPane("passage");
                        window.requestAnimationFrame(() =>
                          document
                            .querySelector(".r4-passage mark")
                            ?.scrollIntoView({ block: "center" }),
                        );
                      }}
                    />
                    <p>
                      目标词覆盖：
                      {readingCoverageLabel(work.payload.coverage)}
                    </p>
                    {reviewFinished && automatic?.materials.find(ref => !ref.completed && ref.id !== material.id) &&
                      <a className="btn btn-primary" href={automatic.materials.find(ref => !ref.completed && ref.id !== material.id)!.route}>继续本节下一份材料</a>}
                    {context.mode === "practice" && <button className="btn btn-primary" disabled={busy} onClick={() => {
                      setIgnoreLocalResume(true); setChosen(""); setActiveWorkId(null); setStarted(null); setAnswers([]); setHighlight(null); setMessage("");
                      go({ page: skill, mode: "practice" });
                    }}>再来一份自动练习</button>}
                    {context.block && (
                      <button
                        className="btn btn-primary"
                        disabled={busy || !reviewFinished}
                        onClick={() => void complete()}
                      >
                        完成本次任务
                      </button>
                    )}
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setChosen(selected ? materialKey(selected) : "");
                        setActiveWorkId(null);
                        setStarted(null);
                        setAnswers([]);
                        if (context.mode === "practice") go({ page: skill, mode: "practice", material: selected ? materialKey(selected) : undefined });
                      }}
                      disabled={busy}
                    >
                      再做一次
                    </button>
                  </section>
                )}
              </>
            )}
          </>
        )}
        {loaded && !material && (
          <p>
            {activeWorkId
              ? "本机没有这版材料，请在“我的 → 题库”导入同一版本。原作答仍保留。"
              : "当前没有推荐的新材料，请补齐库存；也可在列表中明确选择重做。"}
          </p>
        )}
        {work && !material && (
          <section aria-label="已保存首答">
            <h2>
              首答 {String(work.payload.score ?? "未知")}/
              {String(work.payload.total ?? "未知")}
            </h2>
            <p>
              材料来源：{String(work.payload.materialSource ?? "未分类")} ·
              目标词覆盖：{readingCoverageLabel(work.payload.coverage)}
            </p>
          </section>
        )}
        {activeWorkId && !work && (
          <p role="status">
            正在读取作答；若同步后仍未出现，请检查是否已删除或存在同步冲突。
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </section>
      <section className="panel" aria-label="我的听读练习">
        <h2>我的{skill === "reading" ? "阅读" : "听力"}</h2>
        {!currentAttempts(learning.records, plan.id).some(
          (r) => r.payload.skill === skill,
        ) && <p>尚无作答。</p>}
        {currentAttempts(learning.records, plan.id)
          .filter((r) => r.payload.skill === skill)
          .map((record) => (
            <article key={record.id} data-attempt-id={record.id}>
              <p>
                {String(record.payload.date ?? "日期未记录")} ·{" "}
                {String(record.payload.sourceRef ?? record.payload.contentId)} ·{" "}
                {String(record.payload.score ?? "未判分")}/
                {String(record.payload.total ?? "—")} ·{" "}
                {record.payload.materialSource === "official" ||
                record.payload.materialSource === "cambridge"
                  ? "官方/剑桥材料"
                  : "参考"}
              </p>
              <a
                className="btn btn-ghost"
                href={`#/${skill}?${new URLSearchParams({ work: record.id, date: String(record.payload.date ?? context.date) })}`}
              >
                查看作答
              </a>
            </article>
          ))}
      </section>
      <ReadingErrorBook
        records={projection.records}
        planId={plan.id}
        bank={bank}
        today={context.date}
      />
    </div>
  );
}
