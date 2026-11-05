import { useEffect, useRef, useState } from "react";
import { loadLocalBank } from "../../localBank";
import {
  deriveListeningSequences,
  isListeningSequenceMaterial,
  type ListeningSequence,
} from "../../listeningSequence";
import { ListeningPlayer, type ListeningPlayerProps } from "./ListeningPlayer";
import { ListeningSequencePlayer } from "./ListeningSequencePlayer";

/** A virtual sequence is resolved from its exact original-part manifest, never a synthetic audio URL. */
export function SequenceAwareListeningPlayer(props: ListeningPlayerProps) {
  if (!isListeningSequenceMaterial(props.material))
    return <ListeningPlayer {...props} />;
  const key = JSON.stringify([
    props.userId,
    props.material.id,
    props.material.version,
    props.material.contentHash,
  ]);
  return <SequenceSourcePlayer key={key} {...props} />;
}
function SequenceSourcePlayer(props: ListeningPlayerProps) {
  const [sequence, setSequence] = useState<ListeningSequence | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const ready = useRef(props.onReady);
  ready.current = props.onReady;
  useEffect(() => {
    let active = true;
    setSequence(null);
    setError("");
    ready.current(false);
    void loadLocalBank(props.userId)
      .then(deriveListeningSequences)
      .then((sequences) => {
        if (!active) return;
        const exact = sequences.find(
          (value) =>
            value.material.id === props.material.id &&
            value.material.version === props.material.version &&
            value.material.contentHash === props.material.contentHash,
        );
        if (!exact)
          throw new Error(
            "本机缺少这版整套对应的四节原件，请重新导入同版题库后重试；原答案与播放进度保留。",
          );
        setSequence(exact);
      })
      .catch((cause) => {
        if (active) {
          ready.current(false);
          setError(
            cause instanceof Error
              ? cause.message
              : "四节原件暂时未能读取，请重新导入同版题库后重试。",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [
    props.userId,
    props.material.id,
    props.material.version,
    props.material.contentHash,
    retry,
  ]);
  if (sequence)
    return <ListeningSequencePlayer {...props} sequence={sequence} />;
  return (
    <section
      aria-label="四节听力原件"
      style={{ minWidth: 0, maxWidth: "100%" }}
    >
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试读取四节原件
          </button>
        </>
      ) : (
        <p role="status">正在读取这版整套对应的四节原件…</p>
      )}
    </section>
  );
}
