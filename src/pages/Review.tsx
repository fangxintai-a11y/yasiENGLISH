import {
  deriveListeningSequences,
  type ListeningSequence,
} from "../study365/listeningSequence";
import { BankCoveragePanel } from "../study365/ui/review/BankCoveragePanel";
import { AnswerReviewQueue } from "../study365/ui/review/AnswerReviewQueue";
import {
  projectReviewedAttempts,
  reviewedOfficialTypeCalibration,
} from "../study365/answerReviewModel";
import { WeeklyReview } from "../study365/ui/review/WeeklyReview";
import { RetestPanel } from "../study365/ui/review/RetestPanel";
import { loadPromptBank } from "../study365/promptBank";
import { withPromptOrigins } from "../study365/promptOrigins";
import type { RetestPrompt } from "../study365/retestSelection";
import { useEffect, useMemo, useState } from "react";
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
  const [sequenceOrigins, setSequenceOrigins] = useState<ListeningSequence[]>(
    [],
  );
  const [bankLoaded, setBankLoaded] = useState(false);
  const [bank, setBank] = useState<LocalMaterial[]>([]),
    [bankError, setBankError] = useState("");
  useEffect(() => {
    let live = true;
    setBank([]);
    setBankLoaded(false);
    setSequenceOrigins([]);
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
    void loadLocalBank(learning.userId)
      .then(async (originals) => {
        const origins = await deriveListeningSequences(originals);
        return {
          origins,
          materials: [
            ...origins.map((sequence) => sequence.material),
            ...originals,
          ],
        };
      })
      .then(
        (value) => {
          if (live) {
            setBank(value.materials);
            setBankLoaded(true);
            setSequenceOrigins(value.origins);
          }
        },
        (e) => {
          if (live) {
            setBankError(String(e));
            setBankLoaded(true);
          }
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
  const projection = useMemo(
    () => projectReviewedAttempts(learning.records, bank, plan?.id ?? ""),
    [learning.records, bank, plan?.id],
  );
  const officialCalibration = useMemo(
    () =>
      reviewedOfficialTypeCalibration(learning.records, bank, plan?.id ?? ""),
    [learning.records, bank, plan?.id],
  );
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
        <a className="btn btn-ghost" href="#/review?tab=weekly">
          本周校准
        </a>
        <a className="btn btn-ghost" href="#/review?tab=answers">
          答案审校
        </a>
        <a className="btn btn-ghost" href="#/review?tab=coverage">
          题库完整性
        </a>
      </nav>
      {route.tab === "weekly" && !bankLoaded && (
        <p role="status">正在读取本机材料，随后显示本周汇总…</p>
      )}
      {route.tab === "weekly" && bankLoaded && (
        <WeeklyReview
          plan={plan}
          records={learning.records}
          bank={bank}
          date={dayPlan.date}
          userId={learning.userId}
          statisticsRecords={projection.records}
          officialCalibration={officialCalibration}
        />
      )}
      {route.tab === "answers" && (
        <AnswerReviewQueue
          planId={plan.id}
          records={learning.records}
          bank={bank}
          userId={learning.userId}
          date={dayPlan.date}
          day={dayPlan.day}
        />
      )}
      {route.tab === "coverage" && (
        <BankCoveragePanel
          planId={plan.id}
          records={learning.records}
          bank={bank}
          sequenceOrigins={sequenceOrigins}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {bankError && <p role="alert">{bankError}</p>}
      {(route.tab === undefined || route.tab === "corrections") && (
        <CorrectionPanel
          issueRecords={projection.correctionRecords}
          plan={plan}
          dayPlan={dayPlan}
          records={learning.records}
          bank={bank}
          userId={learning.userId}
        />
      )}
      {(route.tab === undefined || route.tab === "corrections") && (
        <RetestPanel
          questionResultsFor={(work) => {
            const rows = projection.attempts.find(
              (item) => item.work.revisionId === work.revisionId,
            )?.questions;
            return rows
              ? Object.fromEntries(
                  rows.map((q) => [
                    q.questionId,
                    { correct: q.correct, excluded: q.excluded },
                  ]),
                )
              : undefined;
          }}
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
