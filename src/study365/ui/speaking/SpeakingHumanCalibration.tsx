import { useEffect, useRef, useState } from 'react';
import type { Revision } from '../../protocol';
import { todayInTimeZone } from '../../planEngine';
import { getLearningState, saveRecord, useLearning } from '../../repository';
import { assertCurrentSpeaking } from '../../speakingReview';
import { buildHumanSpeakingCalibration, humanSpeakingId, speakingCalibrationForWork, speakingCalibrationRows } from '../../speakingCalibration';
import { SPEAKING_DIMENSION_LABELS, type SpeakingDimension } from '../../speakingRubric';

interface Props { plan: Revision; work: Revision; currentWork: () => Revision | null; onSaved?: () => void }
export function SpeakingHumanCalibration(props: Props) {
  const learning = useLearning();
  return <CalibrationBody key={`${learning.userId ?? 'guest'}:${props.work.revisionId}`} {...props} />;
}
function CalibrationBody({ plan, work, currentWork, onSaved }: Props) {
  const learning = useLearning();
  const [values, setValues] = useState<Record<string, string>>({});
  const [date, setDate] = useState(() => todayInTimeZone(Date.now(), String(plan.payload.timeZone)));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const inFlight = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const human = speakingCalibrationForWork(learning.records, work)[0];
  const rows = speakingCalibrationRows(learning.records, work);
  const check = (userId: string | null) => {
    assertCurrentSpeaking(work, currentWork());
    if (getLearningState().userId !== userId) throw new Error('账号已切换，请在原账号继续登记。');
  };
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const userId = learning.userId;
    try {
      check(userId);
      if (Object.keys(SPEAKING_DIMENSION_LABELS).some(key => !values[key]?.trim())) throw new Error('请填写真人返回的完整四项分；尚未返回请保留未评估。');
      const payload = await buildHumanSpeakingCalibration(work, plan, Object.fromEntries(Object.keys(SPEAKING_DIMENSION_LABELS).map(key => [key, Number(values[key])])), date);
      check(userId);
      await saveRecord({ id: humanSpeakingId(work), kind: 'assessment', payload });
      if (alive.current) { setMessage('真人四项分已绑定这一版口语作答保存。'); onSaved?.(); }
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '真人分未能保存，输入仍保留。'); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="panel settings" aria-label="口语真人评阅">
    <h2>真人评阅</h2>
    <p role="status">{human ? '已有真人四项分' : '真人四项分未评估'}</p>
    <p className="muted">这里记录单次作答的四项表现，不作口语单科分。整场口语的真人或正式单科成绩，请到<a href="#/progress">成绩本登记</a>，才会更新口语差距。</p>
    <section aria-label="同版口语四维评分" style={{ overflowX: 'auto' }}>
      <h3>同版口语四维评分</h3>
      <p className="muted">自评依据实际回听；文字估分只涉及词汇与语法，实际流利与发音保持未评估。</p>
      <table><thead><tr><th>来源</th>{Object.values(SPEAKING_DIMENSION_LABELS).map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.label}><th>{row.label}</th>{Object.keys(SPEAKING_DIMENSION_LABELS).map(key => <td key={key}>{row.bands[key as SpeakingDimension] === null ? '未评估' : Number(row.bands[key as SpeakingDimension]).toFixed(1)}</td>)}</tr>)}</tbody></table>
    </section>
    <form aria-label="登记口语真人四项分" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy}>
        <legend>收到真人评分后登记</legend>
        <label>评分日期<input aria-label="口语真人评分日期" type="date" required value={date} onChange={event => setDate(event.target.value)} /></label>
        {Object.entries(SPEAKING_DIMENSION_LABELS).map(([key, label]) => <label key={key}>{label}<input aria-label={`口语真人${label}分数`} type="number" min={0} max={9} step={0.5} required placeholder="未评估" value={values[key] ?? ''} onChange={event => setValues(value => ({ ...value, [key]: event.target.value }))} /></label>)}
      </fieldset>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存口语真人评分'}</button>
    </form>
    {message && <p role="status">{message}</p>}
  </section>;
}
