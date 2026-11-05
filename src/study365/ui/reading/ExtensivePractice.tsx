import { useEffect, useRef, useState } from "react";
import { assertNoCredentials } from "../../../ielts/scoring";
import type { Revision } from "../../protocol";
import { validateNewListeningReadingAttempt } from "../../protocol";
import type { DayPlan } from "../../planEngine";
import { importLocalBank } from "../../localBank";
import { hashLocalMaterial, LocalMaterialSchema } from "../../localBankSchema";
import { getLearningState, saveRecord } from "../../repository";
import { currentAttempts } from "../../readingModel";
import {
  missionTaskId,
  saveMission,
  selectMission,
} from "../../missionRecords";
import { ReadingVocabulary } from "./ReadingVocabulary";
import { extensivePracticeContext } from "../../extensivePracticeModel";
export function ExtensivePractice({
  plan,
  dayPlan,
  userId,
}: {
  plan: Revision;
  dayPlan: DayPlan;
  userId: string | null;
}) {
  const [tuesdayActivity, setTuesdayActivity] = useState<
    "reading" | "listening"
  >("reading");
  const tuesday = new Date(`${dayPlan.date}T00:00:00Z`).getUTCDay() === 2;
  const practice = extensivePracticeContext(dayPlan, tuesdayActivity);
  const skill = practice?.skill,
    block = practice?.block;
  const [url, setUrl] = useState(""),
    [text, setText] = useState(""),
    [dictation, setDictation] = useState(""),
    [started, setStarted] = useState<number | null>(null),
    [saved, setSaved] = useState(false),
    [compare, setCompare] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const inFlight = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!skill || dayPlan.state !== "active" || !block || block.minutes < 10)
    return null;
  const listening = skill === "listening";
  const finish = async () => {
    if (inFlight.current || started === null) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    let recorded = false;
    try {
      const check = () => {
        const state = getLearningState();
        if (!alive.current || !state.ready || state.userId !== userId)
          throw new Error("账号或任务已经切换，请重新进入今日任务。");
        return state;
      };
      check();
      const parsed = new URL(url.trim());
      if (
        !["https:", "http:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.href.length > 300
      )
        throw new Error("请填写不含登录信息的文章或节目链接。");
      if (text.trim().length < 20)
        throw new Error("请粘贴要保留的文稿，只在本机保存。");
      const id = `extensive-${crypto.randomUUID()}`;
      const original = text.trim();
      const raw = {
        id,
        version: "1",
        title: listening ? "BBC泛听与听写" : "网上文章泛读",
        skill,
        deliveryMode: "local-import",
        scope: "short",
        contentHash: "0".repeat(64),
        questions: [],
        estimatedMinutes: 10,
        source: {
          materialSource: "unofficial",
          sourceRef: parsed.href,
          rights: "User-provided text for private study",
          answerVerified: false,
        },
        ...(listening
          ? { transcript: original }
          : { passage: original, paragraphs: [{ id: "p1", text: original }] }),
      };
      const material = LocalMaterialSchema.parse(raw);
      material.contentHash = await hashLocalMaterial(material);
      const seconds = Math.min(
          86400,
          Math.max(0, (Date.now() - started) / 1000),
        ),
        taskId = missionTaskId(dayPlan.day, block.id);
      const payload = {
        planId: plan.id,
        date: dayPlan.date,
        day: dayPlan.day,
        taskId,
        contentId: id,
        contentVersion: material.version,
        contentHash: material.contentHash,
        skill,
        materialSource: "unofficial",
        sourceRef: parsed.href,
        scope: "short",
        answers: listening ? [dictation] : [],
        elapsedSeconds: seconds,
        actualMinutes: seconds / 60,
        firstAttempt: true,
        conditions: {
          timed: false,
          unseen: false,
          firstAttempt: true,
          transcriptViewed: listening,
          replayed: false,
          replays: 0,
        },
      };
      validateNewListeningReadingAttempt(payload);
      assertNoCredentials(payload);
      await importLocalBank(userId, {
        importVersion: 1,
        materials: [material],
      });
      const before = check(),
        previous = selectMission(before.records, plan.id, dayPlan.date, taskId);
      const attemptMinutes = currentAttempts(before.records, plan.id)
        .filter(
          (r) => r.payload.taskId === taskId && r.payload.date === dayPlan.date,
        )
        .reduce((sum, r) => sum + Number(r.payload.actualMinutes ?? 0), 0);
      await saveRecord({
        id: `attempt-${crypto.randomUUID()}`,
        kind: "attempt",
        payload,
        baseRevision: null,
      });
      recorded = true;
      check();
      setSaved(true);
      setCompare(true);
      await saveMission({
        planId: plan.id,
        day: dayPlan.day,
        date: dayPlan.date,
        block,
        status:
          previous?.payload.status === "completed" ? "completed" : "partial",
        actualMinutes:
          Math.max(
            Number(previous?.payload.actualMinutes ?? 0),
            attemptMinutes,
          ) +
          seconds / 60,
        timeSource: "timer",
        expectedUserId: userId,
      });
    } catch (e) {
      if (alive.current)
        setError(
          (recorded ? "练习已保存；任务计时未更新，请在今日任务卡登记。" : "") +
            (e instanceof Error ? e.message : "泛读泛听未保存，请重试。"),
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="panel r4-page" aria-label="本周泛读泛听">
      <h3>
        {listening
          ? `${tuesday ? "周二" : "周四"}：BBC泛听与听写`
          : "周二：网上文章泛读"}
      </h3>
      <p className="muted">
        每周可在周二和周四做BBC听写。周二也可选择文章泛读；开始计时后，本次练习类型固定。
      </p>
      {tuesday && (
        <label className="field">
          <span>本次练习类型</span>
          <select
            aria-label="泛读泛听练习类型"
            value={tuesdayActivity}
            disabled={started !== null || saved || busy}
            onChange={(event) =>
              setTuesdayActivity(event.target.value as "reading" | "listening")
            }
          >
            <option value="reading">网上文章泛读</option>
            <option value="listening">BBC 6 Minute English听写</option>
          </select>
        </label>
      )}
      <p>
        占用{block.id === "review" ? "复盘" : listening ? "听力" : "阅读"}块已有{" "}
        {block.minutes}{" "}
        分钟中的10–15分钟，余下时间完成本块其余安排。当天总预算仍为120分钟；这里只保存真实用时，不判分。
      </p>
      {listening && (
        <a
          href="https://www.bbc.co.uk/learningenglish/english/features/6-minute-english"
          target="_blank"
          rel="noreferrer"
        >
          打开BBC 6 Minute English
        </a>
      )}
      <label className="field">
        <span>{listening ? "节目" : "文章"}链接</span>
        <input
          aria-label="泛读泛听来源链接"
          value={url}
          maxLength={300}
          disabled={saved || busy}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="field">
        <span>粘贴文稿（只保存在本机题库）</span>
        <textarea
          aria-label="泛读泛听文稿"
          maxLength={listening ? 200000 : 50000}
          value={text}
          disabled={saved || busy}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {listening && (
        <label className="field">
          <span>我的听写</span>
          <textarea
            aria-label="泛听听写"
            maxLength={20000}
            value={dictation}
            disabled={saved || busy}
            onChange={(e) => setDictation(e.target.value)}
          />
        </label>
      )}
      {started === null ? (
        <button
          className="btn btn-ghost"
          onClick={() => setStarted(Date.now())}
        >
          开始泛读泛听计时
        </button>
      ) : (
        !saved && (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void finish()}
          >
            保存本次泛读泛听
          </button>
        )
      )}
      {saved && (
        <p role="status">已保存来源和实际分钟；文稿留在本机，没有换算分数。</p>
      )}
      {listening && started !== null && (
        <>
          <button
            className="btn btn-ghost"
            onClick={() => setCompare((value) => !value)}
          >
            {compare ? "收起" : "显示"}文稿对照
          </button>
          {compare && (
            <section aria-label="逐句听写对照">
              {text
                .split(/\n|(?<=[.!?])\s+/)
                .filter(Boolean)
                .map((line, i) => (
                  <div key={i}>
                    <p>文稿：{line}</p>
                    <p>
                      听写：{dictation.split(/\n|(?<=[.!?])\s+/)[i] ?? "未写"}
                    </p>
                  </div>
                ))}
            </section>
          )}
        </>
      )}
      {saved && <ReadingVocabulary text={text} />}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
