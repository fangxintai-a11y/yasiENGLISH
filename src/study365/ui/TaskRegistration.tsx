import { useRef, useState } from 'react';
import { assertNoCredentials } from '../../ielts/scoring';
import type { DayPlan } from '../planEngine';
import { missionTaskId, saveMission } from '../missionRecords';
import type { LearningPayload, Revision } from '../protocol';
import { getLearningState, saveRecord, useLearning } from '../repository';
import { SKILL_LABELS, buildExternalAttempt } from '../scoresModel';

interface Props { plan: Revision; dayPlan: DayPlan; block: DayPlan['blocks'][number]; mission?: Revision; selectedSkill?: DayPlan['blocks'][number]['skill']; onClose?: () => void }
type Pending = { userId: string | null; mission: Parameters<typeof saveMission>[0]; attempt: { id: string; kind: 'attempt'; payload: LearningPayload } | null; missionSaved: boolean };

export function TaskRegistration({ plan, dayPlan, block, mission, selectedSkill, onClose }: Props) {
  const learning = useLearning();
  const taskId = missionTaskId(dayPlan.day, block.id);
  const existing = learning.records.filter(record => record.kind === 'attempt' && !record.deleted && !record.conflict && record.planId === plan.id && record.payload.taskId === taskId && record.payload.date === dayPlan.date);
  const [status, setStatus] = useState(['in_progress', 'completed', 'partial', 'skipped'].includes(String(mission?.payload.status)) ? String(mission?.payload.status) : mission?.payload.status === 'minimum' ? 'partial' : 'completed');
  const [actualMinutes, setActualMinutes] = useState(String(mission?.payload.actualMinutes ?? ''));
  const [materialName, setMaterialName] = useState(''), [materialUrl, setMaterialUrl] = useState(''), [note, setNote] = useState('');
  const [contentId, setContentId] = useState(() => String(existing[0]?.payload.contentId ?? `external-${crypto.randomUUID()}`));
  const [score, setScore] = useState(''), [total, setTotal] = useState('');
  const [timed, setTimed] = useState(false), [unseen, setUnseen] = useState(false), [replayed, setReplayed] = useState(false), [viewedTranscript, setViewedTranscript] = useState(false), [firstAttempt, setFirstAttempt] = useState(false);
  const [busy, setBusy] = useState(false), [resume, setResume] = useState(false), [message, setMessage] = useState('');
  const pending = useRef<Pending | null>(null), inFlight = useRef(false);
  const skill = String(selectedSkill ?? mission?.payload.skill ?? block.skill ?? block.id);
  const listeningReading = skill === 'listening' || skill === 'reading';

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      if (!pending.current) {
        if (actualMinutes.trim() === '') throw new Error('请填写实际分钟；未投入可填0。');
        if (status !== 'skipped' && !existing.length && ['listening', 'reading', 'writing', 'speaking'].includes(skill) && !materialName.trim() && !materialUrl.trim()) throw new Error('请填写材料名称或链接。');
        if (firstAttempt && existing.some(record => record.payload.contentId === contentId.trim() && record.payload.firstAttempt === true)) throw new Error('这份材料已有首答记录；补记请取消“首次作答”。');
        const hasNewDetail = status !== 'skipped' && !existing.length || !!(materialName.trim() || materialUrl.trim() || note.trim() || score || total || timed || unseen || replayed || viewedTranscript || firstAttempt);
        const attempt = buildExternalAttempt({ planId: plan.id, date: dayPlan.date, day: dayPlan.day, taskId, skill, contentId, actualMinutes: Number(actualMinutes), materialName, materialUrl, note,
          score: score === '' ? undefined : Number(score), total: total === '' ? undefined : Number(total), timed, unseen, replayed, viewedTranscript, firstAttempt });
        assertNoCredentials(attempt);
        pending.current = { userId: learning.userId, mission: { planId: plan.id, day: dayPlan.day, date: dayPlan.date, block: { ...block, skill: ['listening', 'reading', 'writing', 'speaking', 'vocabulary'].includes(skill) ? skill as DayPlan['blocks'][number]['skill'] : block.skill }, status: status as Parameters<typeof saveMission>[0]['status'], actualMinutes: Number(actualMinutes), timeSource: 'manual', expectedUserId: learning.userId }, attempt: hasNewDetail ? { id: crypto.randomUUID(), kind: 'attempt', payload: attempt } : null, missionSaved: false };
      }
      const batch = pending.current;
      if (getLearningState().userId !== batch.userId) throw new Error('账号已切换，请回原账号继续登记。');
      if (!batch.missionSaved) { await saveMission(batch.mission); batch.missionSaved = true; }
      if (getLearningState().userId !== batch.userId) throw new Error('账号已切换，请回原账号继续登记。');
      if (batch.attempt) await saveRecord(batch.attempt);
      pending.current = null; setResume(false); setMessage('任务已保存在本机，联网后自动同步。'); onClose?.();
    } catch (error) { setResume(!!pending.current); setMessage(error instanceof Error ? error.message : '未能保存，登记内容仍保留。'); }
    finally { inFlight.current = false; setBusy(false); }
  };

  return <form className="panel settings" aria-label="外部任务登记" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h3>外部完成后登记 · {SKILL_LABELS[skill as keyof typeof SKILL_LABELS] ?? '复盘与交付'}</h3>
    <p className="muted">{dayPlan.date} · 计划{block.minutes}分钟。状态和用时可补记，已保存的首答与分数不会改写。</p>
    {existing.length > 0 && <details><summary>已保存{existing.length}次作答或登记</summary>{existing.map(record => <p key={record.id} className="muted">{record.payload.firstAttempt ? '首答' : '补充/重做'} · {String(record.payload.contentId)}{typeof record.payload.score === 'number' ? ` · 原始正确数 ${record.payload.score}/${record.payload.total}` : ''}{record.payload.note ? ` · ${String(record.payload.note)}` : ''}</p>)}</details>}
    <fieldset disabled={busy || resume}>
      <label>完成状态<select aria-label="登记完成状态" value={status} onChange={event => setStatus(event.target.value)}><option value="in_progress">进行中</option><option value="completed">完成</option><option value="partial">部分完成</option><option value="skipped">跳过</option></select></label>
      <label>实际分钟<input aria-label="登记实际分钟" type="number" min={0} max={1440} step="any" required value={actualMinutes} onChange={event => setActualMinutes(event.target.value)} /></label>
      <label>材料名称<input aria-label="登记材料名称" value={materialName} maxLength={300} onChange={event => setMaterialName(event.target.value)} /></label>
      <label>材料链接<input aria-label="登记材料链接" type="url" value={materialUrl} onChange={event => setMaterialUrl(event.target.value)} /></label>
      <label>材料标识<input aria-label="登记材料标识" value={contentId} maxLength={160} onChange={event => setContentId(event.target.value)} /></label>
      <label>备注<textarea aria-label="登记备注" value={note} maxLength={3000} onChange={event => setNote(event.target.value)} /></label>
      {listeningReading && <fieldset><legend>听读原始成绩（按本次材料填写）</legend>
        <label>原始正确数<input aria-label="登记原始正确数" type="number" min={0} step={1} value={score} onChange={event => setScore(event.target.value)} /></label>
        <label>总题数<input aria-label="登记总题数" type="number" min={1} step={1} value={total} onChange={event => setTotal(event.target.value)} /></label>
        <p className="muted">雅思分请另在成绩本按本次材料的换算依据登记。</p>
      </fieldset>}
      <fieldset><legend>作答条件（如实勾选）</legend>{([['计时完成', timed, setTimed], ['未做过的新题', unseen, setUnseen], ['重放过音频', replayed, setReplayed], ['看过文本', viewedTranscript, setViewedTranscript], ['这是首次作答', firstAttempt, setFirstAttempt]] as const).map(([label, checked, set]) => <label key={label}><input type="checkbox" checked={checked} onChange={event => set(event.target.checked)} />{label}</label>)}</fieldset>
    </fieldset>
    {resume && <p>原登记尚待保存；重试会继续，不重写已保存的作答。</p>}
    <div className="data-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : resume ? '继续保存任务' : '保存任务登记'}</button>{onClose && <button type="button" className="btn btn-ghost" disabled={busy || resume} onClick={onClose}>收起登记</button>}</div>
    {message && <p role="status">{message}</p>}
  </form>;
}
