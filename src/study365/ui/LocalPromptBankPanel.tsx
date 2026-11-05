import { useEffect, useRef, useState } from "react";
import {
  importPromptBankFile,
  importPromptManifest,
  loadPromptBank,
  promptBankIssues,
} from "../promptBank";
import type { LocalPrompt } from "../promptBankSchema";
import { useLearning } from "../repository";
export function LocalPromptBankPanel() {
  const learning = useLearning();
  return learning.ready ? (
    <Body key={learning.userId ?? "guest"} userId={learning.userId} />
  ) : null;
}
function Body({ userId }: { userId: string | null }) {
  const [prompts, setPrompts] = useState<LocalPrompt[]>([]),
    [issues, setIssues] = useState<readonly string[]>([]),
    [message, setMessage] = useState("正在读取本机写说题库…"),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    inFlight = useRef(false);
  const refresh = async () => {
    const values = await loadPromptBank(userId);
    if (alive.current) {
      setPrompts(values);
      setIssues(promptBankIssues(userId));
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh().then(() => {
      if (alive.current) setMessage("");
    });
    return () => {
      alive.current = false;
    };
  }, [userId]);
  const restore = async (file?: File) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = file
        ? await importPromptBankFile(userId, file)
        : await importPromptManifest(userId);
      await refresh();
      if (alive.current)
        setMessage(
          `已导入${result.imported}份写说题目，重复${result.duplicate}份，跳过${result.skipped}份。`,
        );
    } catch (error) {
      if (alive.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "写说题库未导入，原题目保留。",
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section
      className="panel settings"
      aria-label="本机写说题库"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>本机写说题库</h2>
      <p>
        {userId ? "当前账号" : "访客"}在这台浏览器可读
        {prompts.filter((prompt) => prompt.skill === "writing").length}
        份写作题、
        {prompts.filter((prompt) => prompt.skill === "speaking").length}
        份口语题。
      </p>
      <p>
        题目和已有原题图只存本机，订正与复测进度随账号同步。同账号换设备后仍需分别导入题库。没有同型新题或缺原题图时显示缺口，不用旧题或生成题代替。
      </p>
      <label
        className="btn btn-ghost"
        style={{ display: "block", width: "100%", minWidth: 0 }}
      >
        导入写说题目JSON
        <input
          aria-label="选择写说题库JSON"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          style={{ display: "block", width: "100%", minWidth: 0 }}
          onChange={(event) => {
            const input = event.currentTarget,
              file = input.files?.[0];
            if (file)
              void restore(file).finally(() => {
                input.value = "";
              });
          }}
        />
      </label>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={() => void restore()}
      >
        读取本机已转换目录
      </button>
      {message && <p role="status">{message}</p>}
      {!!prompts.filter((prompt) => prompt.ready === false).length && (
        <p>
          尚未就绪{prompts.filter((prompt) => prompt.ready === false).length}
          份（原题图、数据或明确题型仍待补齐）。
        </p>
      )}
      {!!issues.length && (
        <details>
          <summary>写说导入记录（{issues.length}项）</summary>
          <ul>
            {issues.slice(0, 30).map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
