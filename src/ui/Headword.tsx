import { useEffect, useRef, useState } from "react";
import type { Entry, WordRef } from "../atlas/types";
import { useAtlas } from "../atlas/context";
import { parseSyllables, syllableTimes, useSyllables } from "../ielts/syllables";
import { play } from "../lib/audio";
import { useStore } from "../store/store";

const SLOW = 0.7;
const HINT_KEY = "band-galaxy:syl-taps";

function taps() {
  try {
    return Number(localStorage.getItem(HINT_KEY)) || 0;
  } catch {
    return 0;
  }
}

/**
 * The big headword. Tapping it splits the word into its spoken syllables, marks the stressed
 * one and reads it slowly, lighting each syllable as it is spoken.
 */
export function Headword({ entry, refw }: { entry: Entry; refw: WordRef | Entry }) {
  const atlas = useAtlas();
  const accent = useStore((s) => s.settings.accent);
  const syl = useSyllables(entry.id);
  const [split, setSplit] = useState(false);
  const [on, setOn] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [hint] = useState(() => taps() < 3);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setSplit(false);
    setOn(-1);
    return () => {
      alive.current = false;
    };
  }, [entry.id]);

  const pieces = syl ? parseSyllables(syl) : null;
  const times = pieces ? syllableTimes(pieces) : [];
  const url = atlas.audio(refw, accent) ?? atlas.audio(refw, accent === "uk" ? "us" : "uk");

  const tap = async (e: React.MouseEvent) => {
    // Tapping the word is not a guess: it must not reveal the meaning on a first meeting.
    e.stopPropagation();
    setSplit(true);
    setPlaying(true);
    try {
      localStorage.setItem(HINT_KEY, String(taps() + 1));
    } catch {
      /* private mode: the hint just keeps showing */
    }
    try {
      await play(url, entry.w, accent, SLOW, (f) => {
        if (!alive.current) return;
        const i = times.findIndex(([a, b]) => f >= a && f < b);
        setOn((prev) => (pieces && i >= 0 && pieces[i].gap ? prev : i));
      });
    } finally {
      if (alive.current) {
        setOn(-1);
        setPlaying(false);
      }
    }
  };

  return (
    <div className="headword-wrap">
      <h2 className="headword" lang="en">
        <button
          type="button"
          className={`hw-btn ${split && pieces ? "is-split" : ""} ${playing ? "is-playing" : ""}`}
          onClick={tap}
          aria-label={pieces ? `${entry.w}：拆成音节并慢速朗读` : `${entry.w}：慢速朗读`}
        >
          {split && pieces
            ? pieces.map((p, i) =>
                p.gap ? (
                  <span key={i} className="syl-gap">
                    {p.text}
                  </span>
                ) : (
                  <span key={i} className="syl-wrap">
                    {i > 0 && !pieces[i - 1].gap && <span className="syl-dot" aria-hidden>·</span>}
                    <span className={`syl ${p.stress ? "is-stress" : ""} ${on === i ? "is-on" : ""}`}>{p.text}</span>
                  </span>
                ),
              )
            : entry.w}
        </button>
      </h2>
      {hint && !split && <p className="hw-hint">{pieces ? "点单词：拆音节 · 慢速读" : "点单词：慢速读"}</p>}
      {split && pieces && <p className="hw-hint">{pieces.filter((p) => !p.gap).length} 个音节 · 带下划线的是重音 · 再点重听</p>}
    </div>
  );
}
