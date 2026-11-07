import { useAtlas } from "../atlas/context";
import { assessmentMarks, assessWord, consolidated } from "../ielts/vocabulary";
import { go } from "../lib/router";
import { store, useStore } from "../store/store";

export function VocabularyOverview() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const marks = assessmentMarks(progress);
  const checked = atlas.words.filter((word) => Object.hasOwn(marks, word.id));
  const unknown = checked.filter((word) => marks[word.id].state === "unknown");
  const stable = unknown.filter((word) =>
    consolidated(progress, word.id),
  ).length;
  return (
    <section className="panel vocabulary-overview" aria-label="词汇摸底进度">
      <div>
        <p className="eyebrow">逐词摸底 · 先攻克不会的词</p>
        <h3>
          {checked.length
            ? `已摸底 ${checked.length} / ${atlas.count} 词`
            : "先找出真正需要学的词。"}
        </h3>
        <p className="muted">
          不认识 {unknown.length} · 认识 {checked.length - unknown.length} ·
          未摸底 {atlas.count - checked.length}
        </p>
        {checked.length > 0 && (
          <p className="muted small">
            不会词中，{stable}{" "}
            个已完成跨日认知、听写和默写巩固。摸底标记与练习记录分别保留。
          </p>
        )}
      </div>
      <button
        className="btn btn-primary"
        onClick={() => go({ page: "assessment" })}
      >
        {checked.length ? "继续逐词摸底" : "开始逐词摸底"}
      </button>
    </section>
  );
}

export function WordAssessmentButtons({ id }: { id: string }) {
  const atlas = useAtlas();
  const mark = useStore((s) => assessmentMarks(s.progress)[id]);
  const rate = (state: "known" | "unknown") =>
    store.progress((p) =>
      p.datasetId === atlas.id && atlas.byId.has(id)
        ? assessWord(p, id, state)
        : p,
    );
  return (
    <section className="word-assessment-buttons" aria-label="本词摸底标记">
      <p className="muted small">
        按看释义前的回忆标记；需要看答案才想起，请选不认识。
      </p>
      <div>
        <button
          className={`btn ${mark?.state === "known" ? "btn-primary" : "btn-ghost"}`}
          aria-pressed={mark?.state === "known"}
          onClick={() => rate("known")}
        >
          认识
        </button>
        <button
          className={`btn ${mark?.state === "unknown" ? "btn-primary" : "btn-ghost"}`}
          aria-pressed={mark?.state === "unknown"}
          onClick={() => rate("unknown")}
        >
          不认识／不确定
        </button>
      </div>
    </section>
  );
}
