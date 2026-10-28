import { ArrowRight, BookOpenText, Ear, Flame, Keyboard, Mic, Pause, Play, RotateCcw, Snail, Sparkles, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prefetch, useAtlas } from "../atlas/context";
import type { Entry } from "../atlas/types";
import { firstLetters, heardScore, heardWords, pickSentences, sentenceKey, sentenceWords, shadowFocus, shadowNext, wordTimes, type SentenceRef } from "../ielts/shadow";
import { play, stopAudio } from "../lib/audio";
import { canRecord, openMic, type Mic as MicT, type Take } from "../lib/recorder";
import { go } from "../lib/router";
import { canRecognize, hear, isAppleMobile, type Hearing } from "../lib/speech";
import { cue, duck } from "../lib/sound";
import { headwordPattern } from "../lib/text";
import { countTakes, getTakes, saveTake, type VoiceTake } from "../lib/voices";
import { dayKey, recordShadow, store, useStore } from "../store/store";
import { toast } from "../ui/Toast";
import { useKeys } from "./Learn";

const ROUND = 8;

const SLOW = 0.75;

type Phase = "listen" | "shadow" | "say" | "compare";
const STEPS: [Phase, string, string][] = [
  ["listen", "听", "先听懂：看着原文听两遍"],
  ["shadow", "跟", "影子跟读：和她同时说，压着她的声音走"],
  ["say", "说", "不看原文，自己说出来"],
  ["compare", "比", "听原声，再听自己"],
];

export function Shadow({ run }: { run: boolean }) {
  const [round, setRound] = useState(0);
  const again = () => {
    shadowNext([]);
    setRound((r) => r + 1);
  };
  return run ? <ShadowRound key={round} onAgain={again} /> : <ShadowHome />;
}

/* ---------- home ---------- */

function streakOf(days: Record<string, number>) {
  let n = 0;
  const d = new Date();
  if (!days[dayKey(d)]) d.setDate(d.getDate() - 1);
  while (days[dayKey(d)]) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function ShadowHome() {
  const shadow = useStore((s) => s.progress.shadow);
  const [takes, setTakes] = useState(0);
  useEffect(() => {
    void countTakes().then(setTakes);
  }, []);
  const today = shadow.days[dayKey()] ?? 0;
  const total = Object.values(shadow.days).reduce((a, b) => a + b, 0);
  return (
    <div className="page shadow-home">
      <header className="page-head">
        <p className="eyebrow">跟读 · Shadowing</p>
        <h1 className="display">开口，才是你的。</h1>
        <p className="lede">一句四步：听 → 跟 → 说 → 比。每轮 {ROUND} 句、大约 6 分钟；句子来自你刚学的词，练过的句子会隔几天再回来。</p>
      </header>

      <section className="shadow-hero">
        <ol className="shadow-steps">
          {STEPS.map(([k, label, tip]) => (
            <li key={k}>
              <b>{label}</b>
              <span>{tip}</span>
            </li>
          ))}
        </ol>
        <button
          className="btn btn-primary btn-xl"
          onClick={() => {
            shadowNext([]);
            go({ page: "shadow", run: true });
          }}
        >
          <Mic size={20} /> 开始跟读 {ROUND} 句
        </button>
        {!canRecord() && <p className="shadow-note">这个浏览器不能录音：仍可以听和跟读，只是没法回放自己的声音。</p>}
      </section>

      <section className="shadow-stats" aria-label="跟读记录">
        <div>
          <b>{today}</b>
          <small>今天</small>
        </div>
        <div>
          <b>
            <Flame size={18} /> {streakOf(shadow.days)}
          </b>
          <small>连续天数</small>
        </div>
        <div>
          <b>{shadow.best}</b>
          <small>最长连击</small>
        </div>
        <div>
          <b>{total}</b>
          <small>累计句子</small>
        </div>
        <div>
          <b>{takes}</b>
          <small>声音日记</small>
        </div>
      </section>

      <p className="shadow-foot">
        声音日记只存在这台设备上，不进备份。练过的句子再遇到时，可以听听「第一次的你」。
        <a href="#/practice">
          <Keyboard size={15} /> 打字练习
        </a>
      </p>
    </div>
  );
}

/* ---------- one round ---------- */

interface Item {
  ref: SentenceRef;
  entry: Entry;
  en: string;
  zh: string;
}

function useRound() {
  const atlas = useAtlas();
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    let live = true;
    const { progress, settings } = store.get();
    const start = Math.max(0, atlas.words.findIndex((w) => w.cefr >= settings.startLevel));
    const refs = pickSentences(
      atlas.words.map((w) => ({ id: w.id, media: w.media })),
      progress.cards,
      progress.shadow,
      Date.now(),
      ROUND,
      start,
      shadowFocus(),
    );
    void prefetch(
      atlas,
      refs.map((r) => r.id),
    ).then((entries) => {
      if (!live) return;
      const out: Item[] = [];
      refs.forEach((ref, k) => {
        const e = entries[k];
        const ex = e?.ex[ref.i];
        if (e && ex?.en) out.push({ ref, entry: e, en: ex.en, zh: ex.zh });
      });
      setItems(out);
    });
    return () => {
      live = false;
    };
  }, [atlas]);
  return items;
}

function ShadowRound({ onAgain }: { onAgain: () => void }) {
  const items = useRound();
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [index, setIndex] = useState(0);
  const [combo, setCombo] = useState(0);
  const [best, setBest] = useState(0);
  const [doneKeys, setDoneKeys] = useState<string[]>([]);
  const mic = useRef<MicT | null>(null);
  const [micState, setMicState] = useState<"idle" | "asking" | "ready" | "denied">("idle");
  useEffect(() => {
    if (items) setQueue(items);
  }, [items]);
  useEffect(
    () => () => {
      stopAudio();
      mic.current?.close();
      mic.current = null;
    },
    [],
  );

  const ensureMic = useCallback(async () => {
    if (mic.current) return mic.current;
    if (!canRecord()) {
      setMicState("denied");
      return null;
    }
    setMicState("asking");
    try {
      mic.current = await openMic();
      setMicState("ready");
      return mic.current;
    } catch {
      setMicState("denied");
      toast("没拿到麦克风权限：可以在浏览器设置里允许，或者只听不录", "info");
      return null;
    }
  }, []);

  const exit = () => {
    stopAudio();
    go({ page: "shadow" });
  };

  if (!queue) return <div className="learn learn-loading"><span className="spinner" /></div>;
  if (!queue.length)
    return (
      <div className="learn shadow-empty">
        <p>还没有可以跟读的句子：先去学几个词吧。</p>
        <button className="btn btn-primary" onClick={() => go({ page: "today" })}>
          去今日旅程 <ArrowRight size={18} />
        </button>
      </div>
    );
  if (index >= queue.length) return <RoundSummary count={doneKeys.length} best={best} onAgain={onAgain} />;

  const item = queue[index];
  const rate = (good: boolean) => {
    const next = good ? combo + 1 : 0;
    setCombo(next);
    setBest((b) => Math.max(b, next));
    recordShadow(sentenceKey(item.ref), good, next);
    setDoneKeys((k) => [...k, sentenceKey(item.ref)]);
    if (store.get().settings.sfx) void cue(good && next > 0 && next % 3 === 0 ? "streak" : good ? "correct" : "flip");
    // Not there yet: it comes back once more at the end of this round.
    if (!good && queue.filter((x) => sentenceKey(x.ref) === sentenceKey(item.ref)).length < 2) setQueue([...queue, item]);
    setIndex(index + 1);
  };

  return (
    <div className="learn shadow-round">
      <header className="learn-top">
        <button className="icon-btn" onClick={exit} aria-label="结束跟读">
          <X size={22} />
        </button>
        <div className="learn-progress" role="progressbar" aria-valuemin={0} aria-valuemax={queue.length} aria-valuenow={index}>
          <span style={{ width: `${(index / queue.length) * 100}%` }} />
        </div>
        <span className={`shadow-combo ${combo >= 3 ? "is-hot" : ""}`} aria-label={`连击 ${combo}`}>
          <Flame size={16} /> {combo}
        </span>
      </header>
      <main className="learn-stage" key={`${index}-${sentenceKey(item.ref)}`}>
        <Sentence item={item} first={index === 0} ensureMic={ensureMic} micState={micState} mic={mic} onRate={rate} />
      </main>
    </div>
  );
}

/* ---------- one sentence: listen → shadow → say → compare ---------- */

function Sentence({
  item,
  first,
  ensureMic,
  micState,
  mic,
  onRate,
}: {
  item: Item;
  first: boolean;
  ensureMic: () => Promise<MicT | null>;
  micState: string;
  mic: React.RefObject<MicT | null>;
  onRate: (good: boolean) => void;
}) {
  const atlas = useAtlas();
  const asr = useStore((s) => s.settings.shadowAsr);
  const url = atlas.audio(item.entry, item.ref.i ? "ex2" : "ex");
  const [phase, setPhase] = useState<Phase>("listen");
  const [word, setWord] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [showZh, setShowZh] = useState(false);
  const [peek, setPeek] = useState(false);
  const [rec, setRec] = useState<{ take: Take; hearing: Hearing | null } | null>(null);
  const [mine, setMine] = useState<{ url: string; blob: Blob } | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [past, setPast] = useState<{ take: VoiceTake; url: string } | null>(null);
  const [listens, setListens] = useState(0);
  const times = useMemo(() => wordTimes(item.en), [item.en]);
  const words = useMemo(() => sentenceWords(item.en), [item.en]);
  const target = useMemo(() => {
    const m = headwordPattern(item.entry.w).exec(item.en);
    return m ? [m.index, m.index + m[0].length] : null;
  }, [item]);
  const useAsr = canRecognize() && (asr === "on" || (asr === "auto" && !isAppleMobile()));

  useEffect(() => {
    let live = true;
    let made = "";
    void getTakes(sentenceKey(item.ref)).then((t) => {
      // Only a take from an earlier day is worth comparing with.
      if (live && t.first && t.first.at < Date.now() - 12 * 3600e3) setPast({ take: t.first, url: (made = URL.createObjectURL(t.first.blob)) });
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [item.ref]);
  useEffect(() => () => void (mine && URL.revokeObjectURL(mine.url)), [mine]);
  // Leaving mid-take: stop listening and give the ambience its volume back.
  const recRef = useRef(rec);
  recRef.current = rec;
  useEffect(
    () => () => {
      const r = recRef.current;
      if (r) {
        r.hearing?.abort();
        void r.take.stop();
        duck(false);
      }
    },
    [],
  );

  const speak = useCallback(
    async (rateMul = 1) => {
      setPlaying(true);
      const res = await play(url, "", "us", rateMul, (f) => setWord(times.findIndex(([a, b]) => f >= a && f < b)));
      setPlaying(false);
      setWord(-1);
      if (res === "unsupported") toast("这句的录音没播放出来：检查网络，或点「重听」再试", "info");
      return res;
    },
    [url, times],
  );

  // Every sentence after the first opens by playing itself; the first waits for a tap (autoplay rules).
  useEffect(() => {
    if (!first) {
      setListens(1);
      void speak();
    }
    return () => stopAudio();
  }, [first, speak]);

  const toShadow = () => {
    setPhase("shadow");
    void speak();
  };
  const toSay = () => {
    stopAudio();
    setPhase("say");
    setPeek(false);
  };
  const startRec = async () => {
    stopAudio();
    const m = await ensureMic();
    duck(true);
    const hearing = useAsr ? hear(item.en) : null;
    if (!m) {
      setRec(null);
      if (hearing) setRec({ take: { stop: async () => null }, hearing });
      return;
    }
    setRec({ take: m.record(), hearing });
  };
  const stopRec = async () => {
    if (!rec) return;
    const [blob, said] = await Promise.all([rec.take.stop(), rec.hearing?.stop() ?? Promise.resolve(null)]);
    duck(false);
    setRec(null);
    setHeard(said);
    setPhase("compare");
    if (blob) {
      const u = URL.createObjectURL(blob);
      setMine({ url: u, blob });
      void saveTake(sentenceKey(item.ref), blob);
      // Hear yourself straight away: the contrast with the original is the whole point.
      window.setTimeout(() => void play(u, ""), 150);
    }
  };
  const skipRec = () => {
    stopAudio();
    setPhase("compare");
  };
  const playMine = () => mine && void play(mine.url, "");
  const playBoth = async () => {
    const r = await speak();
    if (r === "recorded" && mine) await play(mine.url, "");
  };
  const playPast = () => past && void play(past.url, "");

  const primary = phase === "listen" ? (listens ? toShadow : () => (setListens(1), void speak())) : phase === "shadow" ? toSay : phase === "say" ? (rec ? stopRec : startRec) : () => onRate(true);
  useKeys({ Enter: primary, " ": primary });

  const flags = heard !== null ? heardWords(item.en, heard) : null;
  const score = heard !== null ? heardScore(item.en, heard) : null;
  const hidden = phase === "say" && !peek;

  return (
    <div className={`shadow-card phase-${phase}`}>
      <ol className="shadow-path" aria-label="一句四步">
        {STEPS.map(([k, label]) => (
          <li key={k} className={k === phase ? "is-on" : STEPS.findIndex((s) => s[0] === k) < STEPS.findIndex((s) => s[0] === phase) ? "is-done" : ""}>
            {label}
          </li>
        ))}
      </ol>
      <p className="shadow-tip">{STEPS.find((s) => s[0] === phase)![2]}</p>

      <div className="shadow-text">
        {hidden ? (
          <>
            <p className="shadow-zh">{item.zh}</p>
            <p className="shadow-cue" lang="en">
              {firstLetters(item.en)}
            </p>
          </>
        ) : (
          <p className="shadow-en" lang="en">
            {words.map((w, k) => (
              <span
                key={k}
                className={[
                  "sw",
                  k === word ? "is-now" : "",
                  target && w.start < target[1] && w.end > target[0] ? "is-target" : "",
                  flags ? (flags[k] ? "is-heard" : "is-missed") : "",
                ].join(" ")}
              >
                {w.w}{" "}
              </span>
            ))}
          </p>
        )}
        {!hidden && (
          <button className={`shadow-zh-toggle ${showZh || phase === "compare" ? "is-open" : ""}`} onClick={() => setShowZh(true)}>
            {showZh || phase === "compare" ? item.zh : "点一下看中文"}
          </button>
        )}
        <p className="shadow-word">
          <span lang="en">{item.entry.w}</span> {item.entry.senses[0]?.zh}
          <i>{item.ref.i ? "雅思语境" : "日常"}</i>
        </p>
      </div>

      {phase === "compare" && score !== null && (
        <p className={`shadow-score ${score >= 85 ? "is-great" : score >= 60 ? "is-ok" : ""}`}>
          识别出 <b>{score}%</b> 的词{score >= 85 ? "，很像了" : score >= 60 ? "，红色的再练练" : "，慢一点、咬字清楚些"}
        </p>
      )}

      <div className="shadow-controls">
        {phase === "listen" && (
          <>
            <button className="btn btn-ghost" onClick={() => void speak(SLOW)} disabled={playing}>
              <Snail size={18} /> 慢速
            </button>
            {listens ? (
              <>
                <button className="btn btn-ghost" onClick={() => void speak()} disabled={playing}>
                  <RotateCcw size={18} /> 重听
                </button>
                <button className="btn btn-primary btn-xl" onClick={toShadow}>
                  跟读 <ArrowRight size={20} />
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-xl" onClick={() => (setListens(1), void speak())}>
                <Play size={20} /> 听原声
              </button>
            )}
          </>
        )}
        {phase === "shadow" && (
          <>
            <button className="btn btn-ghost" onClick={() => void speak(SLOW)} disabled={playing}>
              <Snail size={18} /> 慢速跟
            </button>
            <button className="btn btn-ghost" onClick={() => void speak()} disabled={playing}>
              <RotateCcw size={18} /> 再跟一遍
            </button>
            <button className="btn btn-primary btn-xl" onClick={toSay}>
              自己说 <ArrowRight size={20} />
            </button>
          </>
        )}
        {phase === "say" && (
          <>
            <button className="btn btn-ghost" onClick={() => setPeek((p) => !p)}>
              <BookOpenText size={18} /> {peek ? "盖住原文" : "偷看一眼"}
            </button>
            <MicButton recording={!!rec} mic={mic} asking={micState === "asking"} onStart={startRec} onStop={stopRec} />
            {micState === "denied" && !rec && (
              <button className="btn btn-ghost" onClick={skipRec}>
                我说完了 <ArrowRight size={18} />
              </button>
            )}
          </>
        )}
        {phase === "compare" && (
          <>
            <div className="shadow-listen">
              <button className="btn btn-ghost" onClick={() => void speak()}>
                <Ear size={18} /> 原声
              </button>
              {mine && (
                <>
                  <button className="btn btn-ghost" onClick={playMine}>
                    <Mic size={18} /> 我的
                  </button>
                  <button className="btn btn-ghost" onClick={() => void playBoth()}>
                    <Play size={18} /> 连着听
                  </button>
                </>
              )}
              {past && mine && (
                <button className="btn btn-ghost shadow-past" onClick={playPast}>
                  <Sparkles size={18} /> 第一次的我 · {Math.max(1, Math.round((Date.now() - past.take.at) / 864e5))} 天前
                </button>
              )}
            </div>
            <div className="shadow-rate">
              <button className="btn btn-ghost" onClick={() => (setPhase("say"), setHeard(null), setPeek(false))}>
                <RotateCcw size={18} /> 再说一遍
              </button>
              <button className="btn btn-ghost" onClick={() => onRate(false)}>
                还差点
              </button>
              <button className="btn btn-primary btn-xl" onClick={() => onRate(true)}>
                像了！ <ArrowRight size={20} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MicButton({ recording, mic, asking, onStart, onStop }: { recording: boolean; mic: React.RefObject<MicT | null>; asking: boolean; onStart: () => void; onStop: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!recording) return;
    let frame = 0;
    const tick = () => {
      ref.current?.style.setProperty("--lvl", String(mic.current?.level() ?? 0));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [recording, mic]);
  return (
    <button ref={ref} className={`shadow-mic ${recording ? "is-on" : ""}`} onClick={recording ? onStop : onStart} disabled={asking} aria-label={recording ? "说完了" : "开始说"}>
      {recording ? <Square size={26} /> : asking ? <Pause size={26} /> : <Mic size={30} />}
      <span>{recording ? "说完了" : asking ? "等待麦克风…" : "按一下，开始说"}</span>
    </button>
  );
}

function RoundSummary({ count, best, onAgain }: { count: number; best: number; onAgain: () => void }) {
  const shadow = useStore((s) => s.progress.shadow);
  const today = shadow.days[dayKey()] ?? 0;
  useEffect(() => {
    if (store.get().settings.sfx) void cue("complete");
  }, []);
  return (
    <div className="learn summary shadow-summary">
      <div className="summary-card">
        <p className="eyebrow">这一轮</p>
        <h2 className="display">开口 {count} 次。</h2>
        <div className="summary-stats">
        <dl>
          <div>
            <dt>最长连击</dt>
            <dd>{best}</dd>
          </div>
          <div>
            <dt>今天累计</dt>
            <dd>{today}</dd>
          </div>
          <div>
            <dt>连续天数</dt>
            <dd>{streakOf(shadow.days)}</dd>
          </div>
        </dl>
        </div>
        <p className="summary-note">练过的句子会在 1、3、7、16 天后回来；第一次和最近一次的录音存在声音日记里，下次能听到第一次的自己。</p>
        <div className="summary-actions">
          <button className="btn btn-ghost" onClick={() => go({ page: "shadow" })}>
            完成
          </button>
          <button className="btn btn-primary btn-xl" onClick={onAgain}>
            再来 {ROUND} 句 <ArrowRight size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
