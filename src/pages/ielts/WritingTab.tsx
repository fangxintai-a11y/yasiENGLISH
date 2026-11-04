import { PenLine, Shuffle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtlas, useEntry } from "../../atlas/context";
import { scoreSentence, needsManualFallback, type SentenceResult } from "../../ielts/scoring";
import { effectiveRetention } from "../../ielts/exam";
import { useTags } from "../../ielts/tags";
import { openWord } from "../../lib/router";
import { splitPair } from "../../lib/text";
import { recallAt, review, Rating, type Grade } from "../../store/srs";
import { store, useStore } from "../../store/store";
import { getCloudState, useCloudSync } from "../../store/cloudSync";
import { ManualPrompt } from "../../ui/ManualPrompt";

const GRADE_OF: Grade[] = [Rating.Again, Rating.Again, Rating.Hard, Rating.Good];

/**
 * Write one sentence with a word and receive practice feedback. The mark is also a
 * review of the word's production card: writing it well is the strongest evidence of knowing it.
 */
export function WritingTab() {
  const atlas = useAtlas();
  const tags = useTags();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const accountId = useCloudSync().user?.id;
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
  const [result, setResult] = useState<SentenceResult | null>(null);
  const [pastedReviewUnchanged, setPastedReviewUnchanged] = useState(false);
  const [manualInput, setManualInput] = useState<Parameters<typeof scoreSentence>[0] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { entry } = useEntry(id ?? null);
  const request = useRef(0);
  useEffect(() => {
    setBusy(false); setResult(null); setManualInput(null); setPastedReviewUnchanged(false);
    return () => { request.current++; };
  }, [id, atlas.id, accountId, progress.datasetId]);

  if (!id)
    return (
      <section className="panel">
        <p className="muted">先学一些词再来造句。学术词（AWL）会优先出现在这里。</p>
      </section>
    );
  const ref = atlas.byId.get(id)!;

  const next = () => {
    request.current++;
    setBusy(false);
    const today = new Date().toDateString();
    const fresh = (c: string) => {
      const last = progress.skills[`p:${c}`]?.last;
      return !last || new Date(last).toDateString() !== today;
    };
    setCurrent(candidates.find((c) => c !== id && fresh(c)) ?? candidates.find((c) => c !== id) ?? id);
    setSentence("");
    setResult(null);
    setError(null);
    setManualInput(null);
    setPastedReviewUnchanged(false);
  };
  const applyResult = (g: SentenceResult, pasted = false) => {
    setResult(g);
    // Only the first mark of the day reviews this word's production card.
    const key = `p:${id}`, t = Date.now();
    let reviewedToday = false;
    store.progress((p) => {
      const c = p.skills[key];
      if (c?.last && new Date(c.last).toDateString() === new Date(t).toDateString()) { reviewedToday = true; return p; }
      return { ...p, skills: { ...p.skills, [key]: review(c, GRADE_OF[g.score], t, effectiveRetention(store.get().settings, t)) } };
    });
    setPastedReviewUnchanged(pasted && reviewedToday);
  };
  const grade = async () => {
    const token = ++request.current;
    const accountId = getCloudState().user?.id, datasetId = store.get().progress.datasetId;
    const isCurrent = () => token === request.current && getCloudState().user?.id === accountId && store.get().progress.datasetId === datasetId;
    const input = { word: ref.word, zh: ref.zh, sentence: sentence.trim(), entry: entry ?? null };
    setBusy(true);
    setError(null);
    setManualInput(null);
    try {
      const g = await scoreSentence(input, { mode: settings.feedbackMode });
      if (!isCurrent()) return;
      applyResult(g);
      if (settings.feedbackMode === "manual" || needsManualFallback(g)) setManualInput(input);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === request.current) setBusy(false);
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
        <textarea className="import-text" rows={3} value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder={`用“${ref.word}”写一句英语，例如教育、科技或环境话题。`} lang="en" />
        <div className="data-actions">
          <button className="btn btn-primary" onClick={grade} disabled={busy || sentence.trim().split(/\s+/).length < 4}>
            <PenLine size={18} /> {busy ? "批改中…" : "批改句子"}
          </button>
        </div>
        {error && <p className="warn-text">{error}</p>}
        {manualInput && <ManualPrompt task="sentence" input={manualInput} onAccept={(value) => { applyResult(value as SentenceResult, true); setManualInput(null); }} onCancel={() => setManualInput(null)} />}
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
              <small>{result.source === "rules" ? "词库例句" : "8 分参考句"}</small>
              <span lang="en">{result.better}</span>
            </p>
            {result.notes.length > 0 && (
              <ul>
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
            {!!result.warnings?.length && <ul className="warn-text" aria-label="反馈校验提示">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
            {pastedReviewUnchanged && <p className="muted small" role="status">这次结果不影响今天的复习安排</p>}
            <p className="muted small">「写作产出」复习按每个词当天首次评分安排：3 分 = 良好，2 分 = 困难，1 分及以下 = 重来。</p>
            <button className="btn btn-ghost" onClick={next}>
              下一个词
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
