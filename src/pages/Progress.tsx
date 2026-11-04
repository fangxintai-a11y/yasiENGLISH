import { GATE_TARGETS, SECTION_TARGETS } from '../study365/protocol';
import { useActivePlan } from '../study365/useActivePlan';
import { buildProgress } from '../study365/progressModel';
import { SKILLS, SKILL_LABELS, sourceLabel } from '../study365/scoresModel';
import { todayInTimeZone } from '../study365/planEngine';
import { AssessmentForm } from '../study365/ui/AssessmentForm';
import { ScoreBook } from '../study365/ui/ScoreBook';

export function Progress() {
  const { learning, plan, dayPlan, error } = useActivePlan();
  if (!learning.ready) return <div className="page"><p>正在读取学习记录…</p></div>;
  if (!plan) return <div className="page"><header className="page-head"><h1 className="display">进度与成绩本</h1></header><section className="panel"><p>先在今日页开启365天计划。</p><a className="btn btn-primary" href="#/today">前往今日</a></section></div>;
  if (error) return <div className="page"><h1>进度与成绩本</h1><p role="alert">{error}</p><a href="#/today">返回今日</a></div>;
  const today = todayInTimeZone(Date.now(), String(plan.payload.timeZone));
  const model = buildProgress(plan, learning.records, today);
  return <div className="page" key={`${learning.userId ?? 'guest'}:${plan.id}`}>
    <header className="page-head"><p className="eyebrow">365天训练</p><h1 className="display">进度与成绩本</h1></header>
    <section className="panel" aria-label="最终目标差距">
      <h2>目标总分 {GATE_TARGETS.G4.overall.toFixed(1)}</h2>
      <p>当前总分：{model.current.effectiveOverall === null ? '未知' : model.current.effectiveOverall.toFixed(1)} · 差距：{model.overallGap === null ? '未评估' : model.overallGap.toFixed(1)}</p>
      <p className="muted">{model.latest ? `总分来自最近一次四科有效分齐全的测评：${String(model.latest.payload.date ?? '日期未记录')}` : '尚无四科有效分齐全的同场测评，总分未知。'}每次四科单独计算，不拼接不同场次的最高分。</p>
      <ul>{SKILLS.map(skill => { const value = model.bySkill[skill]; return <li key={skill}>{SKILL_LABELS[skill]} · 目标 {SECTION_TARGETS[skill].toFixed(1)} · 当前 {value ? `${value.score.toFixed(1)}（${value.date || '日期未记录'}，${sourceLabel(value.source, skill)}）` : '未评估'} · 差距 {model.gaps[skill] === null ? '未评估' : model.gaps[skill]!.toFixed(1)}</li>; })}</ul>
      <p role="status">{model.completed ? '已取得满足总分及四科目标的同次正式成绩。' : '尚未完成：需要同次正式成绩的总分和四科全部达到目标。'}</p>
      {dayPlan?.baselineRouting.notice && <p role="status">{dayPlan.baselineRouting.notice}</p>}
      <p className="muted">{model.hasScores ? `补强建议：优先${SKILL_LABELS[model.recommendedSkill]}。` : '先完成基线，未评估科目不能按0分计算。'}任务分钟暂不自动调整。</p>
    </section>
    <section className="panel" aria-label="下一个门槛">
      <h2>{model.nextGate ? `下一个门槛：${model.nextGate.id}` : '门槛记录'}</h2>
      {model.nextGate && <><p>{model.nextGate.dueDate ? `第${model.nextGate.day}天 · ${model.nextGate.dueDate}` : '正式考试'} · 总分目标 {model.nextGate.target.overall.toFixed(1)} · 当前差距 {model.nextGate.overallGap === null ? '未评估' : model.nextGate.overallGap.toFixed(1)}</p>
        <ul>{SKILLS.map(skill => <li key={skill}>{SKILL_LABELS[skill]}目标 {model.nextGate!.target[skill].toFixed(1)} · 差距 {model.nextGate!.gaps[skill] === null ? '未评估' : model.nextGate!.gaps[skill]!.toFixed(1)}</li>)}</ul>
        <p className="muted">{model.nextGate.required === 2 ? '连续2次，不同日期、不同材料；必须登记真实序号。' : '按本门槛测评记录判断，日期到达不会自动通过。'}</p></>}
      <ul>{model.gates.map(gate => <li key={gate.id}>{gate.id} · {gate.dueDate ?? '正式考试'} · {gate.met ? '已通过' : '未通过'}</li>)}</ul>
    </section>
    <section className="panel" aria-label="实际投入">
      <h2>实际投入</h2><p>累计 {model.actualMinutes.toLocaleString()} 分钟（{(model.actualMinutes / 60).toFixed(1)}小时） / 计划容量 {model.capacityMinutes / 60}小时</p>
      <p className="muted">投入时间不换算成雅思分数。完成度只计完成任务的原计划分钟。</p>
      <h3>最近28天</h3><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))', gap: 8 }}>{model.recentDays.map(day => <div key={day.date} className="muted"><span>{day.date}</span><br /><strong>{Math.round(day.ratio * 100)}%</strong> · {day.status === 'completed' ? '完成' : day.status === 'partial' ? '部分完成' : '未开始'}<br />实际{day.actualMinutes}分钟</div>)}</div>
    </section>
    <AssessmentForm key={`${learning.userId ?? 'guest'}:${plan.id}`} plan={plan} date={today} />
    <ScoreBook records={learning.records} planId={plan.id} />
  </div>;
}
