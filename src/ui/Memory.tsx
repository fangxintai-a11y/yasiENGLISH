import { Brain, ChevronDown, RefreshCw, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtlas } from "../atlas/context";
import type { WordRef } from "../atlas/types";
import { loadMnemonic, useTags, type Mnemonic } from "../ielts/tags";
import { openWord } from "../lib/router";
import { buildHack, needsManualFallback } from "../ielts/scoring";
import { useSyllables } from "../ielts/syllables";
import { ManualPrompt } from "./ManualPrompt";
import { recallAt } from "../store/srs";
import { store, useStore, type SavedHack } from "../store/store";
import { getCloudState, useCloudSync } from "../store/cloudSync";
import { toast } from "./Toast";

/** Why this word is in the IELTS plan: listening corpus chapter, AWL sublist, paraphrase links. */
export function WhyTags({ id }: { id: string }) {
  const tags = useTags();
  const atlas = useAtlas();
  const syn = (tags.syn[id] ?? []).filter((x) => atlas.byId.has(x)).length;
  const chips: [string, string][] = [];
  if (tags.listening[id]) chips.push(["listen", `听力高频 · 王陆 ${tags.listening[id]}`]);
  if (tags.awl[id]) chips.push(["awl", `学术词 AWL ${tags.awl[id]}`]);
  if (syn) chips.push(["syn", `同义替换 ${syn}`]);
  if (!chips.length) return null;
  return (
    <div className="why-tags">
      {chips.map(([k, label]) => (
        <span key={k} className={`chip chip-why why-${k}`}>
          {label}
        </span>
      ))}
    </div>
  );
}

/** Roots, a memory hook and a tiny story (DictionaryByGPT4). */
export function MnemonicBlock({ refw, open = false }: { refw: WordRef; open?: boolean }) {
  const [m, setM] = useState<Mnemonic | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setM(undefined);
    loadMnemonic(refw.order, refw.id).then((x) => live && setM(x));
    return () => {
      live = false;
    };
  }, [refw]);
  if (!m) return null;
  const root = [m.root, m.affix].filter(Boolean).join("\n");
  return (
    <section className="mnemo">
      <h3 className="eyebrow">
        <Brain size={15} /> 记忆钩子
      </h3>
      {m.memory && <p className="mnemo-memory">{m.memory}</p>}
      <details open={open}>
        <summary>
          词根 · 小故事 <ChevronDown size={15} />
        </summary>
        {root && <p className="mnemo-root">{root}</p>}
        {m.story && <p className="mnemo-story">{m.story}</p>}
        {m.history && <p className="mnemo-history">{m.history}</p>}
        <p className="mnemo-credit">内容来自 DictionaryByGPT4（CC BY-SA 4.0），由 AI 生成，仅供参考。</p>
      </details>
    </section>
  );
}

/** A word keeps slipping away: forgotten twice, or in the mistake list. */
export function useLeech(id: string) {
  const lapses = useStore((s) => s.progress.cards[id]?.lapses ?? 0);
  const missed = useStore((s) => s.progress.mistakes.includes(id));
  return lapses >= 2 || missed;
}

/** 本地音节拆分与自写谐音、画面，或选择外部接口补全。 */
export function HackBlock({ refw, quiet = false }: { refw: WordRef; quiet?: boolean }) {
  const hack = useStore((s) => s.progress.hacks[refw.id]);
  const mode = useStore((s) => s.settings.feedbackMode);
  const datasetId = useStore((s) => s.progress.datasetId);
  const accountId = useCloudSync().user?.id;
  const syllables = useSyllables(refw.id);
  const leech = useLeech(refw.id);
  const [busy, setBusy] = useState(false);
  const [homophone, setHomophone] = useState(hack?.homophone ?? "");
  const [scene, setScene] = useState(hack?.scene ?? "");
  const [manualInput, setManualInput] = useState<Parameters<typeof buildHack>[0] | null>(null);
  const request = useRef(0);
  useEffect(() => {
    setHomophone(hack?.homophone ?? ""); setScene(hack?.scene ?? "");
  }, [refw.id, hack]);
  useEffect(() => {
    setBusy(false); setManualInput(null);
    return () => { request.current++; };
  }, [refw.id, accountId, datasetId]);
  if (!hack && quiet && !leech) return null;
  const keep = (value: SavedHack) => {
    const saved: SavedHack = { homophone: value.homophone, split: value.split, scene: value.scene, at: value.at,
      ...(value.src ? { src: value.src } : {}) };
    store.progress((p) => ({ ...p, hacks: { ...p.hacks, [refw.id]: saved } }));
  };
  const make = async () => {
    const token = ++request.current;
    const accountId = getCloudState().user?.id, datasetId = store.get().progress.datasetId;
    const isCurrent = () => token === request.current && getCloudState().user?.id === accountId && store.get().progress.datasetId === datasetId;
    setBusy(true);
    try {
      const mnemonic = await loadMnemonic(refw.order, refw.id).catch(() => null);
      const input = { word: refw.word, ipa: refw.ipa, zh: refw.zh, syllables, mnemonic: mnemonic ?? null };
      const h = await buildHack(input, { mode });
      if (!isCurrent()) return;
      keep(h.src === "rules" && hack ? { ...h, homophone: hack.homophone, scene: hack.scene, src: hack.src ?? "legacy" } : h);
      if (mode === "manual" || needsManualFallback(h)) setManualInput(input);
    } catch (e) {
      if (isCurrent()) toast(e instanceof Error ? e.message : String(e), "info");
    } finally {
      if (token === request.current) setBusy(false);
    }
  };
  if (!hack)
    return (
      <button className={`hack-ask ${leech ? "is-leech" : ""}`} onClick={make} disabled={busy}>
        <Wand2 size={16} /> {busy ? "正在拆分…" : leech ? "老是忘？来个邪修记法" : "邪修一下：谐音 · 拆字 · 画面"}
      </button>
    );
  return (
    <section className="hack" aria-label="邪修记法">
      <h3 className="eyebrow">
        <Wand2 size={15} /> 邪修记法
        <button className="hack-redo" onClick={make} disabled={busy} aria-label="重新拆分记法" title="重新拆分">
          <RefreshCw size={14} className={busy ? "spin" : ""} />
        </button>
      </h3>
      <p className="muted small">{hack.src === "rules" ? "本地音节拆分；写下你自己的联想。" : hack.src === "manual" ? "手动保存的记法。" : "外部接口生成的记法，仅供参考。"}</p>
      <dl><div><dt>音节拆分</dt><dd lang="en">{hack.split}</dd></div></dl>
      <form onSubmit={(event) => {
        event.preventDefault();
        keep({ ...hack, homophone: homophone.trim(), scene: scene.trim(), at: Date.now(), src: "manual" });
        toast("已保存自写记法");
      }}>
        <label className="field">自写谐音<input aria-label="自写谐音" value={homophone} maxLength={400} onChange={(event) => setHomophone(event.target.value)} placeholder="写一个能帮助自己记住发音的联想" /></label>
        <label className="field">自写画面<textarea aria-label="自写画面" value={scene} maxLength={400} onChange={(event) => setScene(event.target.value)} placeholder="用一句话描述你想到的画面" /></label>
        <button className="btn btn-ghost" type="submit">保存自写记法</button>
      </form>
      {manualInput && <ManualPrompt task="hack" input={manualInput} onAccept={(value) => { keep(value as SavedHack); setManualInput(null); }} onCancel={() => setManualInput(null)} />}
    </section>
  );
}

/** A word and its in-atlas synonyms as a small constellation; brightness = recall now. */
export function Constellation({ id }: { id: string }) {
  const atlas = useAtlas();
  const tags = useTags();
  const cards = useStore((s) => s.progress.cards);
  const syns = useMemo(() => (tags.syn[id] ?? []).filter((x) => atlas.byId.has(x)).slice(0, 8), [tags, id, atlas]);
  if (!syns.length) return null;
  const now = Date.now();
  const glow = (wid: string) => {
    const c = cards[wid];
    return c ? 0.35 + 0.65 * recallAt(c, now) : 0.12;
  };
  const W = 320;
  const H = 190;
  const cx = W / 2;
  const cy = H / 2;
  const pts = syns.map((s, i) => {
    const a = -Math.PI / 2 + (i / syns.length) * Math.PI * 2 + (syns.length === 2 ? Math.PI / 2 : 0);
    const r = 70 + (i % 2) * 10;
    return { id: s, x: cx + Math.cos(a) * r * 1.45, y: cy + Math.sin(a) * r * 0.82 };
  });
  const self = atlas.byId.get(id)!;
  return (
    <section className="block constellation">
      <h3 className="eyebrow">同义替换星座</h3>
      <p className="muted">雅思阅读和听力最爱考同义替换。点亮整座星座，原文怎么改写你都认得。</p>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${self.word} 的同义词`}>
        {pts.map((p) => (
          <line key={p.id} x1={cx} y1={cy} x2={p.x} y2={p.y} className="con-line" style={{ opacity: 0.25 + glow(p.id) * 0.5 }} />
        ))}
        <g className="con-node is-self">
          <circle cx={cx} cy={cy} r={7} style={{ opacity: glow(id) }} />
          <text x={cx} y={cy + (pts.some((p) => Math.abs(p.x - cx) < 40 && p.y > cy) ? -14 : 24)} textAnchor="middle">
            {self.word}
          </text>
        </g>
        {pts.map((p) => {
          const w = atlas.byId.get(p.id)!;
          return (
            <g key={p.id} className="con-node" onClick={() => openWord(p.id)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openWord(p.id)}>
              <circle cx={p.x} cy={p.y} r={5} style={{ opacity: glow(p.id) }} />
              <text x={p.x} y={p.y + (p.y > cy ? 18 : -10)} textAnchor="middle">
                {w.word}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}

const TRACKS = [
  ["", "阅读识别", "3 秒内认出"],
  ["l:", "听力拼写", "听到能拼对"],
  ["p:", "写作产出", "想到能写出"],
] as const;

/** Recall of each skill for one word, right now. */
export function TrackMeters({ id }: { id: string }) {
  const cards = useStore((s) => s.progress.cards);
  const skills = useStore((s) => s.progress.skills);
  const tags = useTags();
  const now = Date.now();
  const rows = TRACKS.filter(([prefix]) => prefix === "" || (prefix === "l:" ? id in tags.listening : id in tags.awl)).map(([prefix, name, desc]) => {
    const c = prefix ? skills[prefix + id] : cards[id];
    return { name, desc, value: c ? recallAt(c, now) : null };
  });
  if (rows.every((r) => r.value === null)) return null;
  return (
    <div className="track-meters">
      {rows.map((r) => (
        <div key={r.name} className={r.value === null ? "is-locked" : ""}>
          <span>
            <b>{r.name}</b>
            <small>{r.value === null ? "未解锁" : `${Math.round(r.value * 100)}%`}</small>
          </span>
          <i>
            <em style={{ width: `${(r.value ?? 0) * 100}%` }} />
          </i>
          <small className="track-desc">{r.desc}</small>
        </div>
      ))}
    </div>
  );
}
