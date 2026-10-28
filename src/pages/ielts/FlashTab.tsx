import { Flame, RotateCcw, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtlas } from "../../atlas/context";
import type { WordRef } from "../../atlas/types";
import { cue } from "../../lib/sound";
import { hashSeed, shuffle } from "../../lib/text";
import { distractors } from "../../store/session";
import { recallAt } from "../../store/srs";
import { store, useStore } from "../../store/store";
import { toast } from "../../ui/Toast";
import { useKeys } from "../Learn";

const ROUND_MS = 60_000;
/** Same bar as a recognition card: recognised within three seconds, or it does not count. */
const ITEM_MS = 3000;

interface Item {
  ref: WordRef;
  options: [string, string];
  answer: number;
}

/**
 * 一分钟闪测: as many learned words as possible in 60 seconds, three seconds each, two meanings to
 * pick from (often the look-alike's). A drill: it never changes the schedule, but the misses can be
 * pulled into today's reviews with one tap.
 */
export function FlashTab() {
  const atlas = useAtlas();
  const cards = useStore((s) => s.progress.cards);
  const mistakes = useStore((s) => s.progress.mistakes);
  const best = useStore((s) => s.progress.flashBest);
  const [round, setRound] = useState<{ key: number; items: Item[] } | null>(null);
  const [result, setResult] = useState<{ score: number; total: number; missed: string[]; best: boolean } | null>(null);
  const pool = useMemo(() => {
    const now = Date.now();
    const ids = Object.entries(cards)
      .sort((a, b) => recallAt(a[1], now) - recallAt(b[1], now))
      .map(([id]) => id);
    return [...new Set([...mistakes, ...ids])].filter((id) => atlas.byId.has(id));
  }, [cards, mistakes, atlas]);

  const start = () => {
    const seed = Date.now();
    // The weakest words first, shuffled within a wide window so rounds differ.
    const ids = [...shuffle(pool.slice(0, 40), seed), ...shuffle(pool.slice(40), seed + 1)].slice(0, 80);
    const items = ids.map((id, i): Item => {
      const ref = atlas.byId.get(id)!;
      const wrong = distractors(atlas, ref, "meaning", seed + i).find((x) => x !== id) ?? id;
      const answer = hashSeed(id + seed) % 2;
      const zh = (w: WordRef) => w.zh.replace(/^[a-z.]+\s*/, "").split(/[；;]/)[0];
      const options: [string, string] = answer === 0 ? [zh(ref), zh(atlas.byId.get(wrong)!)] : [zh(atlas.byId.get(wrong)!), zh(ref)];
      return { ref, options, answer };
    });
    setResult(null);
    setRound({ key: seed, items });
  };

  const finish = (score: number, total: number, missed: string[]) => {
    const record = score > best;
    if (record) store.progress((p) => ({ ...p, flashBest: score }));
    setResult({ score, total, missed, best: record });
    setRound(null);
  };

  const pullIntoToday = () => {
    if (!result) return;
    const now = Date.now();
    store.progress((p) => {
      const next = { ...p.cards };
      for (const id of result.missed) if (next[id] && next[id].due > now) next[id] = { ...next[id], due: now };
      return { ...p, cards: next, mistakes: [...result.missed, ...p.mistakes.filter((x) => !result.missed.includes(x))].slice(0, 300) };
    });
    toast(`${result.missed.length} 个词已放进今天的复习`, "ok");
  };

  if (round) return <FlashRound key={round.key} items={round.items} onDone={finish} />;

  return (
    <div className="lab-grid">
      <section className="panel">
        <h3 className="eyebrow">一分钟闪测</h3>
        <p className="para-big">
          <b>{best}</b> 个 / 分钟
        </p>
        <p className="muted">60 秒里能认出多少个学过的词？每个词 3 秒、两个意思选一个，最弱的词排在前面。认得慢的词，考场上也来不及。</p>
        <button className="btn btn-primary" onClick={start} disabled={pool.length < 4}>
          <Zap size={18} /> 开始 60 秒
        </button>
        <p className="muted small">{pool.length < 4 ? "先学几个词再来测。" : "闪测不改变复习排程；测完可以把错的词一键放进今天的复习。"}</p>
      </section>
      {result && (
        <section className="panel flash-result">
          <h3 className="eyebrow">{result.best ? "新纪录！" : "这一分钟"}</h3>
          <p className="para-big">
            <b>{result.score}</b> 个
            <small> · 答了 {result.total} 个</small>
          </p>
          {result.missed.length > 0 ? (
            <>
              <ul className="flash-missed">
                {result.missed.map((id) => {
                  const w = atlas.byId.get(id)!;
                  return (
                    <li key={id}>
                      <b lang="en">{w.word}</b> {w.zh}
                    </li>
                  );
                })}
              </ul>
              <div className="flash-actions">
                <button className="btn btn-primary" onClick={pullIntoToday}>
                  把错的 {result.missed.length} 个放进今天的复习
                </button>
                <button className="btn btn-ghost" onClick={start}>
                  <RotateCcw size={17} /> 再测一次
                </button>
              </div>
            </>
          ) : (
            <button className="btn btn-ghost" onClick={start}>
              <RotateCcw size={17} /> 再测一次
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function FlashRound({ items, onDone }: { items: Item[]; onDone: (score: number, total: number, missed: string[]) => void }) {
  const [i, setI] = useState(0);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [flash, setFlash] = useState<"ok" | "bad" | null>(null);
  const [left, setLeft] = useState(ROUND_MS);
  const missed = useRef<string[]>([]);
  const t0 = useRef(performance.now());
  const shownAt = useRef(performance.now());
  const done = useRef(false);
  const sfx = useStore((s) => s.settings.sfx);
  const box = useRef<HTMLDivElement>(null);
  // On a phone the round starts below the page header: bring the word and both answers into view.
  useEffect(() => box.current?.scrollIntoView({ block: "start", behavior: "smooth" }), []);

  const end = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onDone(score, i, [...new Set(missed.current)]);
  }, [onDone, score, i]);

  const answer = useCallback(
    (pick: number | null) => {
      if (done.current || flash) return;
      const item = items[i];
      const ok = pick === item.answer;
      if (ok) {
        setScore((s) => s + 1);
        setCombo((c) => c + 1);
      } else {
        missed.current.push(item.ref.id);
        setCombo(0);
      }
      if (sfx) void cue(ok ? "correct" : "wrong");
      setFlash(ok ? "ok" : "bad");
      window.setTimeout(() => {
        setFlash(null);
        shownAt.current = performance.now();
        setI((n) => n + 1);
      }, ok ? 180 : 650);
    },
    [items, i, flash, sfx],
  );

  // One clock drives both limits: the minute and the three seconds per word.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const now = performance.now();
      setLeft(Math.max(0, ROUND_MS - (now - t0.current)));
      if (now - t0.current >= ROUND_MS) return end();
      if (!flash && now - shownAt.current >= ITEM_MS) answer(null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [end, answer, flash]);
  useEffect(() => {
    if (i >= items.length) end();
  }, [i, items.length, end]);

  useKeys({ "1": () => answer(0), "2": () => answer(1), ArrowLeft: () => answer(0), ArrowRight: () => answer(1) });
  const item = items[Math.min(i, items.length - 1)];
  const itemLeft = flash ? 0 : Math.max(0, 1 - (performance.now() - shownAt.current) / ITEM_MS);

  return (
    <div ref={box} className={`flash-round ${flash ? `is-${flash}` : ""}`}>
      <header className="flash-top">
        <span className="flash-time">{Math.ceil(left / 1000)}s</span>
        <div className="learn-progress">
          <span style={{ width: `${(left / ROUND_MS) * 100}%` }} />
        </div>
        <span className="flash-score">
          <b>{score}</b>
          {combo >= 3 && (
            <i>
              <Flame size={14} /> {combo}
            </i>
          )}
        </span>
      </header>
      <div className="flash-card">
        <p className="flash-word" lang="en">
          {item.ref.word}
        </p>
        <div className="flash-item-bar">
          <span style={{ transform: `scaleX(${itemLeft})` }} />
        </div>
      </div>
      <div className="flash-options">
        {item.options.map((o, k) => (
          <button
            key={k}
            className={`flash-option ${flash && k === item.answer ? "is-answer" : ""}`}
            onClick={() => answer(k)}
          >
            <kbd>{k + 1}</kbd>
            {o}
          </button>
        ))}
      </div>
      <button className="link flash-quit" onClick={end}>
        提前结束
      </button>
    </div>
  );
}
