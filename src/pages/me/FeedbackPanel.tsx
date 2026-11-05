import { useEffect, useRef, useState } from "react";
import { createProvider, getCredential, getFeedbackConfig, PROVIDER_PRESETS, removeProvider, saveFeedbackConfig, setCredential, TASK_LABELS, testProvider, type FeedbackConfig, type ProviderConfig, type TaskId } from "../../ielts/scoring";
import { store, useStore } from "../../store/store";

export function FeedbackPanel() {
  const mode = useStore((state) => state.settings.feedbackMode);
  const [config, setConfig] = useState<FeedbackConfig>(getFeedbackConfig);
  const [credentials, setCredentials] = useState<Record<string, string>>(() => Object.fromEntries(getFeedbackConfig().providers.map((provider) => [provider.id, getCredential(provider.id)])));
  const [message, setMessage] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const update = (id: string, patch: Partial<ProviderConfig>) => setConfig((current) => ({ ...current, providers: current.providers.map((provider) => provider.id === id ? { ...provider, ...patch } : provider) }));
  const save = () => {
    saveFeedbackConfig(config);
    for (const provider of config.providers) if (Object.hasOwn(credentials, provider.id)) setCredential(provider.id, credentials[provider.id]);
  };
  const move = (index: number, direction: number) => setConfig((current) => {
    const providers = [...current.providers], next = index + direction;
    if (next >= 0 && next < providers.length) [providers[index], providers[next]] = [providers[next], providers[index]];
    return { ...current, providers };
  });
  return <section className="panel settings" aria-label="评分与反馈">
    <h3 className="eyebrow">评分与反馈</h3>
    <div className="segmented" aria-label="评分方式">
      {([["rules", "本地评分"], ["manual", "复制提示词"], ["auto", "自动接口"]] as const).map(([value, label]) => <button key={value} className={mode === value ? "is-on" : ""} aria-pressed={mode === value} onClick={() => store.settings({ feedbackMode: value })}>{label}</button>)}
    </div>
    <p className="muted">接口设置和密钥只存这台设备，不进备份和同步。自动接口依照列表顺序尝试；返回结果会先校验。</p>
    {config.providers.map((provider, index) => <fieldset key={provider.id} disabled={testing !== null}>
      <legend>接口 {index + 1}</legend>
      <label>名称<input aria-label={`接口${index + 1}名称`} value={provider.label} maxLength={100} onChange={(event) => update(provider.id, { label: event.target.value })} /></label>
      <label>Base URL<input aria-label={`接口${index + 1}地址`} type="url" value={provider.baseURL} placeholder="https://your-endpoint.example/v1" onChange={(event) => update(provider.id, { baseURL: event.target.value })} /></label>
      <label>模型 ID<input aria-label={`接口${index + 1}模型`} value={provider.model} placeholder="由你填写的模型标识" maxLength={200} onChange={(event) => update(provider.id, { model: event.target.value })} /></label>
      <label>密钥<input aria-label={`接口${index + 1}密钥`} type="password" autoComplete="off" spellCheck={false} value={credentials[provider.id] ?? ""} onChange={(event) => setCredentials((current) => ({ ...current, [provider.id]: event.target.value }))} /></label>
      <label>结果格式<select aria-label={`接口${index + 1}结果格式`} value={provider.jsonMode} onChange={(event) => update(provider.id, { jsonMode: event.target.value as ProviderConfig["jsonMode"] })}>
        <option value="json_schema">JSON Schema</option><option value="json_object">JSON对象</option><option value="prompt-only">仅提示词</option>
      </select></label>
      <label>请求超时（毫秒）<input aria-label={`接口${index + 1}超时`} type="number" min={100} max={120000} value={provider.timeoutMs} onChange={(event) => update(provider.id, { timeoutMs: Number(event.target.value) })} /></label>
      <fieldset><legend>负责的任务</legend>{(Object.entries(TASK_LABELS) as [TaskId, string][]).map(([task, label]) => <label key={task}><input type="checkbox" checked={provider.tasks.includes(task)} onChange={(event) => update(provider.id, { tasks: event.target.checked ? [...provider.tasks, task] : provider.tasks.filter((item) => item !== task) })} />{label}</label>)}</fieldset>
      <div className="data-actions">
        <button className="btn btn-ghost" disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
        <button className="btn btn-ghost" disabled={index === config.providers.length - 1} onClick={() => move(index, 1)}>下移</button>
        <button className="btn btn-ghost" onClick={() => {
          try { removeProvider(provider.id); setConfig((current) => ({ ...current, providers: current.providers.filter((item) => item.id !== provider.id) })); setCredentials((current) => { const next = { ...current }; delete next[provider.id]; return next; }); setMessage("接口及其本机密钥已移除。"); }
          catch { setMessage("未能移除接口，请检查浏览器存储权限。"); }
        }}>删除接口</button>
        <button className="btn btn-ghost" onClick={() => {
          try { save(); } catch { setMessage("设置未保存，请检查地址、模型、任务和浏览器存储权限。"); return; }
          const cancellation = new AbortController(); controller.current = cancellation; setTesting(provider.id); setMessage("正在测试连接…");
          void testProvider(provider, { signal: cancellation.signal }).then((result) => setMessage(result.ok ? "连接测试通过。" : result.message)).finally(() => { setTesting(null); controller.current = null; });
        }}>测试连接</button>
      </div>
    </fieldset>)}
    <div className="data-actions">
      {PROVIDER_PRESETS.map((preset) => <button key={preset.id} className="btn btn-ghost" disabled={testing !== null || config.providers.length >= 20} onClick={() => { const provider = createProvider(preset.id); setConfig((current) => ({ ...current, providers: [...current.providers, provider] })); }}>添加{preset.label}</button>)}
      <button className="btn btn-primary" disabled={testing !== null} onClick={() => { try { save(); setMessage("评分接口已保存在本机。"); } catch { setMessage("设置未保存，请检查地址、模型、任务和浏览器存储权限。"); } }}>保存接口设置</button>
      {testing && <button className="btn btn-ghost" onClick={() => controller.current?.abort()}>取消测试</button>}
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
