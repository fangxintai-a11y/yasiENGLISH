import type { Route } from "../lib/router";
import { usePracticePlan } from "../study365/usePracticePlan";
import { resolvePracticeContext } from "../study365/listeningReadingTasks";
import { ReadingSession } from "../study365/ui/reading/ReadingSession";
import "../styles/reading.css";
export function Reading({
  route,
}: {
  route: Extract<Route, { page: "reading" }>;
}) {
  const { learning, plan, error, creating } = usePracticePlan();
  if (!learning.ready)
    return (
      <div className="page">
        <p>正在读取阅读任务…</p>
      </div>
    );
  if (!plan)
    return (
      <div className="page">
        <section className="panel">
          <h1>阅读练习</h1>
          <p>{creating ? "正在准备随时可学的阅读练习…" : error ?? "正在准备学习记录…"}</p>
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
      "reading",
    );
    return (
      <ReadingSession
        key={`${learning.userId ?? "guest"}:${plan.id}:${context.mode}:${context.date}:${context.taskId}:${route.work ?? "new"}:${route.material ?? ""}`}
        plan={plan}
        context={context}
        userId={learning.userId}
        initialWorkId={route.work}
        initialMaterialId={route.material}
        workflow={{ correctionId: route.correctionId, retestOf: route.retestOf }}
      />
    );
  } catch (e) {
    return (
      <div className="page">
        <h1>阅读练习</h1>
        <p role="alert">{e instanceof Error ? e.message : "任务暂不可用。"}</p>
        <a href="#/">返回今日</a>
      </div>
    );
  }
}
