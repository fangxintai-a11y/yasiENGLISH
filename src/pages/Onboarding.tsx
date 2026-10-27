import { ArrowRight, Check, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtlas } from "../atlas/context";
import { daysLeft, examPlan } from "../ielts/exam";
import { estimateKnown, levelShares, nextLevel, PER_LEVEL, sampleLevel, seedCards, startLevelFrom, startPlacement, type PlacementState } from "../ielts/placement";
import { getTags } from "../ielts/tags";
import { play } from "../lib/audio";
import { cue } from "../lib/sound";
import { distractors } from "../store/session";
import { store, useStore } from "../store/store";
import { ExamFields } from "../ui/ExamSetup";

type Stage = "plan" | "test" | "result";

export function Onboarding() {
  const atlas = useAtlas();
  const [stage, setStage] = useState<Stage>("plan");
  const [result, setResult] = useState<PlacementState | null>(null);
  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-label="欢迎">
      <div className={`onboard-card stage-${stage}`}>
        {stage === "plan" && <img className="onboard-art" src={`${import.meta.env.BASE_URL}brand/hero.webp`} alt="" />}
        <div className="onboard-body">
          {stage === "plan" && (
            <>
              <p className="eyebrow">雅思星图 · Band Galaxy</p>
              <h1 className="display">
                {atlas.count.toLocaleString()} 颗星，
                <br />
                从考试那天倒推着点亮。
              </h1>
              <ExamFields compact />
              <button className="btn btn-primary btn-xl" onClick={() => setStage("test")}>
                3 分钟摸底：已经会的词不再从头学 <ArrowRight size={20} />
              </button>
              <button className="btn btn-ghost" onClick={() => finish(atlas, null)}>
                跳过摸底，从 B1 开始
              </button>
              <p className="muted">不用注册。进度只留在这台设备上，随时可以在「我的」里修改。</p>
            </>
          )}
          {stage === "test" && (
            <PlacementRunner
              onDone={(st) => {
                setResult(st);
                setStage("result");
              }}
            />
          )}
          {stage === "result" && result && <PlacementResult st={result} />}
        </div>
      </div>
    </div>
  );
}

const TIME_LIMIT = 6000;

function PlacementRunner({ onDone }: { onDone: (st: PlacementState) => void }) {
  const atlas = useAtlas();
  const accent = useStore((s) => s.settings.accent);
  const seed = useMemo(() => Date.now(), []);
  const [st, setSt] = useState(startPlacement);
  const [i, setI] = useState(0);
  const [right, setRight] = useState<string[]>([]);
  const [picked, setPicked] = useState<{ id: string | null; ok: boolean } | null>(null);
  const [left, setLeft] = useState(TIME_LIMIT);
  const started = useRef(performance.now());
  const level = st.level ?? 0;
  const words = useMemo(() => sampleLevel(atlas, level, seed), [atlas, level, seed]);
  const ref = atlas.byId.get(words[i])!;
  const options = useMemo(() => distractors(atlas, ref, "meaning", seed + i).map((id) => atlas.byId.get(id)!), [atlas, ref, seed, i]);
  const asked = Object.keys(st.asked).length * PER_LEVEL + i;

  useEffect(() => {
    started.current = performance.now();
    setLeft(TIME_LIMIT);
    const t = window.setInterval(() => setLeft(Math.max(0, TIME_LIMIT - (performance.now() - started.current))), 100);
    return () => window.clearInterval(t);
  }, [i, level]);

  const choose = (id: string | null) => {
    if (picked) return;
    // Known = right answer within the time limit; a slow right answer is a guess, not knowledge.
    const ok = id === ref.id && performance.now() - started.current <= TIME_LIMIT;
    setPicked({ id, ok });
    if (store.get().settings.sfx) void cue(ok ? "correct" : "wrong");
    window.setTimeout(() => {
      const nextRight = ok ? [...right, ref.id] : right;
      setPicked(null);
      if (i + 1 < words.length) {
        setRight(nextRight);
        setI(i + 1);
        return;
      }
      const next = nextLevel(st, level, words, nextRight);
      setRight([]);
      setI(0);
      if (next.level === null) onDone(next);
      else setSt(next);
    }, ok ? 450 : 900);
  };

  useEffect(() => {
    if (left === 0 && !picked) choose(null);
  }, [left]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="placement">
      <div className="placement-top">
        <p className="eyebrow">摸底 · 第 {asked + 1} 题</p>
        <span className={`chip chip-level lv-${atlas.cefr[level]}`}>{atlas.cefr[level]}</span>
      </div>
      <div className="placement-timer" aria-hidden="true">
        <span style={{ width: `${(left / TIME_LIMIT) * 100}%` }} />
      </div>
      <button className="placement-word" lang="en" onClick={() => play(atlas.audio(ref, accent), ref.word, accent)}>
        {ref.word}
      </button>
      <ul className="options options-zh">
        {options.map((o, k) => {
          const isAnswer = o.id === ref.id;
          const cls = picked ? (isAnswer ? "is-answer" : picked.id === o.id ? "is-chosen" : "is-dim") : "";
          return (
            <li key={o.id}>
              <button className={`option ${cls}`} onClick={() => choose(o.id)} disabled={!!picked}>
                <kbd>{k + 1}</kbd>
                <span>{o.zh}</span>
                {picked && isAnswer && <Check size={18} className="option-mark" />}
                {picked && picked.id === o.id && !isAnswer && <X size={18} className="option-mark" />}
              </button>
            </li>
          );
        })}
      </ul>
      <button className="btn btn-ghost" onClick={() => choose(null)} disabled={!!picked}>
        不认识
      </button>
      <p className="muted">6 秒内选对才算认识。猜对不算，宁可点「不认识」。</p>
    </div>
  );
}

function PlacementResult({ st }: { st: PlacementState }) {
  const atlas = useAtlas();
  const settings = useStore((s) => s.settings);
  const shares = useMemo(() => levelShares(st), [st]);
  const known = estimateKnown(atlas, shares);
  const start = startLevelFrom(shares);
  const skipped = atlas.words.filter((w) => shares[w.cefr] >= 0.85).length;
  const preview = useMemo(() => {
    const p = { ...store.get().progress, cards: { ...store.get().progress.cards, ...seedFor(atlas, st, shares) } };
    return examPlan(atlas, p, { ...settings, startLevel: start }, getTags(), Date.now());
  }, [atlas, st, shares, settings, start]);
  return (
    <div className="placement-result">
      <p className="eyebrow">摸底结果</p>
      <h1 className="display">
        你大约认识 <b>{known.toLocaleString()}</b> 个雅思词。
      </h1>
      <ol className="level-bars">
        {shares.map((v, l) => (
          <li key={l} className={l === start ? "is-start" : ""}>
            <span className={`chip chip-level lv-${atlas.cefr[l]}`}>{atlas.cefr[l]}</span>
            <i>
              <em style={{ width: `${v * 100}%` }} />
            </i>
            <small>{Math.round(v * 100)}%</small>
          </li>
        ))}
      </ol>
      <ul className="result-notes">
        {skipped > 0 && (
          <li>
            <b>{skipped.toLocaleString()}</b> 个已掌握级别的词不再从头教，分散在未来几周<b>随机抽查</b>：忘了的会自动回到计划里。
          </li>
        )}
        <li>
          新词从 <b>{atlas.cefr[start]}</b> 开始。
          {preview.days !== null && preview.phase === "learn"
            ? ` 距考试 ${preview.days} 天，每天 ${preview.newPerDay} 个新词，预计考试当天记得 ${preview.forecast.toLocaleString()} / ${preview.target.toLocaleString()} 个目标词。`
            : ` 每天约 ${settings.dailyMinutes} 分钟。`}
        </li>
      </ul>
      <button className="btn btn-primary btn-xl" onClick={() => finish(atlas, st)}>
        出发 <ArrowRight size={20} />
      </button>
    </div>
  );
}

function seedFor(atlas: ReturnType<typeof useAtlas>, st: PlacementState, shares: number[]) {
  const { progress, settings } = store.get();
  const days = daysLeft(settings.examDate, Date.now());
  return seedCards(atlas, shares, st.right, progress.cards, Date.now(), days === null ? 60 : days - 7);
}

function finish(atlas: ReturnType<typeof useAtlas>, st: PlacementState | null) {
  if (!st) {
    store.settings({ onboarded: true, startLevel: 2 });
    return;
  }
  const shares = levelShares(st);
  const seeded = seedFor(atlas, st, shares);
  store.progress((p) => ({
    ...p,
    cards: { ...seeded, ...p.cards },
    placement: { at: Date.now(), levels: shares, estimate: estimateKnown(atlas, shares), seeded: Object.keys(seeded).length },
  }));
  store.settings({ onboarded: true, startLevel: startLevelFrom(shares) });
}
