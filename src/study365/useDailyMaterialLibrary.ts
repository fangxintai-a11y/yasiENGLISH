import { useEffect, useMemo, useState } from "react";
import { loadLocalBank, localBankIssues } from "./localBank";
import { withListeningSequences } from "./listeningSequence";
import type { LocalMaterial } from "./localBankSchema";
import { usePromptBank } from "./usePromptBank";
import { listWritingDrafts, writingScope } from "./writingDrafts";
import { writingPromptReferences, type PromptWorkReference } from "./promptWorkSelection";
import { localPracticeReferences } from "./practiceDraft";

/** Load the current account's existing materials; selection never changes learning records. */
export function useDailyMaterialLibrary(userId: string | null, planId: string) {
  const prompts = usePromptBank(userId);
  const [state, setState] = useState<{
    userId: string | null; planId: string; loaded: boolean; bank: LocalMaterial[];
    localWorks: PromptWorkReference[]; issues: readonly string[];
  }>({ userId, planId, loaded: false, bank: [], localWorks: [], issues: [] });
  useEffect(() => {
    let active = true;
    setState({ userId, planId, loaded: false, bank: [], localWorks: [], issues: [] });
    void Promise.allSettled([
      loadLocalBank(userId).then(withListeningSequences),
      listWritingDrafts(writingScope(userId)),
    ]).then(([bank, drafts]) => {
      if (!active) return;
      const issues = [...localBankIssues(userId)];
      if (bank.status === "rejected") issues.push("听读材料未能加载，已有作答保留。");
      if (drafts.status === "rejected") issues.push("本机写作草稿未能读取，请保留原页面并重试。");
      setState({ userId, planId, loaded: true,
        bank: bank.status === "fulfilled" ? bank.value : [],
        localWorks: drafts.status === "fulfilled" ? writingPromptReferences(drafts.value.filter(draft => draft.planId === planId)) : [],
        issues });
    });
    return () => { active = false; };
  }, [userId, planId]);
  const current = state.userId === userId && state.planId === planId ? state : { loaded: false, bank: [], localWorks: [], issues: [] };
  const localMaterials = useMemo(() => current.loaded ? localPracticeReferences(userId, planId, current.bank) : [],
    [current.loaded, current.bank, userId, planId]);
  return { bank: current.bank, prompts: prompts.prompts, localWorks: current.localWorks,
    localMaterials,
    ready: current.loaded && prompts.loaded, issues: [...current.issues, ...prompts.issues] };
}
