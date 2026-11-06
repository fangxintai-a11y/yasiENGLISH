import { ArrowRight, ListPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { useAtlas } from "../../atlas/context";
import { analyzeText, lookupIndex, type TextReport } from "../../ielts/textimport";
import { go, openWord } from "../../lib/router";
import { buildSession } from "../../store/session";
import { store, useStore } from "../../store/store";
import { toast } from "../../ui/Toast";

const STATUS = { new: "没学过", weak: "快忘了", known: "已掌握" } as const;

export function ImportTab() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const retention = useStore((s) => s.settings.retention);
  const [text, setText] = useState("");
  const [report, setReport] = useState<TextReport | null>(null);
  const index = useMemo(() => lookupIndex(atlas.words), [atlas]);
  const run = () => setReport(analyzeText(text, index, progress.cards, Date.now(), retention));
  const fresh = report?.found.filter((f) => f.status === "new") ?? [];
  const weak = report?.found.filter((f) => f.status === "weak") ?? [];

  const queue = () => {
    const ids = fresh.map((f) => f.word.id);
    store.progress((p) => ({ ...p, queue: [...new Set([...ids, ...p.queue])].slice(0, 2000) }));
    toast(`已把 ${ids.length} 个生词排到新词队列最前面`, "ok");
  };
  const learnNow = () => {
    const ids = [...weak, ...fresh].slice(0, 30).map((f) => f.word.id);
    const { progress: p, settings } = store.get();
    const s = buildSession(atlas, p, settings, { ids, label: "文章取词" });
    if (!s.steps.length) return;
    store.progress((x) => ({ ...x, session: s }));
    go({ page: "learn" });
  };

  return (
    <div className="lab-grid">
      <section className="panel span-2">
        <h3 className="eyebrow">粘贴一段英文</h3>
        <p className="muted">剑桥真题、外刊、你正在读的任何文章。分析只在本机进行，原文不会被保存或上传。</p>
        <textarea className="import-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a passage here…" lang="en" rows={8} />
        <button className="btn btn-primary" onClick={run} disabled={text.trim().length < 20}>
          分析生词
        </button>
      </section>

      {report && (
        <>
          <section className="panel import-summary">
            <h3 className="eyebrow">这篇文章</h3>
            <p className="para-big">
              <b>{Math.round(report.coverage * 100)}%</b>
            </p>
            <p className="muted">
              你此刻能一眼认出的实词比例。共 {report.tokens} 个词，图鉴词 {report.found.length} 个：没学过 {fresh.length}，快忘了 {weak.length}。一般认识 95% 以上，阅读才不卡。
            </p>
            <div className="data-actions">
              <button className="btn btn-primary" onClick={learnNow} disabled={!fresh.length && !weak.length}>
                现在学这些词 <ArrowRight size={18} />
              </button>
              <button className="btn btn-ghost" onClick={queue} disabled={!fresh.length}>
                <ListPlus size={18} /> 生词排进新词队列
              </button>
            </div>
          </section>
          <section className="panel">
            <h3 className="eyebrow">图鉴里的词</h3>
            <ul className="import-words">
              {report.found.slice(0, 120).map((f) => (
                <li key={f.word.id} className={`is-${f.status}`}>
                  <button className="link" onClick={() => openWord(f.word.id)} lang="en">
                    {f.word.word}
                  </button>
                  <small>
                    {atlas.cefr[f.word.cefr]} · {STATUS[f.status]}
                    {f.count > 1 ? ` · ×${f.count}` : ""}
                  </small>
                </li>
              ))}
            </ul>
            {report.outside.length > 0 && <p className="muted small">不在图鉴里（多为人名、专有名词或罕见词）：{report.outside.slice(0, 20).join(", ")}</p>}
          </section>
        </>
      )}
    </div>
  );
}
