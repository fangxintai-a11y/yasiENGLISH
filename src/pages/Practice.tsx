import { Headphones, Keyboard, RotateCcw, Type } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prefetch, useAtlas } from "../atlas/context";
import type { Entry } from "../atlas/types";
import { play, prepareAudio, stopAudio } from "../lib/audio";
import { cue, primeCues } from "../lib/sound";
import { hashSeed, shuffle } from "../lib/text";
import { clean, same, typingMetrics } from "../lib/typing";
import { store, useStore } from "../store/store";
import { AmbiencePicker } from "../ui/Ambience";
import { TypingField, type TypingChange } from "../ui/TypingField";
import { canAutoSubmitSpelling, spelledRight } from "../ielts/spelling";
import { hasAssessment, startedWeakWords } from "../ielts/vocabulary";

type Mode = "word" | "sentence" | "dictation";
type Source = "recent" | "mistakes" | "saved" | "path";

const MODES: [Mode, string, string, typeof Type][] = [
  ["word", "单词默写", "看中文，凭记忆写单词", Type],
  ["sentence", "句子默写", "看中文，凭记忆写整句", Keyboard],
  ["dictation", "句子听写", "只听声音，写下整句", Headphones],
];
const SOURCES: [Source, string][] = [
  ["recent", "最近学过"],
  ["mistakes", "错词本"],
  ["saved", "收藏"],
  ["path", "学习路线"],
];

export function Practice() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const startLevel = useStore((s) => s.settings.startLevel);
  const [mode, setMode] = useState<Mode>("word");
  const [source, setSource] = useState<Source>(() =>
    Object.keys(progress.cards).length ? "recent" : "path",
  );
  const [round, setRound] = useState<{ entries: Entry[]; key: number } | null>(
    null,
  );

  const pool = useMemo(() => {
    const learned = Object.entries(progress.cards)
      .sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0))
      .map(([id]) => id);
    const ids =
      source === "recent"
        ? learned
        : source === "mistakes"
          ? progress.mistakes
          : source === "saved"
            ? progress.bookmarks
            : atlas.words
                .filter((w) => w.cefr >= startLevel)
                .slice(0, 400)
                .map((w) => w.id);
    const targets = hasAssessment(progress) ? new Set(startedWeakWords(progress)) : null;
    return ids.filter((id) => atlas.byId.has(id) && (!targets || targets.has(id)));
  }, [
    atlas,
    progress.cards,
    progress.mistakes,
    progress.bookmarks,
    progress.assessment,
    source,
    startLevel,
  ]);

  const start = async () => {
    if (store.get().settings.sfx) primeCues();
    const ids = shuffle(pool.slice(0, 60), hashSeed(String(Date.now()))).slice(
      0,
      10,
    );
    const entries = (await prefetch(atlas, ids)).filter(
      (e): e is Entry => !!e && (mode === "word" || e.ex.length > 0),
    );
    if (entries.length) setRound({ entries, key: Date.now() });
  };

  if (round)
    return (
      <TypingRound
        key={round.key}
        mode={mode}
        entries={round.entries}
        onExit={() => setRound(null)}
        onAgain={start}
      />
    );

  const best = progress.typing
    .filter((t) => t.mode === mode)
    .reduce((m, t) => Math.max(m, t.wpm), 0);
  return (
    <div className="page practice">
      <header className="page-head">
        <p className="eyebrow">练习 · Typing Studio</p>
        <h1 className="display">让手，也记住它们。</h1>
        <p className="lede">
          完全默写，不显示英文答案或字母数。练习不会改动记忆进度。
        </p>
      </header>
      <div className="practice-grid">
        <section className="panel">
          <h3 className="eyebrow">模式</h3>
          <div className="mode-cards">
            {MODES.map(([k, name, desc, Icon]) => (
              <button
                key={k}
                className={`mode-card ${mode === k ? "is-on" : ""}`}
                onClick={() => setMode(k)}
                aria-pressed={mode === k}
              >
                <Icon size={22} strokeWidth={1.7} />
                <b>{name}</b>
                <small>{desc}</small>
              </button>
            ))}
          </div>
          <h3 className="eyebrow">词来自</h3>
          <div className="segmented segmented-wide">
            {SOURCES.map(([k, label]) => (
              <button
                key={k}
                className={source === k ? "is-on" : ""}
                onClick={() => setSource(k)}
                aria-pressed={source === k}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="muted">
            {pool.length
              ? source === "path"
                ? "从学习路线的前 400 个词里随机抽 10 个。"
                : `可练 ${pool.length} 个词，每轮随机 10 个。`
              : "这里还没有词，先去学几个，或换个来源。"}
          </p>
          <button
            className="btn btn-primary btn-xl"
            onClick={start}
            disabled={!pool.length}
          >
            开始一轮
          </button>
        </section>
        <section className="panel practice-side">
          <img
            src={`${import.meta.env.BASE_URL}brand/${mode === "dictation" ? "listen" : "typing"}.webp`}
            alt=""
          />
          <dl className="mini-stats">
            <div>
              <dt>最佳速度</dt>
              <dd>
                {best}
                <small>WPM</small>
              </dd>
            </div>
            <div>
              <dt>完成轮次</dt>
              <dd>{progress.typing.length}</dd>
            </div>
          </dl>
          <p className="muted">
            WPM 按每 5 个字符计 1 词，只统计答对项；字符准确率在整轮结束后显示。
          </p>
        </section>
      </div>
    </div>
  );
}

function TypingRound({
  mode,
  entries,
  onExit,
  onAgain,
}: {
  mode: Mode;
  entries: Entry[];
  onExit: () => void;
  onAgain: () => void;
}) {
  const atlas = useAtlas();
  const settings = useStore((s) => s.settings);
  const [i, setI] = useState(0);
  const [pending, setPending] = useState<{ correct: boolean; value: string }>();
  const totals = useRef({ typed: 0, correct: 0, accepted: 0, ms: 0, right: 0 });
  const [done, setDone] = useState(false);
  const started = useRef<number | null>(null);
  const finished = useRef(-1);
  const moved = useRef(-1);
  const e = entries[i];
  const target = mode === "word" ? e.w : e.ex[0].en;
  const accepts = (value: string) =>
    mode === "word"
      ? spelledRight(value, target)
      : same(value.trim(), target.trim());
  const say = () =>
    void play(
      atlas.audio(e, mode === "word" ? settings.accent : "ex"),
      target,
      mode === "word" ? settings.accent : "us",
    );

  useLayoutEffect(() => {
    setPending(undefined);
    started.current = null;
  }, [i]);
  useEffect(() => {
    prepareAudio(
      entries
        .slice(i + 1, i + 3)
        .map((next) =>
          atlas.audio(next, mode === "word" ? settings.accent : "ex"),
        ),
    );
    if (mode === "dictation" || (mode === "word" && settings.autoplay)) say();
    return () => stopAudio();
  }, [i, atlas, mode, settings.accent]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (next: string, delta: TypingChange) => {
    if (started.current === null && next) started.current = performance.now();
    const t = totals.current;
    t.typed += delta.added;
    t.correct += delta.correct;
  };
  const advance = () => {
    if (moved.current === i) return;
    moved.current = i;
    stopAudio();
    if (i + 1 < entries.length) {
      setI(i + 1);
      return;
    }
    setDone(true);
    const t = totals.current;
    const m = typingMetrics(t.correct, t.typed, t.accepted, t.ms);
    store.progress((p) => ({
      ...p,
      typing: [
        ...p.typing,
        {
          at: Date.now(),
          mode,
          items: entries.length,
          wpm: m.wpm,
          accuracy: m.accuracy,
        },
      ].slice(-500),
    }));
  };
  const submit = (value: string) => {
    if (finished.current === i) return;
    finished.current = i;
    const correct = accepts(value);
    const t = totals.current;
    t.ms += started.current === null ? 0 : performance.now() - started.current;
    if (correct) {
      t.accepted += clean(value.trim()).length;
      t.right++;
    }
    if (settings.sfx) void cue(correct ? "correct" : "wrong");
    if (correct) advance();
    else setPending({ correct: false, value });
  };
  const m = typingMetrics(
    totals.current.correct,
    totals.current.typed,
    totals.current.accepted,
    totals.current.ms,
  );

  if (done)
    return (
      <div className="page practice">
        <section className="panel typing-done">
          <p className="eyebrow">本轮完成</p>
          <h1 className="display">
            {m.wpm} <small>WPM</small>
          </h1>
          <p className="lede">
            首答正确 {totals.current.right} / {entries.length} · 字符准确率{" "}
            {m.accuracy}%
          </p>
          <div className="summary-actions">
            <button className="btn btn-ghost" onClick={onExit}>
              返回
            </button>
            <button
              className="btn btn-primary btn-xl"
              onClick={onAgain}
              autoFocus
            >
              <RotateCcw size={18} /> 再来一轮
            </button>
          </div>
        </section>
      </div>
    );

  return (
    <div className="page practice typing">
      <header className="typing-top">
        <button className="btn btn-ghost" onClick={onExit}>
          结束
        </button>
        <AmbiencePicker />
        <div className="learn-progress">
          <span style={{ width: `${(i / entries.length) * 100}%` }} />
        </div>
        <span className="typing-meter">
          第 {i + 1} / {entries.length} 项
        </span>
      </header>
      <section className="typing-stage" aria-label="默写练习">
        {mode === "word" && (
          <div className="typing-cue">
            <p>
              <span className="pos">{e.senses[0].pos}</span> {e.senses[0].zh}
            </p>
          </div>
        )}
        {mode === "sentence" && <p className="typing-zh">{e.ex[0].zh}</p>}
        <button
          className="btn btn-ghost"
          onMouseDown={(event) => event.preventDefault()}
          onClick={say}
        >
          <Headphones size={18} />{" "}
          {mode === "dictation" ? "再听一遍" : "听发音"}
        </button>
        <TypingField
          itemId={e.id}
          target={target}
          accepts={mode === "word" ? (value) => canAutoSubmitSpelling(value, target) : accepts}
          onSubmit={submit}
          onChange={onChange}
          onReplay={say}
          onContinue={advance}
          autoComplete
          sounds={settings.sfx}
          pending={pending}
          label={mode === "word" ? "输入英文单词" : "输入英文句子"}
          placeholder={
            mode === "word" ? "凭记忆输入英文" : "凭记忆输入整句英文"
          }
        />
        {!pending && (
          <button className="link" onClick={() => submit("")}>
            暂时想不起，查看答案
          </button>
        )}
        {pending && (
          <div className="typing-recall-feedback" role="status">
            <p>本题未答对，看看正确拼写：</p>
            <b lang="en">{target}</b>
            {pending.value && (
              <p>
                你的输入：<s lang="en">{pending.value}</s>
              </p>
            )}
            <p className="muted">
              {mode === "word" ? e.ex[0]?.zh : e.ex[0].zh}
            </p>
            <button className="btn btn-primary" onClick={advance}>
              {i + 1 === entries.length ? "查看本轮结果" : "下一项"}{" "}
              <kbd>Enter</kbd>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
