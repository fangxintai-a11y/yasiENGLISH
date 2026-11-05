import { useEffect, useRef, useState } from "react";
import {
  importLocalBankFile,
  importPrivateBankManifest,
  importPrivatePromptManifest,
  loadLocalBank,
  localBankIssues,
} from "../localBank";
import type { LocalMaterial } from "../localBankSchema";
import { useLearning } from "../repository";

export function LocalBankPanel() {
  const learning = useLearning();
  return learning.ready ? (
    <BankBody key={learning.userId ?? "guest"} userId={learning.userId} />
  ) : null;
}
function BankBody({ userId }: { userId: string | null }) {
  const [materials, setMaterials] = useState<LocalMaterial[]>([]),
    [issues, setIssues] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("正在读取本机题库…");
  const alive = useRef(true),
    inFlight = useRef(false);
  const reload = async () => {
    const items = await loadLocalBank(userId);
    if (alive.current) {
      setMaterials(items);
      setIssues(localBankIssues(userId));
    }
  };
  useEffect(() => {
    alive.current = true;
    void reload()
      .then(() => {
        if (alive.current) setMessage("");
      })
      .catch(() => {
        if (alive.current) setMessage("题库暂不可用，原有学习记录没有被清除。");
      });
    return () => {
      alive.current = false;
    };
  }, [userId]);
  const restore = async (file: File) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("正在校验题库…");
    try {
      const result = await importLocalBankFile(userId, file);
      if (!alive.current) return;
      await reload();
      if (alive.current)
        setMessage(
          `已导入${result.imported}份，跳过${result.duplicate}份相同材料和${result.skipped}份待修复材料。`,
        );
    } catch (error) {
      if (alive.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "题库未导入，原有材料仍保留。",
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const preparePrivate = async (prompts = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("正在读取登录后的私有题库目录…");
    try {
      const result = prompts
        ? await importPrivatePromptManifest(userId)
        : await importPrivateBankManifest(userId);
      if (!alive.current) return;
      await reload();
      if (alive.current) setIssues(result.issues);
      if (alive.current)
        setMessage(
          `已准备${result.imported}份${prompts ? "写说题目" : "听读原件"}；跳过${result.duplicate}份相同内容、${result.skipped}项待修复。${prompts ? "" : "选听一节时才下载并校验该节音频，缓存后可离线回听。"}`,
        );
    } catch (error) {
      if (alive.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "私有题库尚未准备好，原有题库保留。",
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const fallback = materials.filter((item) =>
    item.source.sourceRef.startsWith("builtin:"),
  ).length;
  return (
    <section
      className="panel settings"
      aria-label="本机题库"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>本机听读题库</h2>
      <p>
        {userId ? "当前账号" : "访客"}在这台浏览器可读取{materials.length}份材料
        {fallback ? `，其中${fallback}份为内置离线兜底` : ""}。
      </p>
      <p className="muted">
        服务器私有题库需登录后准备，每台设备分别缓存；作答记录随账号同步。JSON本身不含音频，可选定后联网准备这一份；带音频的小ZIP导入后即可离线使用。清除浏览器数据会丢失本机题库，请保留原始题库包。
      </p>
      <p>
        <a className="btn btn-ghost" href="#/review?tab=coverage">
          题库完整性与缺口
        </a>
      </p>
      {userId && (
        <div className="data-actions">
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void preparePrivate()}
          >
            准备服务器私有听读题库
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void preparePrivate(true)}
          >
            准备服务器私有写说题库
          </button>
        </div>
      )}
      <label
        className="btn btn-ghost"
        style={{ display: "block", maxWidth: "100%", minWidth: 0 }}
      >
        导入题库JSON或小ZIP
        <input
          aria-label="选择题库文件"
          type="file"
          accept=".json,.zip,application/json,application/zip"
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
      {message && <p role="status">{message}</p>}
      {!!issues.length && (
        <details>
          <summary>导入与读取记录（{issues.length}项）</summary>
          <ul>
            {issues.slice(0, 30).map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted">
        电脑也可运行本机导入命令生成题库目录；来源与答案待核状态会保留，不把导入成功当作人工审校完成。
      </p>
    </section>
  );
}
