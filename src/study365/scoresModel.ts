import { evaluateFinalGoal, overallBand, sectionGaps, type GateId, type Scores } from './goals';
import { GATE_TARGETS, SCORE_SOURCES, SECTION_TARGETS, isObject, validatePayload, type LearningPayload, type Revision } from './protocol';

export type Skill = keyof typeof SECTION_TARGETS;
export type ScoreSource = typeof SCORE_SOURCES[number];
export type ScoreSources = Record<Skill, ScoreSource | null>;
export type AssessmentKind = 'baseline' | 'weekly-mock' | 'gate' | 'official';
export const SKILLS = Object.keys(SECTION_TARGETS) as Skill[];
export const SKILL_LABELS: Record<Skill, string> = { listening: '听力', reading: '阅读', writing: '写作', speaking: '口语' };
export const ASSESSMENT_LABELS: Record<AssessmentKind, string> = { baseline: '基线', 'weekly-mock': '周测', gate: '门槛测评', official: '正式成绩' };
export const SOURCE_LABELS: Record<ScoreSource, string> = { self: '自评', rules: '规则', ai: '估分', human: '真人', official: '正式' };
const band = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9 && Number.isInteger(value * 2) ? value : null;

export function sourceLabel(source: ScoreSource | null, skill: Skill): string {
  if (!source) return '未评估';
  return (skill === 'writing' || skill === 'speaking') && !['human', 'official'].includes(source) ? '估分' : SOURCE_LABELS[source];
}

/** Keep the original sitting visible; only its eligible scores enter gaps. Never mix sittings. */
export function scoreView(payload: LearningPayload) {
  const scores = Object.fromEntries(SKILLS.map(skill => [skill, band(isObject(payload.scores) ? payload.scores[skill] : null)])) as Scores;
  const sources = Object.fromEntries(SKILLS.map(skill => {
    const value = isObject(payload.scoreSources) ? payload.scoreSources[skill] : payload.source;
    return [skill, scores[skill] !== null && SCORE_SOURCES.includes(value as ScoreSource) ? value : null];
  })) as ScoreSources;
  const effectiveScores = Object.fromEntries(SKILLS.map(skill => [skill,
    sources[skill] && (!(skill === 'writing' || skill === 'speaking') || ['human', 'official'].includes(sources[skill]!)) ? scores[skill] : null])) as Scores;
  return { scores, sources, effectiveScores, overall: overallBand(scores), effectiveOverall: overallBand(effectiveScores), gaps: sectionGaps(effectiveScores), finalGoalMet: evaluateFinalGoal(payload).met };
}

export function currentAssessments(records: readonly Revision[], planId: string): Revision[] {
  const heads = new Map<string, Revision>();
  for (const record of records) {
    if (record.kind !== 'assessment' || record.planId !== planId || record.conflict) continue;
    const old = heads.get(record.id);
    if (!old || record.createdAt > old.createdAt || record.createdAt === old.createdAt && record.seq > old.seq) heads.set(record.id, record);
  }
  return [...heads.values()].filter(record => {
    if (record.deleted || !['baseline', 'weekly-mock', 'gate', 'official'].includes(String(record.payload.kind))) return false;
    try { validatePayload('assessment', record.payload); return true; } catch { return false; }
  }).sort((a, b) => String(b.payload.date ?? '').localeCompare(String(a.payload.date ?? '')) || b.createdAt - a.createdAt || b.seq - a.seq);
}
export const latestAssessment = (records: readonly Revision[], planId: string): Revision | null => currentAssessments(records, planId)[0] ?? null;

export interface AssessmentInput {
  planId: string; date: string; kind: AssessmentKind; scores: Scores; scoreSources: ScoreSources;
  materialId?: string; note?: string; gateId?: GateId; consecutiveIndex?: 1 | 2;
  conditions?: { timed: boolean; unseen: boolean; replayed: boolean; viewedTranscript: boolean; firstAttempt?: boolean };
}
export function buildAssessment(input: AssessmentInput, records: readonly Revision[] = []): LearningPayload {
  for (const skill of SKILLS) {
    const score = input.scores[skill], source = input.scoreSources[skill];
    if (score !== null && band(score) === null) throw new Error('单项分数必须为0至9的半分。');
    if (score === null ? source !== null : !SCORE_SOURCES.includes(source as ScoreSource)) throw new Error('空分必须对应空来源，有分数时请选择来源。');
    if (score !== null && ['writing', 'speaking'].includes(skill) && !['human', 'official'].includes(String(source))) throw new Error('写作和口语登记须有真人或正式分；尚未评分请留空。');
  }
  if (input.kind === 'official' || input.kind === 'gate' && input.gateId === 'G4') {
    if (SKILLS.some(skill => input.scores[skill] !== null && input.scoreSources[skill] !== 'official')) throw new Error('正式成绩必须使用正式来源。');
    if (input.kind === 'official' && SKILLS.some(skill => input.scores[skill] === null)) throw new Error('正式成绩必须包含完整四科。');
  }
  const nonEmptySources = SKILLS.map(skill => input.scoreSources[skill]).filter((value): value is ScoreSource => value !== null);
  const source: ScoreSource = input.kind === 'official' || input.kind === 'gate' && input.gateId === 'G4' ? 'official'
    : nonEmptySources.length && nonEmptySources.every(value => value === nonEmptySources[0]) ? nonEmptySources[0] : 'self';
  const payload: LearningPayload = { planId: input.planId, date: input.date, kind: input.kind, source, scores: { ...input.scores }, scoreSources: { ...input.scoreSources } };
  if (input.materialId?.trim()) payload.materialId = input.materialId.trim();
  if (input.note?.trim()) payload.note = input.note.trim();
  if (input.conditions) payload.conditions = { ...input.conditions };
  if (input.kind === 'gate') {
    if (!input.gateId || !Object.hasOwn(GATE_TARGETS, input.gateId)) throw new Error('请选择门槛。');
    Object.assign(payload, { gateId: input.gateId, targets: { ...GATE_TARGETS[input.gateId] } });
    if (input.gateId === 'G3') {
      if (!input.materialId?.trim()) throw new Error('G3须填写本次材料标识。');
      if (input.consecutiveIndex !== 1 && input.consecutiveIndex !== 2) throw new Error('请选择第一次或第二次测评。');
      payload.consecutiveIndex = input.consecutiveIndex;
      if (input.consecutiveIndex === 2) {
        const previous = currentAssessments(records, input.planId).filter(r => r.payload.kind === 'weekly-mock' || r.payload.kind === 'gate' && r.payload.gateId === 'G3')[0];
        if (!previous || previous.payload.kind !== 'gate' || previous.payload.consecutiveIndex !== 1) throw new Error('请先登记连续测评的第一次；中间有周测时需重新登记第一次。');
        if (String(previous.payload.date) >= input.date) throw new Error('第二次测评须使用第一次之后的不同日期。');
        if (previous.payload.materialId === input.materialId.trim()) throw new Error('第二次测评须使用不同材料。');
      }
    }
  }
  validatePayload('assessment', payload);
  return payload;
}

export interface ExternalAttemptInput {
  planId: string; date: string; day?: number; taskId: string; skill: string; contentId: string; actualMinutes: number;
  score?: number; total?: number; materialName?: string; materialUrl?: string; note?: string;
  timed?: boolean; unseen?: boolean; replayed?: boolean; viewedTranscript?: boolean; firstAttempt?: boolean;
}
export function buildExternalAttempt(input: ExternalAttemptInput): LearningPayload {
  if (!Number.isFinite(input.actualMinutes) || input.actualMinutes < 0 || input.actualMinutes > 1440) throw new Error('实际分钟须在0至1440之间。');
  if ((input.score === undefined) !== (input.total === undefined)) throw new Error('原始正确数与总题数须一起填写。');
  if (input.score !== undefined && (!Number.isInteger(input.score) || !Number.isInteger(input.total) || input.score < 0 || input.total! <= 0 || input.score > input.total!)) throw new Error('原始正确数须为整数且不超过总题数。');
  const materialUrl = input.materialUrl?.trim();
  if (materialUrl) {
    let url: URL;
    try { url = new URL(materialUrl); } catch { throw new Error('材料链接须为有效的http或https网址。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('材料链接须为不含登录凭据的http或https网址。');
  }
  const note = [input.materialName?.trim() && `材料：${input.materialName.trim()}`, materialUrl && `链接：${materialUrl}`, input.note?.trim()].filter(Boolean).join('\n');
  const payload: LearningPayload = { planId: input.planId, date: input.date, ...(input.day === undefined ? {} : { day: input.day }), taskId: input.taskId, skill: input.skill, contentId: input.contentId.trim(), actualMinutes: input.actualMinutes, answers: [],
    conditions: { timed: !!input.timed, unseen: !!input.unseen, replayed: !!input.replayed, viewedTranscript: !!input.viewedTranscript }, firstAttempt: !!input.firstAttempt };
  if (input.score !== undefined) Object.assign(payload, { score: input.score, correct: input.score, total: input.total });
  if (note) payload.note = note;
  validatePayload('attempt', payload);
  return payload;
}
