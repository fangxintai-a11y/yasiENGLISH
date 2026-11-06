import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAtlas, useEntry } from "../atlas/context";
import {
  addPriorityWord,
  priorityLookup,
  priorityWords,
  removePriorityWord,
  sentenceWordCandidates,
} from "../ielts/priority";
import { store, useStore } from "../store/store";
import { Sheet } from "./Sheet";
import { Speak } from "./Speak";

export function ShadowWordSheet({
  surface,
  onClose,
}: {
  surface: string;
  onClose: () => void;
}) {
  const atlas = useAtlas();
  const lookup = useMemo(() => priorityLookup(atlas.words), [atlas]);
  const candidates = useMemo(
    () => sentenceWordCandidates(surface, lookup),
    [surface, lookup],
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(
    candidates[0] ?? null,
  );
  const hits = query.trim()
    ? atlas.words
        .filter((word) =>
          word.word.toLowerCase().startsWith(query.trim().toLowerCase()),
        )
        .slice(0, 8)
        .map((word) => word.id)
    : candidates;
  return createPortal(
    <Sheet open onClose={onClose} label="跟读生词">
      <div className="shadow-word-sheet">
        <p className="eyebrow">跟读遇到的词</p>
        <h2 lang="en">{surface}</h2>
        <label className="shadow-word-search">
          查找词库原形
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="可输入原形查找"
          />
        </label>
        <div
          className="shadow-word-candidates"
          role="group"
          aria-label="可能的词条"
        >
          {hits.map((id) => (
            <button
              key={id}
              type="button"
              className={`btn ${selected === id ? "btn-primary" : "btn-ghost"}`}
              aria-pressed={selected === id}
              onClick={() => setSelected(id)}
              lang="en"
            >
              {atlas.byId.get(id)!.word}
            </button>
          ))}
        </div>
        {!hits.length && (
          <p role="status" className="muted">
            现有词库尚未匹配到这个词。可搜索原形；未收录的词暂不能生成学习卡，也不会被错配到其他词。
          </p>
        )}
        {candidates.length > 1 && !query && (
          <p className="muted small">
            这个词形可能对应不同词条，请按原句选择。
          </p>
        )}
        {selected && <ShadowWordDetails key={selected} id={selected} />}
        <button className="btn btn-ghost" onClick={onClose}>
          继续跟读
        </button>
      </div>
    </Sheet>,
    document.body,
  );
}

function ShadowWordDetails({ id }: { id: string }) {
  const atlas = useAtlas();
  const { entry, error } = useEntry(id);
  const progress = useStore((s) => s.progress);
  const accent = useStore((s) => s.settings.accent);
  const queued = priorityWords(atlas, progress).includes(id);
  if (error) return <p role="alert">词条加载失败，请关闭后重试。</p>;
  if (!entry) return <span className="spinner" />;
  const mark = (added: boolean) => {
    store.progress((p) =>
      p.datasetId !== atlas.id
        ? p
        : added
          ? addPriorityWord(atlas, p, id)
          : removePriorityWord(p, id),
    );
  };
  return (
    <section className="shadow-word-details" aria-label="词条释义">
      <div className="shadow-word-title">
        <b lang="en">{entry.w}</b>
        <Speak
          url={atlas.audio(entry, accent)}
          text={entry.w}
          accent={accent}
          label="单词发音"
        />
      </div>
      <ul>
        {entry.senses.slice(0, 3).map((sense, index) => (
          <li key={index}>
            <span className="pos">{sense.pos}</span> {sense.zh}
          </li>
        ))}
      </ul>
      {queued ? (
        <>
          <p className="priority-saved" role="status">
            已在优先待学池中
          </p>
          <button className="btn btn-ghost" onClick={() => mark(false)}>
            移出待学池
          </button>
        </>
      ) : (
        <button className="btn btn-primary" onClick={() => mark(true)}>
          不认识，加入优先学习
        </button>
      )}
      <p className="muted small">
        {progress.cards[id]
          ? "这个词已有学习记录，会排入优先复习；原记忆历史保留。"
          : "加入后排在新词前面；今日额度学完也可从首页自选加学。"}
      </p>
    </section>
  );
}
