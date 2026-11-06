import type { Route } from "../lib/router";
import { usePracticePlan } from "../study365/usePracticePlan";
import { resolvePracticeContext } from "../study365/listeningReadingTasks";
import { ReadingSession } from "../study365/ui/reading/ReadingSession";
import { clearListeningPending } from "../study365/ui/listening/ListeningPlayer";
import { clearListeningSequencePending } from "../study365/ui/listening/ListeningSequencePlayer";
import { isListeningSequenceMaterial } from "../study365/listeningSequence";
import { SequenceAwareListeningPlayer } from "../study365/ui/listening/SequenceAwareListeningPlayer";
import "../styles/reading.css";

export function Listening({
  route,
}: {
  route: Extract<Route, { page: "listening" }>;
}) {
  const { learning, plan, error, creating } = usePracticePlan();
  if (!learning.ready)
    return (
      <div className="page">
        <p>正在读取听力任务…</p>
      </div>
    );
  if (!plan)
    return (
      <div className="page">
        <section className="panel">
          <h1>听力练习</h1>
          <p>{creating ? "正在准备随时可学的听力练习…" : error ?? "正在准备学习记录…"}</p>
          <a href="#/">前往今日</a>
        </section>
      </div>
    );
  if (error)
    return (
      <div className="page">
        <p role="alert">{error}</p>
      </div>
    );
  try {
    const context = resolvePracticeContext(
      plan,
      learning.records,
      route,
      "listening",
    );
    return (
      <ReadingSession
        key={`${learning.userId ?? "guest"}:${plan.id}:${context.mode}:${context.date}:${context.taskId}:${route.work ?? "new"}:${route.material ?? ""}`}
        plan={plan}
        context={context}
        userId={learning.userId}
        skill="listening"
        initialWorkId={route.work}
        initialMaterialId={route.material}
        workflow={{
          correctionId: route.correctionId,
          retestOf: route.retestOf,
        }}
        onAttemptSaved={(material) =>
          isListeningSequenceMaterial(material)
            ? clearListeningSequencePending(learning.userId, material)
            : clearListeningPending(learning.userId, material)
        }
        playback={(
          material,
          review,
          onConditions,
          onReady,
          evidenceVisible,
        ) => (
          <SequenceAwareListeningPlayer
            userId={learning.userId}
            material={material}
            review={review}
            onConditions={onConditions}
            onReady={onReady}
            evidenceVisible={evidenceVisible}
          />
        )}
      />
    );
  } catch (error) {
    return (
      <div className="page">
        <h1>听力练习</h1>
        <p role="alert">
          {error instanceof Error ? error.message : "任务暂不可用。"}
        </p>
        <a href="#/">返回今日</a>
      </div>
    );
  }
}
