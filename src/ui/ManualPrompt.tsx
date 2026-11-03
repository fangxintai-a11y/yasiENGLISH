import { useEffect, useMemo, useRef, useState } from "react";
import { acceptManual, manualPrompt, type TaskId } from "../ielts/scoring";

export function ManualPrompt({ task, input, onAccept, onCancel }: { task: TaskId; input: unknown; onAccept: (value: unknown) => void; onCancel?: () => void }) {
  const [pasted, setPasted] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const current = useRef({ task, input }); current.current = { task, input };
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const prompt = useMemo(() => {
    try { return manualPrompt(task, input).text; }
    catch { return ""; }
  }, [task, input]);
  useEffect(() => { setPasted(""); setErrors([]); setMessage(""); }, [task, input]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setMessage("提示词已复制。完成后把JSON结果粘贴回来。"); }
    catch { promptRef.current?.select(); setMessage("请复制已选中的提示词。"); }
  };
  return <section className="panel" aria-label="复制提示词与粘贴结果">
    <h3>复制提示词</h3>
    <p className="muted">提示词包含本次作品与结果格式。复制到你选择的工具，取得JSON后粘贴并校验。</p>
    {!prompt && <p role="alert">暂时无法生成提示词，请检查当前输入。</p>}
    <textarea ref={promptRef} aria-label="评分提示词" value={prompt} readOnly rows={7} />
    <button className="btn btn-ghost" disabled={!prompt} onClick={() => { void copy(); }}>复制完整提示词</button>
    <label>粘贴JSON结果<textarea aria-label="粘贴评分结果" value={pasted} maxLength={1000000} rows={7} onChange={(event) => setPasted(event.target.value)} /></label>
    <div className="data-actions">
      <button className="btn btn-primary" disabled={busy || !pasted.trim() || !prompt} onClick={async () => {
        setBusy(true);
        try {
          const result = await acceptManual<unknown>(task, pasted, input);
          if (!active.current || current.current.input !== input || current.current.task !== task) return;
          if (result.ok) { setErrors([]); setMessage("结果校验通过。"); onAccept(result.value); }
          else { setErrors(result.errors); setMessage(""); }
        } catch { if (active.current) { setErrors(["当前输入暂时无法校验，请重新选择任务后重试。"]); setMessage(""); } }
        finally { if (active.current) setBusy(false); }
      }}>校验并使用</button>
      {onCancel && <button className="btn btn-ghost" onClick={onCancel}>收起</button>}
    </div>
    {!!errors.length && <ul role="alert">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
    {message && <p role="status">{message}</p>}
  </section>;
}
