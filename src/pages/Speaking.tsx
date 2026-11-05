import type { Route } from "../lib/router";
import { resolveSpeakingContext } from "../study365/speakingTasks";
import { usePracticePlan } from "../study365/usePracticePlan";
import { SpeakingSession } from "../study365/ui/speaking/SpeakingSession";
export function Speaking({
  route,
}: {
  route: Extract<Route, { page: "speaking" }>;
}) {
  const { learning, plan, error, creating } = usePracticePlan();
  if (!learning.ready || creating)
    return (
      <div className="page">
        <p>正在读取口语任务…</p>
      </div>
    );
  if (!plan)
    return (
      <div className="page">
        <section className="panel" aria-label="口语练习">
          <h1>口语练习</h1>
          <p>请先开启365天计划。</p>
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
    const context = resolveSpeakingContext(plan, learning.records, route);
    return (
      <SpeakingSession
        key={`${learning.userId ?? "guest"}:${plan.id}:${context.date}:${context.taskId}:${route.work ?? "new"}`}
        plan={plan}
        context={context}
        learning={learning}
        initialWorkId={route.work}
      />
    );
  } catch (error) {
    return (
      <div className="page">
        <h1>口语练习</h1>
        <p role="alert">
          {error instanceof Error ? error.message : "任务暂不可用。"}
        </p>
        <a href="#/">返回今日</a>
      </div>
    );
  }
}
