import type { Revision } from '../protocol';
import { ASSESSMENT_LABELS, SKILLS, SKILL_LABELS, currentAssessments, scoreView, sourceLabel, type AssessmentKind } from '../scoresModel';

export function ScoreBook({ records, planId }: { records: readonly Revision[]; planId: string }) {
  const assessments = currentAssessments(records, planId);
  return <section className="panel" aria-label="成绩本">
    <h2 className="eyebrow">成绩本</h2>
    <p className="muted">每条只计算同次四科；写作和口语的估分保留展示，不进入目标差距。</p>
    {!assessments.length && <p>尚未登记成绩，当前基线待测。</p>}
    {assessments.map(record => {
      const view = scoreView(record.payload);
      const type = ASSESSMENT_LABELS[record.payload.kind as AssessmentKind];
      const attempts = records.filter(attempt => attempt.kind === 'attempt' && !attempt.deleted && !attempt.conflict && attempt.planId === planId
        && record.payload.materialId && attempt.payload.contentId === record.payload.materialId && attempt.payload.date === record.payload.date
        && typeof attempt.payload.score === 'number' && typeof attempt.payload.total === 'number');
      return <article key={record.id} className="panel" data-assessment-id={record.id}>
        <h3>{String(record.payload.date ?? '日期未记录')} · {type}{record.payload.kind === 'gate' ? ` ${String(record.payload.gateId)}` : ''}</h3>
        {record.payload.gateId === 'G3' && <p className="muted">连续测评第{Number(record.payload.consecutiveIndex)}次 · 材料 {String(record.payload.materialId ?? '未记录')}</p>}
        <ul>{SKILLS.map(skill => <li key={skill}>{SKILL_LABELS[skill]}：{view.scores[skill] === null ? '未评估' : view.scores[skill]!.toFixed(1)} · {sourceLabel(view.sources[skill], skill)} · 差距 {view.gaps[skill] === null ? '未评估' : view.gaps[skill]!.toFixed(1)}</li>)}</ul>
        <p>总分：{view.overall === null ? '未知' : view.overall.toFixed(1)}{view.effectiveOverall === null && view.overall !== null ? '（含估分，目标总分差距未评估）' : ''}</p>
        {attempts.map(attempt => <p key={attempt.id} className="muted">{SKILL_LABELS[attempt.payload.skill as keyof typeof SKILL_LABELS] ?? '练习'}原始正确数：{Number(attempt.payload.score)}/{Number(attempt.payload.total)}</p>)}
        <p>{view.finalGoalMet ? '本次正式成绩满足最终目标。' : '本次成绩尚未满足正式完成条件。'}</p>
        {typeof record.payload.note === 'string' && record.payload.note && <p className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.payload.note}</p>}
      </article>;
    })}
  </section>;
}
