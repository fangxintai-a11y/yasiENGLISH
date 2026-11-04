import { useRef, useState } from 'react';
import { assertNoCredentials } from '../../ielts/scoring';
import { GATE_TARGETS, type LearningPayload, type Revision } from '../protocol';
import { getLearningState, saveRecord, useLearning } from '../repository';
import { ASSESSMENT_LABELS, SKILLS, SKILL_LABELS, SOURCE_LABELS, buildAssessment, buildExternalAttempt, type AssessmentKind, type ScoreSource } from '../scoresModel';
import type { GateId, Scores } from '../goals';

const blankScores = () => ({ listening: '', reading: '', writing: '', speaking: '' });
type Pending = { userId: string | null; items: { id: string; kind: 'assessment' | 'attempt'; payload: LearningPayload }[]; next: number };

export function AssessmentForm({ plan, date, onSaved }: { plan: Revision; date: string; onSaved?: () => void }) {
  const learning = useLearning();
  const [kind, setKind] = useState<AssessmentKind>('baseline');
  const [testDate, setTestDate] = useState(date);
  const [values, setValues] = useState(blankScores);
  const [sources, setSources] = useState({ listening: 'self', reading: 'self', writing: 'human', speaking: 'human' } as Record<keyof Scores, ScoreSource>);
  const [gateId, setGateId] = useState<GateId>('G1');
  const [consecutiveIndex, setConsecutiveIndex] = useState<1 | 2>(1);
  const [materialId, setMaterialId] = useState('');
  const [materialName, setMaterialName] = useState('');
  const [materialUrl, setMaterialUrl] = useState('');
  const [note, setNote] = useState('');
  const [raw, setRaw] = useState({ listening: { score: '', total: '' }, reading: { score: '', total: '' } });
  const [timed, setTimed] = useState(false), [unseen, setUnseen] = useState(false), [replayed, setReplayed] = useState(false), [viewedTranscript, setViewedTranscript] = useState(false), [firstAttempt, setFirstAttempt] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [resume, setResume] = useState(false);
  const pending = useRef<Pending | null>(null), inFlight = useRef(false);
  const formal = kind === 'official' || kind === 'gate' && gateId === 'G4';

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      if (!pending.current) {
        const scores = Object.fromEntries(SKILLS.map(skill => [skill, values[skill].trim() === '' ? null : Number(values[skill])])) as Scores;
        const scoreSources = Object.fromEntries(SKILLS.map(skill => [skill, scores[skill] === null ? null : formal ? 'official' : sources[skill]])) as Parameters<typeof buildAssessment>[0]['scoreSources'];
        const id = crypto.randomUUID();
        const rawItems = (['listening', 'reading'] as const).filter(skill => raw[skill].score !== '' || raw[skill].total !== '');
        const contentId = materialId.trim() || (rawItems.length ? `external-${id}` : '');
        const notes = [materialName.trim() && `材料：${materialName.trim()}`, materialUrl.trim() && `链接：${materialUrl.trim()}`, note.trim()].filter(Boolean).join('\n');
        // Validate every item before the first local write. A retry continues this immutable submission.
        const assessment = buildAssessment({ planId: plan.id, date: testDate, kind, scores, scoreSources, materialId: contentId, note: notes, gateId: kind === 'gate' ? gateId : undefined, consecutiveIndex, conditions: { timed, unseen, replayed, viewedTranscript, firstAttempt } }, learning.records);
        const items: Pending['items'] = rawItems.map(skill => {
          const payload = buildExternalAttempt({ planId: plan.id, date: testDate, taskId: `assessment-${id}-${skill}`, skill, contentId, score: raw[skill].score === '' ? undefined : Number(raw[skill].score), total: raw[skill].total === '' ? undefined : Number(raw[skill].total), actualMinutes: 0, materialName, materialUrl, note: '成绩登记附带的原始正确数；未另登记用时。', timed, unseen, replayed, viewedTranscript, firstAttempt });
          delete payload.actualMinutes; // Unknown duration is omitted, rather than recorded as a real zero-minute attempt.
          return { id: crypto.randomUUID(), kind: 'attempt', payload };
        });
        // Validate the link even if no raw listening/reading count was provided.
        if (materialUrl.trim()) buildExternalAttempt({ planId: plan.id, date: testDate, taskId: `assessment-${id}`, skill: 'review', contentId: contentId || `external-${id}`, actualMinutes: 0, materialUrl });
        items.push({ id, kind: 'assessment', payload: assessment });
        assertNoCredentials(items);
        pending.current = { userId: learning.userId, items, next: 0 };
      }
      const batch = pending.current;
      for (; batch.next < batch.items.length; batch.next++) {
        if (getLearningState().userId !== batch.userId) throw new Error('账号已切换，请回原账号继续登记。');
        await saveRecord(batch.items[batch.next]);
      }
      pending.current = null; setResume(false); setValues(blankScores()); setRaw({ listening: { score: '', total: '' }, reading: { score: '', total: '' } });
      setMessage('成绩已保存在本机，联网后自动同步。'); onSaved?.();
    } catch (error) {
      setResume(!!pending.current);
      setMessage(error instanceof Error ? error.message : '未能保存，输入仍保留。');
    } finally { inFlight.current = false; setBusy(false); }
  };

  return <form className="panel settings" aria-label="登记成绩" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h2 className="eyebrow">登记成绩</h2>
    <p className="muted">分数按本次材料的评分依据填写，不自动把正确题数换算成雅思分。写作、口语没有真人分时留空。</p>
    <fieldset disabled={busy || resume}>
      <label>成绩日期<input aria-label="成绩日期" type="date" required value={testDate} onChange={event => setTestDate(event.target.value)} /></label>
      <label>测评类型<select aria-label="测评类型" value={kind} onChange={event => setKind(event.target.value as AssessmentKind)}>{Object.entries(ASSESSMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {kind === 'gate' && <>
        <label>门槛<select aria-label="门槛" value={gateId} onChange={event => setGateId(event.target.value as GateId)}>{Object.keys(GATE_TARGETS).map(id => <option key={id}>{id}</option>)}</select></label>
        {gateId === 'G3' && <label>连续测评序号<select aria-label="连续测评序号" value={consecutiveIndex} onChange={event => setConsecutiveIndex(Number(event.target.value) as 1 | 2)}><option value={1}>第一次</option><option value={2}>第二次（不同日期、不同材料）</option></select></label>}
      </>}
      {SKILLS.map(skill => <fieldset key={skill}><legend>{SKILL_LABELS[skill]}</legend>
        <label>{SKILL_LABELS[skill]}分数<input aria-label={`${SKILL_LABELS[skill]}分数`} type="number" min={0} max={9} step={0.5} value={values[skill]} placeholder={skill === 'writing' || skill === 'speaking' ? '待真人评分' : '未评估'} onChange={event => setValues(current => ({ ...current, [skill]: event.target.value }))} /></label>
        <label>{SKILL_LABELS[skill]}来源<select aria-label={`${SKILL_LABELS[skill]}来源`} value={formal ? 'official' : sources[skill]} disabled={formal} onChange={event => setSources(current => ({ ...current, [skill]: event.target.value as ScoreSource }))}>
          {(formal ? ['official'] : skill === 'writing' || skill === 'speaking' ? ['human', 'official'] : Object.keys(SOURCE_LABELS)).map(source => <option key={source} value={source}>{SOURCE_LABELS[source as ScoreSource]}</option>)}
        </select></label>
        {(skill === 'listening' || skill === 'reading') && <div>
          <label>{SKILL_LABELS[skill]}原始正确数<input aria-label={`${SKILL_LABELS[skill]}原始正确数`} type="number" min={0} step={1} value={raw[skill].score} onChange={event => setRaw(current => ({ ...current, [skill]: { ...current[skill], score: event.target.value } }))} /></label>
          <label>{SKILL_LABELS[skill]}总题数<input aria-label={`${SKILL_LABELS[skill]}总题数`} type="number" min={1} step={1} value={raw[skill].total} onChange={event => setRaw(current => ({ ...current, [skill]: { ...current[skill], total: event.target.value } }))} /></label>
        </div>}
      </fieldset>)}
      <label>材料标识<input aria-label="成绩材料标识" value={materialId} maxLength={160} placeholder="例如 cambridge20-test1（G3必填）" onChange={event => setMaterialId(event.target.value)} /></label>
      <label>材料名称<input aria-label="成绩材料名称" value={materialName} maxLength={300} onChange={event => setMaterialName(event.target.value)} /></label>
      <label>材料链接<input aria-label="成绩材料链接" type="url" value={materialUrl} onChange={event => setMaterialUrl(event.target.value)} /></label>
      <label>备注<textarea aria-label="成绩备注" maxLength={3000} value={note} onChange={event => setNote(event.target.value)} /></label>
      <fieldset><legend>本次作答条件（如实勾选）</legend>{([['计时完成', timed, setTimed], ['未做过的新题', unseen, setUnseen], ['重放过音频', replayed, setReplayed], ['看过文本', viewedTranscript, setViewedTranscript], ['这是首次作答', firstAttempt, setFirstAttempt]] as const).map(([label, checked, set]) => <label key={label}><input type="checkbox" checked={checked} onChange={event => set(event.target.checked)} />{label}</label>)}</fieldset>
    </fieldset>
    {resume && <p className="muted">部分登记尚待保存；重试会继续原登记，不重写已经保存的首答。</p>}
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? '保存中…' : resume ? '继续保存这次成绩' : '保存成绩'}</button>
    {message && <p role="status">{message}</p>}
  </form>;
}
