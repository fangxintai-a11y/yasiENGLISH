import { CloudDownload, X } from "lucide-react";
import { useState } from "react";
import { defaultSelection, dismissNudge, nudgeDismissed, usePack } from "../lib/offline";
import { formatBytes, selectionSize } from "../lib/offlinePack";
import { go } from "../lib/router";
import { useStore } from "../store/store";

/** Small card on Today until an offline pack has completed (or the learner waves it away). */
export function OfflineNudge() {
  const pack = usePack();
  const accent = useStore((s) => s.settings.accent);
  const [hidden, setHidden] = useState(nudgeDismissed);
  if (hidden || pack.done || !pack.manifest || !("caches" in window)) return null;
  const size = selectionSize(pack.manifest, pack.selection ?? defaultSelection(accent)).bytes;
  return (
    <section className="pack-nudge">
      <CloudDownload size={24} strokeWidth={1.6} />
      <p>
        <b>下载离线包（约 {formatBytes(size)}）</b>，地铁上也能背
      </p>
      <button className="btn btn-primary" onClick={() => go({ page: "me" })}>
        去下载
      </button>
      <button
        className="icon-btn"
        aria-label="不再提示"
        onClick={() => {
          dismissNudge();
          setHidden(true);
        }}
      >
        <X size={18} />
      </button>
    </section>
  );
}
