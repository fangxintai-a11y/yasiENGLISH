import {
  ArrowRight,
  Check,
  Headphones,
  Keyboard,
  Lightbulb,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prefetch, useAtlas } from "../atlas/context";
import type { Entry } from "../atlas/types";
import {
  diagnose,
  canAutoSubmitSpelling,
  diffMarks,
  spelledRight,
  SPELL_LABEL,
} from "../ielts/spelling";
import {
  recordSpellingMiss,
  spellingPool,
  type SpellingSource,
} from "../ielts/spellingPractice";
import { play, prepareAudio, stopAudio } from "../lib/audio";
import { cue, primeCues } from "../lib/sound";
import { shuffle } from "../lib/text";
import { useCloudSync } from "../store/cloudSync";
import { store, useStore } from "../store/store";
import { TypingField } from "../ui/TypingField";

type Mode = "meaning" | "audio";
type Result = {
  id: string;
  word: string;
  typed: string;
  correct: boolean;
  hinted: boolean;
};
type Round = { entries: Entry[]; answers: Result[]; mode: Mode; continuous: boolean; id: number };
const SOURCES: [SpellingSource, string][] = [
  ["learned", "已学单词"],
  ["mistakes", "错词本"],
  ["bookmarks", "收藏"],
  ["path", "学习路线"],
];

export function Spelling() {
  const atlas = useAtlas();
  const cloud = useCloudSync();
  return <SpellingPage key={`${atlas.id}:${cloud.user?.id ?? "local"}`} />;
}

function SpellingPage() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const startLevel = useStore((s) => s.settings.startLevel);
  const [source, setSource] = useState<SpellingSource>(
    Object.keys(progress.cards).length ? "learned" : "path",
  );
  const [mode, setMode] = useState<Mode>("meaning");
  const [count, setCount] = useState("20");
  const [continuous, setContinuous] = useState(true);
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      stopAudio();
    },
    [],
  );
  const pool = useMemo(
    () => spellingPool(atlas, progress, source, startLevel),
    [atlas, progress, source, startLevel],
  );
  const quantity = Number(count);
  const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= 100;

  const start = async (explicitIds?: string[]) => {
    if (loading || (!explicitIds && (!valid || !pool.length))) return;
    if (store.get().settings.sfx) primeCues();
    const sequence = ++request.current;
    setLoading(true);
    setError("");
    try {
      const ids = explicitIds ?? shuffle(pool).slice(0, quantity);
      const loaded = await prefetch(atlas, ids);
      if (sequence !== request.current) return;
      const entries = loaded.filter((entry): entry is Entry => !!entry);
      if (entries.length !== ids.length)
        throw new Error("部分词条未能加载，请检查网络后重试。");
      if (!entries.length) throw new Error("这里还没有可练的词，请换个来源。");
      setRound({ entries, answers: [], mode, continuous, id: sequence });
      window.scrollTo({ top: 0 });
    } catch (reason) {
      if (sequence === request.current)
        setError(
          reason instanceof Error ? reason.message : "加载未完成，请重试。",
        );
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  };

  if (round) {
    const done = round.answers.length === round.entries.length;
    const incorrect = round.answers.filter((answer) => !answer.correct);
    return (
      <div className="page spelling-page">
        <header className="page-head spelling-head">
          <p className="eyebrow">单词拼写</p>
          <h1>{done ? "这一轮，拼完了。" : "想一想，亲手拼出来。"}</h1>
          <button
            className="link"
            onClick={() => {
              stopAudio();
              setRound(null);
            }}
          >
            返回设置
          </button>
        </header>
        {done ? (
          <section className="panel spelling-summary">
            <h2>
              首答正确 {round.answers.filter((answer) => answer.correct).length}{" "}
              / {round.entries.length}
            </h2>
            <p className="muted">
              其中 {round.answers.filter((answer) => answer.hinted).length}{" "}
              词使用了提示。错词已保存到错词本，可继续复习。
            </p>
            <ul className="spelling-results">
              {round.answers.map((answer) => (
                <li key={answer.id}>
                  {answer.correct ? <Check size={18} /> : <X size={18} />}
                  <b lang="en">{answer.word}</b>
                  {!answer.correct && (
                    <s lang="en">{answer.typed || "未作答"}</s>
                  )}
                  {answer.hinted && <small>用过提示</small>}
                </li>
              ))}
            </ul>
            {error && <p role="alert">{error}</p>}
            <div className="spelling-actions">
              {incorrect.length > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={loading}
                  onClick={() =>
                    void start(incorrect.map((answer) => answer.id))
                  }
                >
                  <RotateCcw size={18} /> 重练本轮错词
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => setRound(null)}>
                选下一轮
              </button>
            </div>
          </section>
        ) : (
          <SpellingQuestion
            key={round.id}
            entry={round.entries[round.answers.length]}
            upcoming={round.entries.slice(round.answers.length + 1, round.answers.length + 3)}
            mode={round.mode}
            continuous={round.continuous}
            index={round.answers.length}
            total={round.entries.length}
            onMiss={(answer) => {
              if (store.get().progress.datasetId === atlas.id)
                store.progress((p) =>
                  recordSpellingMiss(p, answer.id, answer.typed, answer.word),
                );
            }}
            onNext={(answer) =>
              setRound((current) =>
                current &&
                current.id === round.id &&
                current.answers.length === round.answers.length
                  ? { ...current, answers: [...current.answers, answer] }
                  : current,
              )
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="page spelling-page">
      <header className="page-head">
        <p className="eyebrow">单词拼写 · Spelling</p>
        <h1 className="display">想得起，也拼得出。</h1>
        <p className="lede">
          只给中文或发音，完全凭记忆默写。拼对自动继续，拼错后再看答案。
        </p>
      </header>
      <section className="panel spelling-setup">
        <h2 className="eyebrow">练哪些词</h2>
        <div className="segmented segmented-wide">
          {SOURCES.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={key === source}
              className={key === source ? "is-on" : ""}
              onClick={() => setSource(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="muted">
          {pool.length
            ? `当前可练 ${pool.length} 个词。${source === "path" ? "按当前起点，从路线前200词中抽取。" : ""}`
            : "这里还没有词，先去学习，或换一个来源。"}
        </p>
        <h2 className="eyebrow">提示方式</h2>
        <div className="mode-cards">
          <button
            className={`mode-card ${mode === "meaning" ? "is-on" : ""}`}
            aria-pressed={mode === "meaning"}
            onClick={() => setMode("meaning")}
          >
            <Keyboard size={22} />
            <b>看中文拼写</b>
            <small>只看中文，不显示英文和字母数</small>
          </button>
          <button
            className={`mode-card ${mode === "audio" ? "is-on" : ""}`}
            aria-pressed={mode === "audio"}
            onClick={() => setMode("audio")}
          >
            <Headphones size={22} />
            <b>听音拼写</b>
            <small>先听发音，再写单词</small>
          </button>
        </div>
        <label className="spelling-flow-option">
          <input type="checkbox" checked={continuous} onChange={(event) => setContinuous(event.target.checked)} />
          <span>连续默写<small>拼对自动下一词；关闭后每词手动确认。</small></span>
        </label>
        <label className="spelling-count">
          本轮数量
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={count}
            onChange={(event) => setCount(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <div className="spelling-actions">
          {[10, 20, 30, 50].map((value) => (
            <button
              key={value}
              className={`btn ${Number(count) === value ? "btn-primary" : "btn-ghost"}`}
              aria-pressed={Number(count) === value}
              onClick={() => setCount(String(value))}
            >
              {value} 词
            </button>
          ))}
        </div>
        {!valid && <p role="alert">请输入1–100之间的整数。</p>}
        {error && <p role="alert">{error}</p>}
        <button
          className="btn btn-primary btn-xl"
          disabled={loading || !valid || !pool.length}
          onClick={() => void start()}
        >
          {loading
            ? "正在加载词条…"
            : `开始拼写 ${valid ? Math.min(quantity, pool.length) : 0} 词`}
          <ArrowRight size={18} />
        </button>
        <p className="muted small">
          拼错会进入错词本；本页不改变单词记忆排程，也不会覆盖进行中的复习。
        </p>
      </section>
    </div>
  );
}

function SpellingQuestion({
  entry,
  upcoming,
  mode,
  continuous,
  index,
  total,
  onMiss,
  onNext,
}: {
  entry: Entry;
  upcoming: Entry[];
  mode: Mode;
  continuous: boolean;
  index: number;
  total: number;
  onMiss: (answer: Result) => void;
  onNext: (answer: Result) => void;
}) {
  const atlas = useAtlas();
  const accent = useStore((s) => s.settings.accent);
  const sounds = useStore((s) => s.settings.sfx);
  const [pending, setPending] = useState<Result | null>(null);
  const [showMeaning, setShowMeaning] = useState(mode === "meaning");
  const submitted = useRef(false);
  useLayoutEffect(() => {
    submitted.current = false;
    setPending(null);
    setShowMeaning(mode === "meaning");
  }, [entry.id, mode]);
  const say = () => void play(atlas.audio(entry, accent), entry.w, accent);
  useEffect(() => {
    prepareAudio(upcoming.map((next) => atlas.audio(next, accent)));
  }, [atlas, upcoming, accent]);
  useEffect(() => {
    if (mode === "audio")
      void play(atlas.audio(entry, accent), entry.w, accent);
    return () => stopAudio();
  }, [atlas, entry, mode, accent]);
  const submit = (typed: string, revealed = false) => {
    if (submitted.current) return;
    submitted.current = true;
    const answer = {
      id: entry.id,
      word: entry.w,
      typed,
      correct: !revealed && spelledRight(typed, entry.w),
      hinted: revealed || (mode === "audio" && showMeaning),
    };
    if (sounds) void cue(answer.correct ? "correct" : "wrong");
    if (answer.correct && continuous) {
      onNext(answer);
      return;
    }
    setPending(answer);
    if (!answer.correct) onMiss(answer);
  };
  const next = () => {
    if (!pending) return;
    stopAudio();
    onNext(pending);
  };

  return (
    <section className="panel learn spelling-round" aria-label="拼写练习">
      <p className="eyebrow">
        第 {index + 1} / {total} 词 ·{" "}
        {mode === "meaning" ? "看中文拼写" : "听音拼写"}
      </p>
      <div className="spelling-prompt">
        {showMeaning && (
          <p className="spell-zh">
            <span className="pos">{entry.senses[0]?.pos}</span>{" "}
            {entry.senses[0]?.zh || atlas.byId.get(entry.id)?.zh}
          </p>
        )}
        {!pending && (
          <button className="btn btn-ghost" onMouseDown={(event) => event.preventDefault()} onClick={say}>
            <Headphones size={18} /> {mode === "audio" ? "再听一遍" : "听发音"}
          </button>
        )}
        {!showMeaning && !pending && (
          <button className="link" onClick={() => setShowMeaning(true)}>
            提示中文
          </button>
        )}
      </div>
      <TypingField
        itemId={entry.id}
        target={entry.w}
        accepts={(typed) => canAutoSubmitSpelling(typed, entry.w)}
        autoComplete={continuous}
        onReplay={say}
        onContinue={next}
        sounds={sounds}
        pending={
          pending
            ? { correct: pending.correct, value: pending.typed }
            : undefined
        }
        onSubmit={submit}
      />
      {!pending && (
        <button className="link spelling-skip" onClick={() => submit("", true)}>
          暂时想不起，查看答案
        </button>
      )}
      {pending && (
        <div className="spelling-feedback" role="status">
          <h2>{pending.correct ? "拼写正确" : "再看一遍这个词"}</h2>
          <p className="spelling-answer" lang="en">
            {diffMarks(pending.correct ? entry.w : pending.typed, entry.w).map(
              (mark, i) => (
                <span key={i} className={mark.bad ? "is-bad" : ""}>
                  {mark.ch}
                </span>
              ),
            )}
          </p>
          {!pending.correct && (
            <p>
              你的输入：<s lang="en">{pending.typed || "未作答"}</s>
            </p>
          )}
          {!pending.correct && (
            <p className="muted">
              {diagnose(pending.typed, entry.w)
                .map((tag) => SPELL_LABEL[tag].name)
                .join(" · ") || "先记住正确拼写，稍后再试。"}
            </p>
          )}
          {pending.hinted && (
            <p className="muted small">
              <Lightbulb size={14} /> 本词使用过提示。
            </p>
          )}
          {entry.ex[0] && <p className="spelling-context" lang="en">{entry.ex[0].en}</p>}
          <div className="spelling-actions">
            <button
              className="btn btn-primary"
              onClick={next}
            >
              {index + 1 === total ? "查看本轮结果" : "下一个单词"}
              <ArrowRight size={18} />
            </button>
            <button className="btn btn-ghost" onClick={say}>
              <Headphones size={18} /> 听发音
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
