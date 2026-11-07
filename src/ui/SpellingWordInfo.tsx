import type { Entry } from "../atlas/types";
import { Highlight } from "./EntryView";

/** Only render after an answer has been submitted; never part of the recall prompt. */
export function SpellingWordInfo({ entry }: { entry: Entry }) {
  return (
    <div className="spelling-word-info" aria-label="单词信息">
      {(entry.uk || entry.us) && (
        <p className="spelling-phonetics">
          {entry.uk && <span>英 <span className="ipa" lang="en">{entry.uk}</span></span>}
          {entry.us && <span>美 <span className="ipa" lang="en">{entry.us}</span></span>}
        </p>
      )}
      <ul className="spelling-senses">
        {entry.senses.map((sense, index) => (
          <li key={index}>
            <span className="pos">{sense.pos}</span> {sense.zh}
          </li>
        ))}
      </ul>
      {entry.ex[0] ? (
        <blockquote className="spelling-example">
          <p lang="en"><Highlight text={entry.ex[0].en} word={entry.w} /></p>
          {entry.ex[0].zh && <p className="muted">{entry.ex[0].zh}</p>}
        </blockquote>
      ) : <p className="muted small">这个词暂无例句。</p>}
      {entry.note && <p className="muted small">{entry.note}</p>}
    </div>
  );
}
