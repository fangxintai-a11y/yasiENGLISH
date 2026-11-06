import { ListPlus } from "lucide-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useAtlas } from "../atlas/context";
import { priorityWords } from "../ielts/priority";
import { stopAudio } from "../lib/audio";
import { go } from "../lib/router";
import { buildPrioritySession } from "../store/session";
import { store, useStore } from "../store/store";
import { NewWordCountForm } from "./NewWordCount";
import { Sheet } from "./Sheet";
import { toast } from "./Toast";

export function PriorityLearning({ ids }: { ids?: string[] }) {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const dailyNew = useStore((s) => s.settings.dailyNew);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const eligible = priorityWords(atlas, progress);
  const words = ids ? eligible.filter((id) => ids.includes(id)) : eligible;
  const fresh = words.filter((id) => !progress.cards[id]).length;
  if (!words.length) return null;
  const start = (count: number) => {
    const selected = words.slice(0, count);
    let ready = false;
    store.progress((p) => {
      if (p.datasetId !== atlas.id) return p;
      const session = buildPrioritySession(
        atlas,
        p,
        store.get().settings,
        selected,
      );
      if (!session?.steps.length) return p;
      ready = true;
      return { ...p, session };
    });
    if (!ready) {
      toast("请先完成或退出当前专项练习，再学习待学词。", "info");
      return;
    }
    stopAudio();
    close();
    go({ page: "learn" });
  };
  return (
    <>
      <section className="panel priority-learning" aria-label="优先待学">
        <ListPlus size={24} />
        <div className="priority-learning-body">
          <h3>优先待学 {words.length} 个词</h3>
          <p className="muted">
            新词 {fresh} 个 · 需要再学 {words.length - fresh} 个
          </p>
          <p className="priority-preview" lang="en">
            {words
              .slice(0, 8)
              .map((id) => atlas.byId.get(id)?.word)
              .join(" · ")}
            {words.length > 8 ? " …" : ""}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          学习待学词
        </button>
      </section>
      {open &&
        createPortal(
          <Sheet open onClose={close} label="学习待学词">
            <h2>先学遇到的这些词。</h2>
            <NewWordCountForm
              initialValue={Math.min(words.length, dailyNew || 20, 100)}
              label="本轮待学数量"
              submitLabel="开始学习待学词"
              available={words.length}
              onSubmit={start}
            />
            <p className="muted small">
              不改变每日目标；已有轮次会保留，这些词排在当前题之后。学过的词保留原记忆记录，实际学习时再更新排程。
            </p>
          </Sheet>,
          document.body,
        )}
    </>
  );
}
