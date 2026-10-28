import { Swords } from "lucide-react";
import { useMemo } from "react";
import { useAtlas } from "../../atlas/context";
import { useConfusablesTable } from "../../ielts/confusables";
import { openWord } from "../../lib/router";
import { hashSeed, shuffle } from "../../lib/text";
import { recallAt } from "../../store/srs";
import { useStore, type Step } from "../../store/store";
import { startPractice } from "../Ielts";

/**
 * 易混词对撞: look-alike pairs among the learner's words, drilled head to head: the picture and the
 * sentence of one word, and only the two spellings to choose from.
 */
export function ConfuseTab() {
  const atlas = useAtlas();
  const table = useConfusablesTable();
  const cards = useStore((s) => s.progress.cards);
  const mistakes = useStore((s) => s.progress.mistakes);
  const now = Date.now();
  const pairs = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: string; b: string; weak: number }[] = [];
    const known = (id: string) => !!cards[id] || mistakes.includes(id);
    for (const [a, list] of Object.entries(table))
      for (const b of list) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key) || !atlas.byId.has(a) || !atlas.byId.has(b) || !(known(a) || known(b))) continue;
        seen.add(key);
        // The weaker of the two words decides how urgent the pair is.
        const r = (id: string) => (cards[id] ? recallAt(cards[id], now) : mistakes.includes(id) ? 0 : 0.5);
        out.push({ a, b, weak: Math.min(r(a), r(b)) });
      }
    return out.sort((x, y) => x.weak - y.weak);
  }, [table, atlas, cards, mistakes]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = useMemo(() => Object.values(table).reduce((n, l) => n + l.length, 0) / 2, [table]);

  const drill = () => {
    const pick = [...pairs.slice(0, 6), ...shuffle(pairs.slice(6), now)].slice(0, 10);
    const steps: Step[] = [];
    pick.forEach(({ a, b }, i) => {
      // Each word of the pair gets its own question; the two are kept apart in the round.
      for (const [id, other] of [
        [a, b],
        [b, a],
      ])
        steps.push({ id, kind: "picture", track: "r", options: shuffle([id, other], hashSeed(id) + i) });
    });
    // First one word of every pair, then the other, so the two questions of a pair are far apart.
    startPractice([...steps.filter((_, i) => i % 2 === 0), ...steps.filter((_, i) => i % 2 === 1)], "易混词对撞");
  };

  return (
    <div className="lab-grid">
      <section className="panel">
        <h3 className="eyebrow">易混词对撞</h3>
        <p className="para-big">
          <b>{pairs.length.toLocaleString()}</b> 对
        </p>
        <p className="muted">
          图鉴里有 {Math.round(total).toLocaleString()} 对长得像的词（adapt / adopt、affect / effect、quite / quiet）。和你学过的词有关的有 {pairs.length} 对。放在一起撞一次，比分开背十次更不容易混。
        </p>
        <button className="btn btn-primary" onClick={drill} disabled={!pairs.length}>
          <Swords size={18} /> 撞 10 对
        </button>
        <p className="muted small">每道题看图和例句，在两个拼写里选一个。日常复习的选择题里，也会故意把易混词放进选项。专项练习不改变排程。</p>
      </section>
      {pairs.length > 0 && (
        <section className="panel span-2">
          <h3 className="eyebrow">你的易混词（越靠前越容易混）</h3>
          <ul className="confuse-list">
            {pairs.slice(0, 60).map(({ a, b }) => (
              <li key={`${a}|${b}`}>
                {[a, b].map((id, k) => {
                  const w = atlas.byId.get(id)!;
                  return (
                    <button key={id} className="confuse-word" onClick={() => openWord(id)}>
                      {k === 1 && <i aria-hidden>⇄</i>}
                      <b lang="en">{w.word}</b>
                      <small>{w.zh.replace(/^[a-z.]+\s*/, "").split(/[；;]/)[0]}</small>
                    </button>
                  );
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
