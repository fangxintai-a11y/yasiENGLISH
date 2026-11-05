import { useEffect, useState } from "react";
import { loadPromptBank, promptBankIssues } from "./promptBank";
import type { LocalPrompt } from "./promptBankSchema";
export function usePromptBank(userId: string | null) {
  const [state, setState] = useState<{
    userId: string | null;
    loaded: boolean;
    prompts: LocalPrompt[];
    issues: readonly string[];
  }>({ userId, loaded: false, prompts: [], issues: [] });
  useEffect(() => {
    let active = true;
    setState({ userId, loaded: false, prompts: [], issues: [] });
    void loadPromptBank(userId)
      .then((prompts) => {
        if (active)
          setState({
            userId,
            loaded: true,
            prompts,
            issues: promptBankIssues(userId),
          });
      })
      .catch(() => {
        if (active)
          setState({
            userId,
            loaded: true,
            prompts: [],
            issues: ["本机写说题库读取失败，请到“我的”重新导入。"],
          });
      });
    return () => {
      active = false;
    };
  }, [userId]);
  return state.userId === userId
    ? state
    : { userId, loaded: false, prompts: [], issues: [] };
}
