import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadLocalBank } from "../../localBank";
import type { LocalMaterial } from "../../localBankSchema";
import { useLearning, getLearningState, saveRecord } from "../../repository";
import { saveMission } from "../../missionRecords";
import {
  attemptPayload,
  countReadingWords,
  currentAttempts,
  estimatedReadingListeningBand,
  gradeMaterial,
  orderedReadingQuestions,
} from "../../readingModel";
import type { PracticeContext } from "../../listeningReadingTasks";
import type { Revision } from "../../protocol";
import { ReadingQuestions } from "./ReadingQuestions";

export interface PlaybackConditions {
  replayed: boolean;
  transcriptViewed: boolean;
  replays: number;
}
export function ReadingSession({
  plan,
  context,
  userId,
  initialWorkId,
  initialMaterialId,
  skill = "reading",
  playback,
}: {
  plan: Revision;
  context: PracticeContext;
  userId: string | null;
  initialWorkId?: string;
  initialMaterialId?: string;
  skill?: "reading" | "listening";
  playback?: (
    material: LocalMaterial,
    review: boolean,
    onConditions: (conditions: PlaybackConditions) => void,
  ) => ReactNode;
}) {
  const learning = useLearning();
  const [bank, setBank] = useState<LocalMaterial[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [chosen, setChosen] = useState(initialMaterialId ?? ""),
    [answers, setAnswers] = useState<string[]>([]),
    [started, setStarted] = useState<number | null>(null),
    [now, setNow] = useState(Date.now);
  const [activeWorkId, setActiveWorkId] = useState<string | null>(
    initialWorkId ?? null,
  );
  const [busy, setBusy] = useState(false),
    [pane, setPane] = useState<"passage" | "questions">("passage");
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
    let live = true;
    void loadLocalBank(userId).then(
      (materials) => {
        if (live) {
          setBank(materials);
          setLoaded(true);
        }
      },
      (e) => {
        if (live) {
          setError(String(e));
          setLoaded(true);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [userId]);
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
  const materials = bank.filter(
    (m) =>
      m.skill === skill &&
      (m.pool !== "holdout" || m.id === work?.payload.contentId),
  );
  const materialKey = (m: LocalMaterial) =>
    `${m.id}@${m.version}@${m.contentHash}`;
  const selected = work
    ? materials.find(
        (m) =>
          m.id === work.payload.contentId &&
          m.version === work.payload.contentVersion &&
          m.contentHash === work.payload.contentHash,
      )
    : (materials.find((m) => materialKey(m) === chosen || m.id === chosen) ??
      materials[0]);
  const material = selected
    ? {
        ...selected,
        questions:
          skill === "reading"
            ? orderedReadingQuestions(selected)
            : selected.questions,
      }
    : null;
  const passage = material?.skill === "reading" ? material.passage : "";
  const paragraphs = material?.skill === "reading" ? material.paragraphs : [];
  const transcript = material?.skill === "listening" ? material.transcript : "";
  const minutes =
    material?.scope === "full" ? 60 : material?.scope === "type-drill" ? 5 : 20;
  const elapsed = started === null ? 0 : Math.max(0, (now - started) / 1000);
  const liveAccount = () => {
    const state = getLearningState();
    if (!state.ready || state.userId !== userId)
      throw new Error("账号已经切换，请重新进入练习。");
    return state;
  };
  const start = () => {
    if (context.day < 1 || context.day > 365) {
      setError("当天不在365天计划内，可以查看已有作答，或从今日进入有效任务。");
      return;
    }
    setError("");
    setMessage("");
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
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const state = liveAccount();
      const seconds = Math.min(
        86400,
        Math.max(0, (Date.now() - started) / 1000),
      );
      const payload = attemptPayload(
        material,
        material.questions.map((_, i) => answers[i] ?? ""),
        {
          planId: plan.id,
          date: context.date,
          day: context.day,
          ...(context.taskId ? { taskId: context.taskId } : {}),
        },
        state.records,
        seconds,
        { timed: seconds <= minutes * 60, ...conditions.current },
      );
      const record = await saveRecord({
        id: `attempt-${crypto.randomUUID()}`,
        kind: "attempt",
        payload,
        baseRevision: null,
      });
      if (alive.current && getLearningState().userId === userId) {
        setActiveWorkId(record.id);
        setMessage("首答已保存。");
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
    setBusy(true);
    setError("");
    try {
      liveAccount();
      await saveMission({
        planId: plan.id,
        day: context.day,
        date: context.date,
        block: context.block,
        status:
          context.requiresFull &&
          (material?.scope !== "full" || material.questions.length !== 40)
            ? "partial"
            : "completed",
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
          context.requiresFull &&
            (material?.scope !== "full" || material.questions.length !== 40)
            ? "单节或单篇已保存为部分完成；完整测评还需完成整套内容。"
            : "本次任务已完成，按实际用时记录。",
        );
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "任务未保存。");
    } finally {
      if (alive.current) setBusy(false);
    }
  };
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
        {(context.day < 1 || context.day > 365) && (
          <p>当天不在365天计划内；已有作答继续保留。</p>
        )}
        {!loaded && <p>正在读取本机题库…</p>}
        {loaded && !materials.some((m) => !m.id.endsWith("-sample-01")) && (
          <p>
            题库导入后自动加入。还没导入题库，当前仅有离线样例。
            <a href="#/me">我的 → 题库</a>
          </p>
        )}
        {!work && (
          <label className="field">
            <span>练习材料</span>
            <select
              aria-label="练习材料"
              style={{
                display: "block",
                width: "100%",
                maxWidth: "100%",
                minWidth: 0,
              }}
              disabled={started !== null || busy}
              value={selected ? materialKey(selected) : ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              {materials.map((m) => (
                <option key={`${m.id}:${m.version}`} value={materialKey(m)}>
                  {m.title} · {m.version} · {m.source.materialSource}
                </option>
              ))}
            </select>
          </label>
        )}
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
              · {material.source.sourceRef} · {material.scope}
            </p>
            {skill === "reading" && (
              <p>
                篇幅 {countReadingWords(passage)} 词 · 单篇20分钟 /
                整套60分钟。短专项单独记录，不计入长文库存。
              </p>
            )}
            <p>本块计划 {context.plannedMinutes} 分钟；实际计时单独保存。</p>
            {!work && started === null && (
              <button
                className="btn btn-primary"
                onClick={start}
                disabled={
                  busy || !!activeWorkId || context.day < 1 || context.day > 365
                }
              >
                开始限时首答
              </button>
            )}
            {!work && started !== null && (
              <p role="timer">
                已用 {Math.floor(elapsed / 60)}:
                {String(Math.floor(elapsed % 60)).padStart(2, "0")}
                {elapsed > minutes * 60 ? " · 已超时，提交时记为非限时" : ""}
              </p>
            )}
            {(started !== null || work) && (
              <>
                {skill === "listening" &&
                  playback?.(material, !!work, (value) => {
                    conditions.current = value;
                  })}
                <div className="r4-mobile-switch">
                  <button
                    className="btn btn-ghost"
                    onClick={() => setPane("passage")}
                  >
                    查看原文
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setPane("questions")}
                  >
                    查看题目
                  </button>
                </div>
                <div className={`r4-columns r4-show-${pane}`}>
                  <article className="r4-passage" aria-label="阅读原文">
                    {skill === "reading" &&
                      paragraphs.map((p, i) => (
                        <p key={p.id} data-paragraph-id={p.id}>
                          <b>{p.label ?? String.fromCharCode(65 + i)}.</b>{" "}
                          {p.text}
                        </p>
                      ))}
                    {skill === "listening" && work && <p>{transcript}</p>}
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
                    disabled={busy}
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
                {work.payload.scope === "full" && work.payload.total === 40 && (
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
                {material.questions.map((q, i) => (
                  <details key={q.id}>
                    <summary>
                      第{q.number ?? i + 1}题 ·{" "}
                      {result.questionResults[i].correct ? "正确" : "错误"}
                    </summary>
                    <p>接受答案：{q.answer.accepted.join(" / ")}</p>
                    <p>
                      {q.answer.accepted.includes("NOT GIVEN")
                        ? "相关语境"
                        : "原文证据"}
                      ：<mark>{q.evidence.quote ?? "未定位，答案待核"}</mark>
                    </p>
                    {q.evidence.rationale && <p>{q.evidence.rationale}</p>}
                  </details>
                ))}
                <p>
                  目标词覆盖：
                  {work.payload.coverage &&
                  typeof work.payload.coverage === "object"
                    ? "已保存覆盖记录"
                    : "未知"}
                </p>
                {context.block && (
                  <button
                    className="btn btn-primary"
                    disabled={busy}
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
                  }}
                  disabled={busy}
                >
                  再做一次
                </button>
              </section>
            )}
          </>
        )}
        {loaded && !material && (
          <p>本机没有这版材料，请在“我的 → 题库”导入同一版本。原作答仍保留。</p>
        )}
        {work && !material && (
          <section aria-label="已保存首答">
            <h2>
              首答 {String(work.payload.score ?? "未知")}/
              {String(work.payload.total ?? "未知")}
            </h2>
            <p>
              材料来源：{String(work.payload.materialSource ?? "未分类")} ·
              目标词覆盖：未知
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
    </div>
  );
}
