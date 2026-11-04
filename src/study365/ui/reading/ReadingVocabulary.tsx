import { useMemo, useState } from "react";
import { useAtlas } from "../../../atlas/context";
import { analyzeText, baseForms, lookupIndex } from "../../../ielts/textimport";
import { ImportTab } from "../../../pages/ielts/ImportTab";
import { addReadingVocabulary } from "../../readingVocabulary";
import { store } from "../../../store/store";
export function ReadingVocabulary({ text }: { text: string }) {
  const atlas = useAtlas();
  const [word, setWord] = useState(""),
    [message, setMessage] = useState(""),
    [unknown, setUnknown] = useState("");
  const index = useMemo(() => lookupIndex(atlas.words), [atlas]);
  const report = useMemo(
    () =>
      analyzeText(
        text,
        index,
        store.get().progress.cards,
        Date.now(),
        store.get().settings.retention,
      ),
    [text, index],
  );
  const add = (value: string) => {
    setWord(value);
    const ref = baseForms(value.trim())
      .map((form) => index.get(form))
      .find(Boolean);
    if (!ref) {
      setUnknown(value);
      setMessage("图鉴里暂未找到这个词，已带入下面的文章取词。");
      return;
    }
    setUnknown("");
    store.progress((progress) =>
      addReadingVocabulary(
        progress,
        ref.id,
        Date.now(),
        store.get().settings.retention,
      ),
    );
    setMessage(`已将 ${ref.word} 加入错词与FSRS复习。`);
  };
  return (
    <section aria-label="听读生词回流">
      <h3>把生词带入复习</h3>
      <p>点选原文里的生词，或输入一个词后加入复习。</p>
      <div className="data-actions">
        {report.found
          .filter((item) => item.status !== "known")
          .slice(0, 30)
          .map((item) => (
            <button
              key={item.word.id}
              type="button"
              className="btn btn-ghost"
              onClick={() => add(item.word.word)}
            >
              {item.word.word}
            </button>
          ))}
      </div>
      <label className="field">
        <span>生词</span>
        <input
          aria-label="听读生词"
          value={word}
          maxLength={120}
          onChange={(e) => setWord(e.target.value)}
        />
      </label>
      <button
        className="btn btn-primary"
        disabled={!word.trim()}
        onClick={() => add(word)}
      >
        加入词汇
      </button>
      {message && <p role="status">{message}</p>}
      {unknown && (
        <ImportTab key={unknown} initialText={`${unknown}\n${text}`} />
      )}
    </section>
  );
}
