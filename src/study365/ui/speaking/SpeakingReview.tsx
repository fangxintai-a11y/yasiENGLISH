import { useEffect, useRef, useState } from 'react';
import type { SpeakingResult } from '../../../ielts/scoring';
import type { Revision } from '../../protocol';
import { getLearningState, saveRecord, useLearning, type LearningState } from '../../repository';
import { assertCurrentSpeaking, buildSpeakingSelfReview, restoreSpeakingReview, runSpeakingRules, speakingFeedbackForWork, type SpeakingSelfReview } from '../../speakingReview';
import { SPEAKING_DIMENSION_LABELS, SPEAKING_RUBRIC_SOURCE, speakingCauseOptions, speakingRubric } from '../../speakingRubric';

interface Props { work: Revision; currentWork: () => Revision | null; materialSelfCheck?: string[]; onSaved?: () => void }
export function SpeakingReview(props: Props) {
  const learning = useLearning();
  return <ReviewBody key={`${learning.userId ?? 'guest'}:${props.work.revisionId}`} {...props} learning={learning} />;
}
function ReviewBody({ work, currentWork, materialSelfCheck = [], onSaved, learning }: Props & { learning: LearningState }) {
  const existing = speakingFeedbackForWork(learning.records, work).find(record => record.payload.source === 'self');
  const [state, setState] = useState(() => restoreSpeakingReview(existing));
  const [result, setResult] = useState<SpeakingResult | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const dirty = useRef(false), alive = useRef(true);
  const userId = learning.userId, transcript = String(work.payload.transcript ?? '');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!dirty.current) setState(restoreSpeakingReview(existing)); }, [existing?.revisionId]);
  useEffect(() => {
    let active = true;
    if (transcript.trim()) void runSpeakingRules(work).then(async value => {
      if (!active || getLearningState().userId !== userId) return;
      assertCurrentSpeaking(work, currentWork()); setResult(value.result);
      if (!speakingFeedbackForWork(getLearningState().records, work).some(record => record.payload.source === 'rules'))
        await saveRecord({ id: `rules-speaking:${work.revisionId}`, kind: 'feedback', payload: value.payload });
    }).catch(error => { if (active) setMessage(`文字体检未保存：${error instanceof Error ? error.message : '请重试。'}`); });
    return () => { active = false; };
  }, [work.revisionId, userId]);
  const update = (change: (value: SpeakingSelfReview) => SpeakingSelfReview) => { dirty.current = true; setState(change); setMessage('口语自查有未保存的修改。'); };
  const save = async () => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const payload = await buildSpeakingSelfReview(work, state);
      assertCurrentSpeaking(work, currentWork());
      if (getLearningState().userId !== userId) throw new Error('账号已经切换，请在原账号继续自查。');
      await saveRecord({ id: existing?.id ?? `self-speaking:${work.revisionId}`, kind: 'feedback', payload });
      if (alive.current) { dirty.current = false; setMessage('口语自查已保存在本机，联网后自动同步。'); onSaved?.(); }
    } catch (error) { if (alive.current) setMessage(`自查未保存：${error instanceof Error ? error.message : '请重试。'}`); }
    finally { if (alive.current) setBusy(false); }
  };
  return <section className="panel settings" aria-label="口语体检与自查">
    <h2>本地文字体检</h2>
    <p className="muted">依据手动转写提供词面指标与证据；实际流利与发音请回听核对。</p>
    {!transcript.trim() ? <p>先写下全部或关键片段的转写，即可查看文字体检；回听自查仍可保存。</p> : !result ? <p>正在读取文字体检…</p> : <section aria-label="口语本地证据">
      {Object.entries(result.criteria).map(([key, criterion]) => <div key={key}><h4>{SPEAKING_DIMENSION_LABELS[key as keyof typeof SPEAKING_DIMENSION_LABELS]}</h4><ul>{criterion.evidence.map((item, index) => <li key={index}>{item.message}{item.kind === 'metric' ? ` 指标 ${item.metric}：${Number(item.value).toFixed(2)}` : ''}</li>)}</ul></div>)}
      {result.warnings.length > 0 && <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    </section>}
    <h3>逐项回听自查</h3>
    <p className="muted"><a href={SPEAKING_RUBRIC_SOURCE} target="_blank" rel="noreferrer">官方口语评分标准</a> · 以下为练习自查提示，勾选不换算分数。</p>
    {speakingRubric().map(item => <label className="field" key={item.id}><span>{item.label}</span><input type="checkbox" aria-label={`口语自查 ${item.id}`} checked={state.checklist[item.id] === true} onChange={event => update(value => ({ ...value, checklist: { ...value.checklist, [item.id]: event.target.checked } }))} /></label>)}
    {materialSelfCheck.length > 0 && <details><summary>材料的回听提示</summary><ul>{materialSelfCheck.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    <h3>错因</h3>
    {speakingCauseOptions().map(item => <label key={item.id} className="field"><span>{item.label}</span><input type="checkbox" aria-label={`口语错因 ${item.id}`} checked={state.errorCauses.includes(item.id)} onChange={event => update(value => ({ ...value, errorCauses: event.target.checked ? [...value.errorCauses, item.id] : value.errorCauses.filter(cause => cause !== item.id) }))} /></label>)}
    {state.errorCauses.includes('other') && <label>其他错因说明<textarea aria-label="口语其他错因说明" maxLength={3000} value={state.otherExplanation} onChange={event => update(value => ({ ...value, otherExplanation: event.target.value }))} /></label>}
    <h3>可选回听自评</h3>
    <p className="muted">只记录这次作答的自评，口语单科成绩仍在成绩本按整场登记。</p>
    {Object.entries(SPEAKING_DIMENSION_LABELS).map(([key, label]) => <label className="field" key={key}><span>{label}</span><input type="number" aria-label={`口语自评${label}分数`} min={0} max={9} step={0.5} value={state.bands[key] ?? ''} placeholder="未评估" onChange={event => update(value => ({ ...value, bands: { ...value.bands, [key]: event.target.value === '' ? null : Number(event.target.value) } }))} /></label>)}
    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void save(); }}>{busy ? '保存中…' : '保存口语自查'}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
