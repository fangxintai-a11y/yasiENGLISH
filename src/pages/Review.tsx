import { RetestPanel } from "../study365/ui/review/RetestPanel";
import { loadPromptBank } from "../study365/promptBank";
import { withPromptOrigins } from "../study365/promptOrigins";
import type { RetestPrompt } from "../study365/retestSelection";
import { useEffect, useState } from "react";
import type { Route } from "../lib/router";
import { useActivePlan } from "../study365/useActivePlan";
import { loadLocalBank } from "../study365/localBank";
import type { LocalMaterial } from "../study365/localBankSchema";
import { CorrectionPanel } from "../study365/ui/review/CorrectionPanel";
export function Review({
  route,
}: {
  route: Extract<Route, { page: "review" }>;
}) {
  const { learning, plan, dayPlan, error } = useActivePlan();
  const [prompts, setPrompts] = useState<RetestPrompt[]>([]);
  const [bank, setBank] = useState<LocalMaterial[]>([]),
    [bankError, setBankError] = useState("");
  useEffect(() => {
    let live = true;
    setBank([]);
    setPrompts([]);
    void loadPromptBank(learning.userId)
      .then(withPromptOrigins)
      .then(
        (value) => {
          if (live) setPrompts(value);
        },
        (e) => {
          if (live) setBankError(String(e));
        },
      );
    setBankError("");
    void loadLocalBank(learning.userId).then(
      (value) => {
        if (live) setBank(value);
      },
      (e) => {
        if (live) setBankError(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [learning.userId]);
  useEffect(() => {
    if (route.correctionId)
      document
        .getElementById(`review-${route.correctionId}`)
        ?.scrollIntoView({ block: "start" });
  }, [route.correctionId, learning.records]);
  if (!learning.ready)
    return (
      <div className="page">
        <p role="status">正在读取订正与校准…</p>
      </div>
    );
  if (!plan || !dayPlan)
    return (
      <div className="page">
        <h1>订正与校准</h1>
        <p>请先开启365天学习计划。</p>
        <a href="#/">前往今日</a>
      </div>
    );
  return (
    <div
      className="page r4-page"
      key={`${learning.userId ?? "guest"}:${plan.id}`}
    >
      <header className="page-header">
        <p className="eyebrow">365天训练 · {dayPlan.date}</p>
        <h1>订正与校准</h1>
      </header>
      <nav className="data-actions" aria-label="订正与校准栏目">
        <a className="btn btn-ghost" href="#/review">
          订正与复测
        </a>
      </nav>
      {error && <p role="alert">{error}</p>}
      {bankError && <p role="alert">{bankError}</p>}
      {(route.tab === undefined || route.tab === "corrections") && (
        <CorrectionPanel
          plan={plan}
          dayPlan={dayPlan}
          records={learning.records}
          bank={bank}
          userId={learning.userId}
        />
      )}
      {(route.tab === undefined || route.tab === "corrections") && (
        <RetestPanel
          plan={plan}
          dayPlan={dayPlan}
          records={learning.records}
          bank={bank}
          prompts={prompts}
          userId={learning.userId}
        />
      )}
    </div>
  );
}
