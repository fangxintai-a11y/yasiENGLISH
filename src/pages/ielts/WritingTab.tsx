import { PenLine, Shuffle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAtlas, useEntry } from "../../atlas/context";
import type { SentenceGrade } from "../../ielts/ai";
import { getKey } from "../../ielts/aikey";
import { effectiveRetention } from "../../ielts/exam";
import { useTags } from "../../ielts/tags";
import { go, openWord } from "../../lib/router";
import { splitPair } from "../../lib/text";
import { recallAt, review, Rating, type Grade } from "../../store/srs";
import { store, useStore } from "../../store/store";

const GRADE_OF: Grade[] = [Rating.Again, Rating.Again, Rating.Hard, Rating.Good];

/**
 * Write one sentence with a word, get it marked like an IELTS examiner would. The mark is also a
 * review of the word's production card: writing it well is the strongest evidence of knowing it.
 */
export function WritingTab() {
  const atlas = useAtlas();
  const tags = useTags();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const now = Date.now();
  const candidates = useMemo(() => {
    const learned = Object.keys(progress.cards).filter((id) => atlas.byId.has(id) && !progress.cards[id].src);
    const awl = learned.filter((id) => id in tags.awl);
    const pool = awl.length >= 5 ? awl : learned;
    return pool.sort((a, b) => {
      const ca = progress.skills[`p:${a}`];
      const cb = progress.skills[`p:${b}`];
      return (ca ? recallAt(ca, now) : -1) - (cb ? recallAt(cb, now) : -1);
    });
  }, [progress, tags, atlas]); // eslint-disable-line react-hooks/exhaustive-deps
  // The word stays fixed while it is on screen; grading re-sorts the candidates underneath.
  const [current, setCurrent] = useState<string | null>(null);
  const id = current && atlas.byId.has(current) ? current : candidates[0];
  useEffect(() => {
    if (!current && candidates[0]) setCurrent(candidates[0]);
  }, [current, candidates]);
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SentenceGrade | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { entry } = useEntry(id ?? null);

  if (!id)
    return (
      <section className="panel">
        <p className="muted">先学一些词再来造句。学术词（AWL）会优先出现在这里。</p>
      </section>
    );
  const ref = atlas.byId.get(id)!;

  const next = () => {
    const today = new Date().toDateString();
    const fresh = (c: string) => {
      const last = progress.skills[`p:${c}`]?.last;
      return !last || new Date(last).toDateString() !== today;
    };
    setCurrent(candidates.find((c) => c !== id && fresh(c)) ?? candidates.find((c) => c !== id) ?? id);
    setSentence("");
    setResult(null);
    setError(null);
  };
  const grade = async () => {
    if (!getKey()) {
      setError("先在「我的 → AI 助教」里填入你的 Claude API Key。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { gradeSentence } = await import("../../ielts/ai");
      const g = await gradeSentence(ref.word, ref.zh, sentence.trim(), settings.aiModel);
      setResult(g);
      // The first mark of the day counts as a review of the production card.
      const key = `p:${id}`;
      const t = Date.now();
      store.progress((p) => {
        const c = p.skills[key];
        if (c?.last && new Date(c.last).toDateString() === new Date(t).toDateString()) return p;
        return { ...p, skills: { ...p.skills, [key]: review(c, GRADE_OF[g.score], t, effectiveRetention(store.get().settings, t)) } };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lab-grid">
      <section className="panel span-2 writing">
        <div className="panel-head">
          <h3 className="eyebrow">用这个词写一句话</h3>
          <button className="btn btn-ghost" onClick={next}>
            <Shuffle size={16} /> 换一个
          </button>
        </div>
        <button className="writing-word" onClick={() => openWord(id)} lang="en">
          {ref.word}
        </button>
        <p className="writing-zh">{ref.zh}</p>
        {entry && entry.col.length > 0 && (
          <p className="muted small">
            常用搭配：
            {entry.col
              .slice(0, 3)
              .map((c) => splitPair(c).en)
              .join(" · ")}
          </p>
        )}
        <textarea className="import-text" rows={3} value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder={`Write a sentence with “${ref.word}”, e.g. about education, technology or the environment…`} lang="en" />
        <div className="data-actions">
          <button className="btn btn-primary" onClick={grade} disabled={busy || sentence.trim().split(/\s+/).length < 4}>
            <PenLine size={18} /> {busy ? "批改中…" : "请考官批改"}
          </button>
          {!getKey() && (
            <button className="link" onClick={() => go({ page: "me" })}>
              去填 API Key
            </button>
          )}
        </div>
        {error && <p className="warn-text">{error}</p>}
        {result && (
          <div className={`grade-card s-${result.score}`}>
            <p className="grade-score">
              <b>{result.score}</b>/3 · {result.verdict}
            </p>
            {result.corrected.trim() !== sentence.trim() && (
              <p>
                <small>改正</small>
                <span lang="en">{result.corrected}</span>
              </p>
            )}
            <p>
              <small>7 分版本</small>
              <span lang="en">{result.better}</span>
            </p>
            {result.notes.length > 0 && (
              <ul>
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            <p className="muted small">这次批改已记入「写作产出」记忆：3 分 = 良好，2 分 = 困难，1 分及以下 = 重来（每个词每天只计一次）。</p>
            <button className="btn btn-ghost" onClick={next}>
              下一个词
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
