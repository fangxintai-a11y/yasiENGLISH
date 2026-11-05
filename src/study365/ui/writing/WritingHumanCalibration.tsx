import { useEffect, useRef, useState } from 'react';
import { isObject, type Revision } from '../../protocol';
import { todayInTimeZone } from '../../planEngine';
import { getLearningState, saveRecord, useLearning } from '../../repository';
import { assertCurrentWriting } from '../../writingFeedback';
import { buildHumanWritingCalibration, buildWritingHandoff, calibrationForWork, humanWritingId, writingExportText, writingHandoffId } from '../../writingCalibration';
import { feedbackForWork } from '../../writingReview';
import { WRITING_DIMENSION_LABELS } from '../../writingRubric';

export function WritingHumanCalibration({ plan, work, currentWork, onSaved }: { plan: Revision; work: Revision; currentWork: () => Revision | null; onSaved?: () => void }) {
  const learning = useLearning();
  const dimensions = [work.payload.taskType === 'task1' ? 'taskAchievement' : 'taskResponse', 'coherence', 'lexical', 'grammar'];
  const [values, setValues] = useState<Record<string, string>>({});
  const [date, setDate] = useState(() => todayInTimeZone(Date.now(), String(plan.payload.timeZone)));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [exported, setExported] = useState('');
  const inFlight = useRef(false), active = useRef(true), exportRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    active.current = true; setValues({}); setMessage(''); setExported('');
    setDate(todayInTimeZone(Date.now(), String(plan.payload.timeZone)));
    return () => { active.current = false; };
  }, [work.revisionId, learning.userId, plan.payload.timeZone]);
  if (work.payload.scope === 'paragraph' || work.payload.stage === 'draft') return <section className="panel"><p>段落练习不作为完整作品的真人校准。请提交完整Task 1或Task 2后登记。</p></section>;
  const human = calibrationForWork(learning.records, work)[0];
  const markerId = writingHandoffId(work);
  const marker = learning.records.find(record => record.id === markerId && record.kind === 'mission' && record.planId === work.planId && !record.deleted && !record.conflict);
  const feedbacks = feedbackForWork(learning.records, work);
  const rows = [
    { label: '自评', bands: feedbacks.find(record => record.payload.source === 'self')?.payload.bands },
    { label: '估分', bands: feedbacks.find(record => record.payload.source === 'ai')?.payload.bands },
    { label: '真人', bands: human?.payload.bands },
  ];
  const check = (userId: string | null) => {
    assertCurrentWriting(work, currentWork());
    if (getLearningState().userId !== userId) throw new Error('账号已切换，请在原账号继续登记。');
  };
  const handoff = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const userId = learning.userId;
    try {
      check(userId);
      const payload = buildWritingHandoff(work, todayInTimeZone(Date.now(), String(plan.payload.timeZone)));
      await saveRecord({ id: markerId, kind: 'mission', payload });
      if (active.current) { setMessage('已标为待评阅。请将导出内容交给你选定的评阅人。'); onSaved?.(); }
    } catch (error) { if (active.current) setMessage(error instanceof Error ? error.message : '交付状态未能保存。'); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const userId = learning.userId;
    try {
      check(userId);
      if (dimensions.some(key => values[key] === undefined || values[key].trim() === '')) throw new Error('请填写真人返回的完整四项分；尚未返回请保留待评阅。');
      const payload = await buildHumanWritingCalibration(work, plan, Object.fromEntries(dimensions.map(key => [key, Number(values[key])])), date, typeof marker?.payload.date === 'string' ? marker.payload.date : undefined);
      check(userId);
      await saveRecord({ id: humanWritingId(work), kind: 'assessment', payload });
      if (marker) {
        check(userId);
        await saveRecord({ id: marker.id, kind: 'mission', payload: { ...marker.payload, status: 'completed' } });
      }
      if (active.current) { setMessage('真人四项分已绑定交出的这一版作品保存。'); onSaved?.(); }
    } catch (error) { if (active.current) setMessage(error instanceof Error ? error.message : '真人分未能保存，输入仍保留。'); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  const exportWork = async () => {
    try {
      const text = writingExportText(work); setExported(text);
      try { await navigator.clipboard.writeText(text); setMessage('题目、出处、字数与正文已复制。'); }
      catch { setMessage('请复制下方导出内容。'); window.setTimeout(() => exportRef.current?.select(), 0); }
    } catch (error) { setMessage(error instanceof Error ? error.message : '这篇作品暂不能导出。'); }
  };
  return <section className="panel settings" aria-label="写作真人评阅">
    <h3>真人评阅</h3>
    <p role="status">{human ? '已有真人评分' : marker ? '待评阅' : '尚未交付真人评阅'}</p>
    <p className="muted">每周日交付一篇完整Task 2；Task 1也可独立评阅。这里登记单篇四项分，写作单科成绩仍在成绩本按整场登记。</p>
    <div className="data-actions"><button type="button" className="btn btn-primary" disabled={busy || !!human || !!marker} onClick={() => { void handoff(); }}>交给真人评分</button><button type="button" className="btn btn-ghost" onClick={() => { void exportWork(); }}>导出这篇作品</button></div>
    {exported && <textarea ref={exportRef} aria-label="作品导出内容" readOnly rows={8} value={exported} />}
    <section aria-label="同版四维评分" style={{ overflowX: 'auto' }}>
      <h4>同版四维评分</h4>
      <table><thead><tr><th>来源</th>{dimensions.map(key => <th key={key}>{WRITING_DIMENSION_LABELS[key]}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.label}><th>{row.label}</th>{dimensions.map(key => <td key={key}>{isObject(row.bands) && typeof row.bands[key] === 'number' ? Number(row.bands[key]).toFixed(1) : row.label === '真人' && marker && !human ? '待评阅' : '未评估'}</td>)}</tr>)}</tbody>
      </table>
    </section>
    <form aria-label="登记真人四项分" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy}>
        <legend>真人返回后登记</legend>
        <label>评分日期<input aria-label="真人评分日期" type="date" required value={date} onChange={event => setDate(event.target.value)} /></label>
        {dimensions.map(key => <label key={key}>{WRITING_DIMENSION_LABELS[key]}<input aria-label={`真人${WRITING_DIMENSION_LABELS[key]}分数`} type="number" min={0} max={9} step={0.5} required value={values[key] ?? ''} placeholder="待真人评分" onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /></label>)}
      </fieldset>
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存真人评分'}</button>
    </form>
    {message && <p role="status">{message}</p>}
  </section>;
}
