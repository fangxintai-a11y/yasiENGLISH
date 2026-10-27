import { Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import { useAtlas } from "../../atlas/context";
import { useTags } from "../../ielts/tags";
import { openWord } from "../../lib/router";
import { shuffle } from "../../lib/text";
import { paraphraseStep } from "../../store/session";
import { recallAt } from "../../store/srs";
import { useStore, type Step } from "../../store/store";
import { Constellation } from "../../ui/Memory";
import { startPractice } from "../Ielts";

export function ParaphraseTab() {
  const atlas = useAtlas();
  const tags = useTags();
  const cards = useStore((s) => s.progress.cards);
  const [focus, setFocus] = useState<string | null>(null);
  const now = Date.now();
  const learned = useMemo(
    () =>
      Object.entries(cards)
        .filter(([id]) => (tags.syn[id] ?? []).some((x) => atlas.byId.has(x)))
        .sort((a, b) => recallAt(a[1], now) - recallAt(b[1], now))
        .map(([id]) => id),
    [cards, tags, atlas], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const total = useMemo(() => Object.keys(tags.syn).filter((id) => atlas.byId.has(id)).length, [tags, atlas]);
  // Constellations fully lit: the word and all of its in-atlas synonyms are learned.
  const complete = useMemo(() => learned.filter((id) => (tags.syn[id] ?? []).every((x) => !atlas.byId.has(x) || cards[x])).length, [learned, tags, atlas, cards]);

  const drill = () => {
    const pick = [...learned.slice(0, 10), ...shuffle(learned.slice(10), now)].slice(0, 15);
    const steps = pick.map((id, i) => paraphraseStep(atlas, atlas.byId.get(id)!, now + i)).filter((s): s is Step => !!s);
    startPractice(steps, "同义替换专项");
  };
  const shown = focus ?? learned[0] ?? Object.keys(tags.syn)[0];

  return (
    <div className="lab-grid">
      <section className="panel">
        <h3 className="eyebrow">同义替换星座</h3>
        <p className="para-big">
          <b>{learned.length.toLocaleString()}</b> / {total.toLocaleString()}
        </p>
        <p className="muted">
          已学的词里有 {learned.length.toLocaleString()} 个带同义词，其中 {complete.toLocaleString()} 座星座已经全部点亮。雅思阅读题干几乎不会照抄原文：认出改写，才能定位答案。
        </p>
        <button className="btn btn-primary" onClick={drill} disabled={!learned.length}>
          <Waypoints size={18} /> 练 15 道替换题
        </button>
        <p className="muted small">日常复习里，稳定的词也会以替换题出现，并计入记忆进度；这里的专项练习不改变排程。</p>
      </section>
      <section className="panel">{shown && <Constellation id={shown} />}</section>
      {learned.length > 0 && (
        <section className="panel span-2">
          <h3 className="eyebrow">你的星座（越靠前越容易忘）</h3>
          <ul className="chip-cloud">
            {learned.slice(0, 80).map((id) => (
              <li key={id}>
                <button className={`chip-btn ${shown === id ? "is-on" : ""}`} onClick={() => setFocus(id)} onDoubleClick={() => openWord(id)} lang="en">
                  {atlas.byId.get(id)!.word}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
