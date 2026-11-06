import { Languages, Pause, Sparkles, Trash2, Volume2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAtlas } from "../../atlas/context";
import { getKey } from "../../ielts/aikey";
import { play, stopAudio } from "../../lib/audio";
import { go, openWord } from "../../lib/router";
import { headwordPattern } from "../../lib/text";
import { recallAt } from "../../store/srs";
import { store, useStore, type Reading } from "../../store/store";
import { toast } from "../../ui/Toast";

const LABELS = ["TRUE", "FALSE", "NOT GIVEN"] as const;

/** The words a passage should be built around: recent mistakes first, then the most forgotten. */
function pickWords(p: ReturnType<typeof store.get>["progress"], has: (id: string) => boolean) {
  const now = Date.now();
  const out: string[] = [];
  for (const id of p.mistakes) if (has(id) && !out.includes(id) && out.length < 12) out.push(id);
  if (out.length < 12) {
    const weak = Object.entries(p.cards)
      .filter(([id, c]) => has(id) && !c.src && !out.includes(id))
      .sort((a, b) => recallAt(a[1], now) - recallAt(b[1], now))
      .map(([id]) => id);
    out.push(...weak.slice(0, 12 - out.length));
  }
  return out;
}

export function ReadingTab() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(progress.readings[0]?.id ?? null);
  const words = useMemo(() => pickWords(progress, (id) => atlas.byId.has(id)), [progress, atlas]);
  const reading = progress.readings.find((r) => r.id === openId) ?? null;

  const generate = async () => {
    if (!getKey()) {
      setError("先在「我的 → AI 助教」里填入你的 Claude API Key。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const list = words.map((id) => atlas.byId.get(id)!);
      const { generateReading } = await import("../../ielts/ai");
      const g = await generateReading(
        list.map((w) => ({ word: w.word, zh: w.zh })),
        settings.targetBand,
        settings.aiModel,
      );
      const r: Reading = { id: `r${Date.now()}`, at: Date.now(), title: g.title, passage: g.passage, zh: g.zh, words, questions: g.questions, answers: g.questions.map(() => null) };
      store.progress((p) => ({ ...p, readings: [r, ...p.readings].slice(0, 30) }));
      setOpenId(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lab-grid">
      <section className="panel span-2 reading-gen">
        <div>
          <h3 className="eyebrow">用你的错词，写一篇专属雅思阅读</h3>
          <p className="muted">
            Claude 会围绕这 {words.length} 个词写一篇 300 词左右的学术短文，再出 5 道 True / False / Not Given：错词在真实题型里再见一次，也顺便练了阅读。
          </p>
          <ul className="chip-cloud">
            {words.map((id) => (
              <li key={id}>
                <button className="chip-btn" onClick={() => openWord(id)} lang="en">
                  {atlas.byId.get(id)!.word}
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="warn-text">{error}</p>}
        </div>
        <div className="reading-gen-actions">
          <button className="btn btn-primary" onClick={generate} disabled={busy || words.length < 5}>
            <Sparkles size={18} /> {busy ? "Claude 正在写…" : "生成一篇"}
          </button>
          {!getKey() && (
            <button className="link" onClick={() => go({ page: "me" })}>
              去填 API Key
            </button>
          )}
          <small className="muted">模型：{settings.aiModel}</small>
        </div>
      </section>

      {progress.readings.length > 0 && (
        <section className="panel reading-list">
          <h3 className="eyebrow">我的阅读</h3>
          <ul>
            {progress.readings.map((r) => {
              const done = r.answers.filter((a) => a !== null).length;
              const right = r.answers.filter((a, i) => a === r.questions[i]?.a).length;
              return (
                <li key={r.id} className={r.id === openId ? "is-on" : ""}>
                  <button onClick={() => setOpenId(r.id)}>
                    <b lang="en">{r.title}</b>
                    <small>
                      {new Date(r.at).toLocaleDateString()} · {done === r.questions.length ? `${right}/${r.questions.length} 正确` : `${done}/${r.questions.length} 已答`}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {reading && <ReadingView key={reading.id} r={reading} />}
    </div>
  );
}

function ReadingView({ r }: { r: Reading }) {
  const atlas = useAtlas();
  const accent = useStore((s) => s.settings.accent);
  const [zh, setZh] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const patterns = useMemo(
    () =>
      r.words
        .map((id) => atlas.byId.get(id))
        .filter((w): w is NonNullable<typeof w> => !!w)
        .map((w) => ({ id: w.id, re: new RegExp(headwordPattern(w.word).source, "gi") })),
    [r, atlas],
  );
  const answer = (i: number, a: string) =>
    store.progress((p) => ({ ...p, readings: p.readings.map((x) => (x.id === r.id ? { ...x, answers: x.answers.map((v, k) => (k === i ? a : v)) } : x)) }));
  const remove = () => {
    if (!confirm("删除这篇阅读？")) return;
    store.progress((p) => ({ ...p, readings: p.readings.filter((x) => x.id !== r.id) }));
    toast("已删除");
  };
  const read = async () => {
    if (speaking) {
      stopAudio();
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    await play(null, r.passage, accent, 0.95);
    setSpeaking(false);
  };

  return (
    <section className="panel span-2 reading-view">
      <header className="panel-head">
        <h2 className="reading-title" lang="en">
          {r.title}
        </h2>
        <div className="data-actions">
          <button className="icon-btn" onClick={read} aria-label={speaking ? "停止朗读" : "朗读全文"} title={speaking ? "停止朗读" : "朗读全文"}>
            {speaking ? <Pause size={18} /> : <Volume2 size={18} />}
          </button>
          <button className={`icon-btn ${zh ? "is-on" : ""}`} onClick={() => setZh(!zh)} aria-pressed={zh} aria-label="中文翻译" title="中文翻译">
            <Languages size={18} />
          </button>
          <button className="icon-btn" onClick={remove} aria-label="删除" title="删除">
            <Trash2 size={18} />
          </button>
        </div>
      </header>
      <div className="reading-body" lang="en">
        {r.passage.split(/\n+/).map((para, i) => (
          <p key={i}>{highlight(para, patterns)}</p>
        ))}
      </div>
      {zh && (
        <div className="reading-zh">
          {r.zh.split(/\n+/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      )}
      <h3 className="eyebrow">Questions · Do the following statements agree with the information given?</h3>
      <ol className="tfng">
        {r.questions.map((q, i) => {
          const a = r.answers[i];
          return (
            <li key={i} className={a ? (a === q.a ? "is-right" : "is-wrong") : ""}>
              <p lang="en">{q.q}</p>
              <div className="segmented">
                {LABELS.map((l) => (
                  <button key={l} className={`${a === l ? "is-on" : ""} ${a && l === q.a ? "is-answer" : ""}`} onClick={() => !a && answer(i, l)} disabled={!!a}>
                    {l}
                  </button>
                ))}
              </div>
              {a && (
                <p className="tfng-why">
                  <b>{a === q.a ? "正确" : `答案是 ${q.a}`}</b> · {q.why}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="muted small">内容由 Claude 生成，可能有不准确之处；高亮的是你的目标词，点一下看词条。</p>
    </section>
  );
}

function highlight(text: string, patterns: { id: string; re: RegExp }[]) {
  const marks: { start: number; end: number; id: string }[] = [];
  for (const { id, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + (m[0].length - m[1].length);
      if (!marks.some((x) => start < x.end && start + m![1].length > x.start)) marks.push({ start, end: start + m[1].length, id });
      if (!m[0].length) re.lastIndex++;
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let at = 0;
  marks.forEach((mk, k) => {
    out.push(text.slice(at, mk.start));
    out.push(
      <button key={k} className="target-word" onClick={() => openWord(mk.id)}>
        {text.slice(mk.start, mk.end)}
      </button>,
    );
    at = mk.end;
  });
  out.push(text.slice(at));
  return out;
}
