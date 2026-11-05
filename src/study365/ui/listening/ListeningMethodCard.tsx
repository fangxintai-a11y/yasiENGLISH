import type { LocalMaterial } from "../../localBankSchema";
import {
  LISTENING_TARGET_NOTE,
  listeningStageLabel,
  methodCardFor,
} from "../../listeningLadder";

/** Shown before the first timed answer; collapses once the attempt starts so it never covers the questions. */
export function ListeningMethodCard({
  material,
  day,
  collapsed,
}: {
  material: LocalMaterial | null;
  day: number;
  collapsed: boolean;
}) {
  const card = methodCardFor(material, day);
  const body = (
    <>
      <p className="lmc-scene">{card.scene}</p>
      <p className="lmc-target">{LISTENING_TARGET_NOTE}</p>
      <dl className="lmc-grid">
        <div>
          <dt>本节常考</dt>
          <dd>
            <ul>{card.focus.map((line) => <li key={line}>{line}</li>)}</ul>
          </dd>
        </div>
        <div>
          <dt>开播前 30 秒</dt>
          <dd>
            <ul>{card.before.map((line) => <li key={line}>{line}</li>)}</ul>
          </dd>
        </div>
        <div>
          <dt>常见丢分</dt>
          <dd>
            <ul>{card.traps.map((line) => <li key={line}>{line}</li>)}</ul>
          </dd>
        </div>
        <div>
          <dt>做完怎么复盘</dt>
          <dd>
            <ol>{card.review.map((line) => <li key={line}>{line}</li>)}</ol>
          </dd>
        </div>
      </dl>
    </>
  );
  return (
    <section
      className="lmc"
      aria-label="听力拿分方法"
      data-testid="listening-method-card"
      data-section={card.section}
    >
      <p className="eyebrow">{day >= 1 ? listeningStageLabel(day) : "听力方法"}</p>
      {collapsed ? (
        <details>
          <summary>{card.title}（作答中，点开回看要点）</summary>
          {body}
        </details>
      ) : (
        <>
          <h3>{card.title}</h3>
          {body}
          <p className="lmc-next">读完再点“开始限时首答”。</p>
        </>
      )}
    </section>
  );
}
