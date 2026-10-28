import { Check, Headphones, Play, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAtlas } from "../../atlas/context";
import { hasPattern, SPELL_LABEL, spelledRight, type SpellTag } from "../../ielts/spelling";
import { phraseAudio, useTags } from "../../ielts/tags";
import { play, stopAudio } from "../../lib/audio";
import { hashSeed, normalize, shuffle } from "../../lib/text";
import { recallAt } from "../../store/srs";
import { useStore, type Step } from "../../store/store";
import { startPractice } from "../Ielts";

export function SpellTab() {
  const atlas = useAtlas();
  const tags = useTags();
  const progress = useStore((s) => s.progress);
  const accent = useStore((s) => s.settings.accent);
  const stats = (Object.entries(progress.spell) as [SpellTag, number][]).filter(([t]) => t in SPELL_LABEL).sort((a, b) => b[1] - a[1]);
  const total = stats.reduce((n, [, c]) => n + c, 0);
  const lCards = Object.entries(progress.skills).filter(([k]) => k.startsWith("l:"));
  const now = Date.now();
  const weakest = lCards
    .map(([k, c]) => [k.slice(2), recallAt(c, now)] as const)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 12);

  /** Words that exercise a pattern: your misses first, then listening words you already know. */
  const drill = (tag: SpellTag | null) => {
    const missed = progress.spellLog.filter((m) => !tag || m.tags.includes(tag)).map((m) => m.id);
    const pool = Object.keys(progress.cards).filter((id) => {
      const w = atlas.byId.get(id);
      return !!w && (id in tags.listening || !Object.keys(tags.listening).length) && (!tag || hasPattern(tag, w.word));
    });
    const ids = [...new Set([...missed, ...shuffle(pool, now)])].filter((id) => atlas.byId.has(id)).slice(0, 12);
    const steps: Step[] = ids.map((id) => ({ id, kind: "dictation", track: "l" }));
    startPractice(steps, tag ? `拼写专项 · ${SPELL_LABEL[tag].name}` : "拼写专项 · 听写");
  };

  return (
    <div className="lab-grid">
      <section className="panel span-2">
        <div className="panel-head">
          <h3 className="eyebrow">你的拼写弱点</h3>
          <button className="btn btn-primary" onClick={() => drill(null)}>
            <Headphones size={18} /> 随机听写 12 词
          </button>
        </div>
        {stats.length ? (
          <ul className="spell-stats">
            {stats.map(([tag, n]) => (
              <li key={tag}>
                <div>
                  <b>{SPELL_LABEL[tag].name}</b>
                  <small>{SPELL_LABEL[tag].tip}</small>
                </div>
                <i>
                  <em style={{ width: `${(n / Math.max(1, stats[0][1])) * 100}%` }} />
                </i>
                <span>
                  {n} 次 · {Math.round((n / total) * 100)}%
                </span>
                {tag !== "mishear" && tag !== "swap" && (
                  <button className="btn btn-ghost" onClick={() => drill(tag)}>
                    专项练
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">还没有拼写错误记录。听写卡会在识别稳定后自动解锁（王陆语料库里的 1,600+ 个词），拼错时这里会告诉你错在哪一类。</p>
        )}
      </section>

      {progress.spellLog.length > 0 && (
        <section className="panel">
          <h3 className="eyebrow">最近拼错</h3>
          <ul className="miss-list">
            {progress.spellLog.slice(0, 14).map((m) => {
              const w = atlas.byId.get(m.id);
              if (!w) return null;
              return (
                <li key={m.at}>
                  <s lang="en">{m.typed}</s>
                  <b lang="en">{w.word}</b>
                  <small>{m.tags.map((t) => SPELL_LABEL[t as SpellTag]?.name).filter(Boolean).join(" · ")}</small>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {weakest.length > 0 && (
        <section className="panel">
          <h3 className="eyebrow">听写记忆最弱</h3>
          <ul className="miss-list">
            {weakest.map(([id, r]) => {
              const w = atlas.byId.get(id);
              return w ? (
                <li key={id}>
                  <button className="link" onClick={() => play(atlas.audio(w, accent), w.word, accent)} lang="en">
                    {w.word}
                  </button>
                  <small>{Math.round(r * 100)}%</small>
                </li>
              ) : null;
            })}
          </ul>
        </section>
      )}

      <PhraseDictation />
    </div>
  );
}

/** Corpus items that are not atlas headwords: phrases, names, plurals. Recorded in the sentence voice. */
function PhraseDictation() {
  const tags = useTags();
  const chapters = useMemo(() => [...new Set(tags.phrases.map(([, c]) => c))], [tags]);
  const [chapter, setChapter] = useState<string>("");
  const [round, setRound] = useState<{ items: string[]; i: number; answers: { typed: string; ok: boolean }[] } | null>(null);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  if (!tags.phrases.length) return null;

  const begin = () => {
    const pool = tags.phrases.filter(([, c]) => !chapter || c === chapter).map(([t]) => t);
    const items = shuffle(pool, hashSeed(String(Date.now()))).slice(0, 10);
    setRound({ items, i: 0, answers: [] });
    setValue("");
    window.setTimeout(() => {
      input.current?.focus();
      if (items[0]) say(items[0]);
    }, 80);
  };
  const say = (text: string, rate = 1) => void play(phraseAudio(text), text, "us", rate);
  const submit = () => {
    if (!round) return;
    const target = round.items[round.i];
    const ok = normalize(value) === normalize(target) || spelledRight(value, target);
    const answers = [...round.answers, { typed: value, ok }];
    setValue("");
    if (round.i + 1 >= round.items.length) setRound({ ...round, answers, i: round.items.length });
    else {
      setRound({ ...round, answers, i: round.i + 1 });
      window.setTimeout(() => say(round.items[round.i + 1]), 250);
    }
    input.current?.focus();
  };

  return (
    <section className="panel span-2 phrase-panel">
      <div className="panel-head">
        <h3 className="eyebrow">王陆语料库 · 短语与专名听写</h3>
        <small className="muted">{tags.phrases.length.toLocaleString()} 条 · 设备语音朗读</small>
      </div>
      {!round || round.i >= round.items.length ? (
        <>
          {round && (
            <ul className="phrase-results">
              {round.items.map((t, k) => (
                <li key={k} className={round.answers[k]?.ok ? "is-ok" : "is-bad"}>
                  {round.answers[k]?.ok ? <Check size={16} /> : <X size={16} />}
                  <b lang="en">{t}</b>
                  {!round.answers[k]?.ok && <s lang="en">{round.answers[k]?.typed || "（空）"}</s>}
                </li>
              ))}
            </ul>
          )}
          <div className="phrase-start">
            <select value={chapter} onChange={(e) => setChapter(e.target.value)} aria-label="章节">
              <option value="">全部章节</option>
              {chapters.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={begin}>
              <Play size={16} /> {round ? "再来 10 条" : "开始 10 条"}
            </button>
          </div>
          <p className="muted">听力 Section 1–2 常考的名称、地址、搭配。不进入记忆排程，纯练手和耳朵。</p>
        </>
      ) : (
        <form
          className="phrase-run"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) submit();
          }}
        >
          <p className="eyebrow">
            第 {round.i + 1} / {round.items.length} 条
          </p>
          <div className="phrase-controls">
            <button type="button" className="btn btn-ghost" onClick={() => say(round.items[round.i])}>
              <Play size={16} /> 播放
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => say(round.items[round.i], 0.7)}>
              慢速
            </button>
          </div>
          <input ref={input} className="dictation-field" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="写下你听到的" lang="en" />
          <div className="phrase-controls">
            <button type="button" className="link" onClick={() => (stopAudio(), setRound({ ...round, i: round.items.length }))}>
              结束
            </button>
            <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
              确认 <kbd>Enter</kbd>
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
