import { useEffect, useState } from "react";
import { useAtlas, useEntry } from "../atlas/context";
import { assessmentMarks, assessWord } from "../ielts/vocabulary";
import { go } from "../lib/router";
import { stopAudio } from "../lib/audio";
import { useCloudSync } from "../store/cloudSync";
import { store, useStore, type WordAssessment } from "../store/store";
import { NewWordCountForm } from "../ui/NewWordCount";
import { Speak } from "../ui/Speak";
import { VocabularyOverview } from "../ui/VocabularyOverview";

export function Assessment() {
  const atlas = useAtlas(),
    cloud = useCloudSync();
  return <AssessmentPage key={`${atlas.id}:${cloud.user?.id ?? "local"}`} />;
}

function AssessmentPage() {
  const atlas = useAtlas();
  const marks = useStore((s) => assessmentMarks(s.progress));
  const [filter, setFilter] = useState<"unseen" | "known" | "unknown">(
    "unseen",
  );
  const [round, setRound] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => () => stopAudio(), []);
  const pool = atlas.words.filter((word) =>
    filter === "unseen"
      ? !Object.hasOwn(marks, word.id)
      : marks[word.id]?.state === filter,
  );
  if (round.length && index < round.length)
    return (
      <div className="page assessment">
        <header className="assessment-round-top">
          <button className="btn btn-ghost" onClick={() => setRound([])}>
            暂停摸底
          </button>
          <span>
            {index + 1} / {round.length}
          </span>
        </header>
        <AssessmentWord
          key={round[index]}
          id={round[index]}
          onNext={() => {
            stopAudio();
            setIndex((i) => i + 1);
          }}
        />
        {index > 0 && (
          <button
            className="link assessment-back"
            onClick={() => {
              stopAudio();
              setIndex((i) => i - 1);
            }}
          >
            返回上一词，检查标记
          </button>
        )}
      </div>
    );
  return (
    <div className="page assessment">
      <header className="page-head">
        <p className="eyebrow">词汇基线 · 全词库逐词摸底</p>
        <h1 className="display">先把不会的，找出来。</h1>
        <p className="lede">
          先只看英文，能独立想起主要意思才选认识。图片、中文和例句在标记后展示；不会或不确定都进入重点学习。
        </p>
      </header>
      <VocabularyOverview />
      {round.length > 0 && (
        <p className="assessment-finished" role="status">
          本批 {round.length} 词已保存。可以继续下一批，或现在去学不会的词。
        </p>
      )}
      <section className="panel assessment-setup">
        <div className="chips" role="group" aria-label="摸底范围">
          {(
            [
              ["unseen", "未摸底"],
              ["unknown", "复查不认识"],
              ["known", "复查认识"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={`chip-btn ${filter === value ? "is-on" : ""}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="muted">
          本范围还有 {pool.length}{" "}
          词。每个标记立即保存并随账号同步，刷新或换设备后可接着测，不必一次测完整个词库。
        </p>
        {pool.length ? (
          <NewWordCountForm
            key={filter}
            initialValue={Math.min(50, pool.length)}
            available={pool.length}
            activity="摸底"
            noun="词"
            label="本批摸底数量"
            submitLabel="开始本批摸底"
            onSubmit={(count) => {
              setRound(pool.slice(0, count).map((word) => word.id));
              setIndex(0);
            }}
          />
        ) : (
          <p role="status">这个范围已完成，可换个范围复查。</p>
        )}
        <div className="assessment-links">
          <button
            className="btn btn-ghost"
            onClick={() => go({ page: "today" })}
          >
            去学习不会的词
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => go({ page: "atlas" })}
          >
            查看完整图鉴
          </button>
        </div>
        <p className="muted small">
          标“认识”只表示这次能回忆词义，不会生成虚假的已掌握卡。后续有少量抽查；标“不会”的词，先学习，再重点练拼写并按记忆间隔复习。
        </p>
      </section>
    </div>
  );
}

function AssessmentWord({ id, onNext }: { id: string; onNext: () => void }) {
  const atlas = useAtlas(),
    ref = atlas.byId.get(id)!;
  const { entry, error } = useEntry(id);
  const accent = useStore((s) => s.settings.accent);
  const saved = useStore((s) => assessmentMarks(s.progress)[id]);
  const [choice, setChoice] = useState<WordAssessment["state"] | null>(null);
  const rate = (state: WordAssessment["state"]) => {
    store.progress((p) =>
      p.datasetId === atlas.id ? assessWord(p, id, state) : p,
    );
    setChoice(state);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName)
      )
        return;
      if (event.key === "1" || event.key === "2") {
        event.preventDefault();
        rate(event.key === "1" ? "known" : "unknown");
      }
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (choice) onNext();
        else rate("unknown");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <section className="panel assessment-question" aria-label="当前摸底词">
      <p className="eyebrow">先想意思 · 不靠图片和中文提示</p>
      <h2 className="headword" lang="en">
        {ref.word}
      </h2>
      {!choice ? (
        <>
          <p className="muted">能一眼想起主要意思吗？不确定也选不认识。</p>
          {saved && (
            <p className="muted small">
              原标记：{saved.state === "known" ? "认识" : "不认识"}
              ；本次可以重新判断。
            </p>
          )}
          <div className="assessment-actions">
            <button className="btn btn-primary" onClick={() => rate("known")}>
              认识 <kbd>1</kbd>
            </button>
            <button className="btn btn-ghost" onClick={() => rate("unknown")}>
              不认识／不确定 <kbd>2</kbd>
            </button>
          </div>
          <button className="link" onClick={() => rate("unknown")}>
            想不起来，查看释义 <kbd>Space</kbd>
          </button>
        </>
      ) : (
        <>
          <p className="assessment-saved" role="status">
            已标记{choice === "known" ? "认识" : "不认识，进入重点学习"}
          </p>
          <section className="assessment-answer" aria-label="摸底答案">
            {entry ? (
              <>
                <Speak
                  url={atlas.audio(entry, accent)}
                  text={entry.w}
                  accent={accent}
                  label="听发音"
                />
                <ul>
                  {entry.senses.map((sense, i) => (
                    <li key={i}>
                      {sense.pos} {sense.zh}
                    </li>
                  ))}
                </ul>
                {entry.ex[0] ? (
                  <p>
                    <span lang="en">{entry.ex[0].en}</span>
                    <br />
                    <span className="muted">{entry.ex[0].zh}</span>
                  </p>
                ) : (
                  <p className="muted small">
                    本词暂无可用例句，先用释义学习。
                  </p>
                )}
              </>
            ) : error ? (
              <p role="alert">词条加载失败，可刷新重试；标记已保存。</p>
            ) : (
              <p>正在加载释义…</p>
            )}
          </section>
          <div className="assessment-actions">
            <button className="btn btn-primary" onClick={onNext}>
              下一个 <kbd>Space</kbd>
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => rate(choice === "known" ? "unknown" : "known")}
            >
              改成{choice === "known" ? "不认识" : "认识"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
