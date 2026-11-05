import { READING_QUESTION_TYPES, LISTENING_QUESTION_TYPES } from './contentSchemas';
import type { LocalMaterial } from './localBankSchema';
import { currentAttemptHeads } from './materialSource';
import { listeningSectionForDay, preferSection } from './listeningLadder';
import { isObject, validatePayload, type AttemptScope, type MaterialSource, type Revision } from './protocol';
export interface ScheduledMaterial { id: string; version: string; skill: 'reading' | 'listening'; sourceRef: string; materialSource: MaterialSource; scope: AttemptScope; contentHash: string; questionTypes: string[]; passageNumber?: 1 | 2 | 3 }
export interface ScheduledListeningReadingDay { day: number; readingOfficial: ScheduledMaterial | null; reading: ScheduledMaterial | null; listeningOfficial: ScheduledMaterial | null; listening: ScheduledMaterial | null }
const frequencyRank = { high: 0, medium: 1, low: 2 };
const brief = (item: LocalMaterial): ScheduledMaterial => ({ id: item.id, version: item.version, skill: item.skill, sourceRef: item.source.sourceRef, materialSource: item.source.materialSource, scope: item.scope, contentHash: item.contentHash, questionTypes: [...new Set(item.questions.map(question => question.type))], ...(item.skill === 'reading' && item.passageNumber ? { passageNumber: item.passageNumber as 1 | 2 | 3 } : {}) });
const titleKey = (item: LocalMaterial) => item.title.toLowerCase().replace(/[^a-z]/g, '') || item.id;
const rank = (a: LocalMaterial, b: LocalMaterial) => (frequencyRank[a.frequency ?? 'low'] - frequencyRank[b.frequency ?? 'low']) || a.id.localeCompare(b.id) || b.version.localeCompare(a.version, undefined, { numeric: true });
function uniqueMaterials(materials: readonly LocalMaterial[]): LocalMaterial[] {
  const ids = new Set<string>(), titles = new Set<string>();
  return [...materials].sort(rank).filter(item => {
    const title = `${item.skill}:${item.scope}:${titleKey(item)}`;
    if (ids.has(item.id) || titles.has(title)) return false;
    ids.add(item.id); titles.add(title); return true;
  });
}
function pools(materials: readonly LocalMaterial[]) {
  const practice = materials.filter(item => item.pool !== 'holdout');
  const reservedExams = new Set(materials.filter(item => item.scope === 'full' && item.examId).map(item => `${item.skill}:${item.examId}`));
  const playable = (item: LocalMaterial) => item.skill === 'reading' || !!item.audio?.path;
  const daily = uniqueMaterials(practice.filter(item => item.scope === 'section' && item.questions.length > 0 && playable(item) && !(item.examId && reservedExams.has(`${item.skill}:${item.examId}`))));
  const official = uniqueMaterials(practice.filter(item => item.source.materialSource === 'official' && item.scope === 'type-drill' && item.questions.length > 0 && playable(item)));
  return { reading: daily.filter(item => item.skill === 'reading'), listening: daily.filter(item => item.skill === 'listening'), official };
}
const dayLevel = (day: number): 1 | 2 | 3 => day <= 5 ? 1 : day <= 10 ? 2 : 3;
/** Official drills may rotate; the separate daily article/audio pool never silently repeats. */
function rotateOfficial(materials: LocalMaterial[]): (LocalMaterial | null)[] {
  const unseen = new Set(materials.flatMap(item => item.questions.map(question => question.type))), remaining = [...materials], result: (LocalMaterial | null)[] = [];
  for (let day = 0; day < 14; day++) {
    if (!remaining.length) remaining.push(...materials);
    const choices = remaining;
    const chosen = [...choices].sort((a, b) => b.questions.filter(question => unseen.has(question.type)).length - a.questions.filter(question => unseen.has(question.type)).length || rank(a, b))[0] ?? null;
    result.push(chosen);
    if (chosen) { chosen.questions.forEach(question => unseen.delete(question.type)); const index = remaining.indexOf(chosen); if (index >= 0) remaining.splice(index, 1); }
  }
  return result;
}
export function buildListeningReadingSchedule(materials: readonly LocalMaterial[]) {
  const pool = pools(materials), readingOfficial = rotateOfficial(pool.official.filter(item => item.skill === 'reading')), listeningOfficial = rotateOfficial(pool.official.filter(item => item.skill === 'listening'));
  const reading = [...pool.reading], listening = [...pool.listening].sort((a, b) => {
    const source = (item: LocalMaterial) => item.source.materialSource === 'cambridge' ? 0 : item.source.materialSource === 'unofficial' ? 1 : item.source.materialSource === 'official' ? 2 : 3;
    return source(a) - source(b) || rank(a, b);
  });
  let minimumLevel = 1;
  const seenReadingTypes = new Set<string>();
  const days: ScheduledListeningReadingDay[] = Array.from({ length: 14 }, (_, index) => {
    const target = Math.max(minimumLevel, dayLevel(index + 1)), candidates = reading.filter(item => item.skill === 'reading' && item.passageNumber !== undefined && item.passageNumber >= target).sort((a, b) => Number(a.skill === 'reading' ? a.passageNumber : 0) - Number(b.skill === 'reading' ? b.passageNumber : 0) || b.questions.filter(question => !seenReadingTypes.has(question.type)).length - a.questions.filter(question => !seenReadingTypes.has(question.type)).length || rank(a, b));
    const article = candidates[0] ?? null;
    if (article) { article.questions.forEach(question => seenReadingTypes.add(question.type)); reading.splice(reading.indexOf(article), 1); if (article.skill === 'reading') minimumLevel = article.passageNumber ?? minimumLevel; }
    const audio = preferSection(listening, listeningSectionForDay(index + 1)).items[0] ?? null;
    if (audio) listening.splice(listening.indexOf(audio), 1);
    return { day: index + 1, reading: article ? brief(article) : null, readingOfficial: readingOfficial[index] ? brief(readingOfficial[index]!) : null, listening: audio ? brief(audio) : null, listeningOfficial: listeningOfficial[index] ? brief(listeningOfficial[index]!) : null };
  });
  const readingReserve = reading.slice(0, 14).map(brief), missing = { reading: days.filter(day => !day.reading).length, readingReserve: Math.max(0, 14 - readingReserve.length), readingOfficialDays: days.filter(day => !day.readingOfficial).length, listening: days.filter(day => !day.listening).length, listeningOfficialDays: days.filter(day => !day.listeningOfficial).length };
  const family = (type: string): string | null => type === 'true-false-not-given' ? 'TFNG' : type === 'yes-no-not-given' ? 'YNNG' : type === 'matching-headings' ? '标题配对' : type === 'matching-information' ? '信息配对' : type.includes('completion') || type === 'short-answer' ? '填空' : type === 'multiple-choice' ? '选择题' : null;
  const coveredReadingFamilies = new Set(days.flatMap(day => day.reading?.questionTypes.map(family).filter((value): value is string => value !== null) ?? []));
  const missingReadingFamilies = ['TFNG', 'YNNG', '标题配对', '信息配对', '填空', '选择题'].filter(value => !coveredReadingFamilies.has(value));
  const shortages = [missing.reading && `还缺${missing.reading}篇日常阅读材料。`, missing.readingReserve && `还缺${missing.readingReserve}篇备用阅读材料。`, missing.readingOfficialDays && `还缺${missing.readingOfficialDays}天可判分的官方阅读题型练习。`, missing.listening && `还缺${missing.listening}节带题目和音频的日常听力。`, missing.listeningOfficialDays && `还缺${missing.listeningOfficialDays}天可播放、可判分的官方听力题型练习。`].filter((value): value is string => typeof value === 'string');
  if (missingReadingFamilies.length) shortages.push(`14天阅读题型尚缺：${missingReadingFamilies.join('、')}。`);
  const officialReadingTypes = new Set(pool.official.filter(item => item.skill === 'reading').flatMap(item => item.questions.map(question => question.type)));
  const officialListeningTypes = new Set(pool.official.filter(item => item.skill === 'listening').flatMap(item => item.questions.map(question => question.type)));
  const missingOfficialReadingTypes = READING_QUESTION_TYPES.filter(type => !officialReadingTypes.has(type));
  const missingOfficialListeningTypes = LISTENING_QUESTION_TYPES.filter(type => !officialListeningTypes.has(type));
  if (missingOfficialReadingTypes.length) shortages.push(`官方阅读题型尚缺：${missingOfficialReadingTypes.join('、')}。`);
  if (missingOfficialListeningTypes.length) shortages.push(`官方听力题型尚缺：${missingOfficialListeningTypes.join('、')}。`);
  return { days, readingReserve, missing, shortages, missingReadingFamilies, missingOfficialReadingTypes, missingOfficialListeningTypes };
}
function matchedMaterial(record: Revision, materials: readonly LocalMaterial[]): LocalMaterial | undefined {
  return materials.find(item => item.id === record.payload.contentId && item.version === record.payload.contentVersion && item.contentHash === record.payload.contentHash && item.skill === record.payload.skill);
}
function originalAccuracy(record: Revision): number | null {
  if (Array.isArray(record.payload.questionResults) && record.payload.questionResults.length) {
    const questions = record.payload.questionResults.filter(isObject).filter(item => item.answerDisputed !== true);
    if (!questions.length || questions.some(item => typeof item.correct !== 'boolean')) return null;
    return questions.filter(item => item.correct === true).length / questions.length;
  }
  const { correct, score, total } = record.payload, value = correct ?? score;
  return typeof value === 'number' && typeof total === 'number' && Number.isFinite(value) && Number.isFinite(total) && total > 0 && value >= 0 && value <= total ? value / total : null;
}
export function selectReadingForDay(materials: readonly LocalMaterial[], records: readonly Revision[], planId: string, day: number): { material: ScheduledMaterial | null; passageNumber: 1 | 2 | 3; reason: 'scheduled' | 'advance' | 'repeat-level'; notice: string } {
  if (!Number.isInteger(day) || day < 1 || day > 365) throw new Error('学习日必须在1至365之间。');
  const pool = pools(materials).reading;
  const seenArticles = new Set<string>();
  const attempts = currentAttemptHeads(records, planId).filter(item => item.payload.skill === 'reading' && item.payload.firstAttempt === true).map(record => ({ record, material: matchedMaterial(record, pool), accuracy: originalAccuracy(record) })).filter(item => item.material?.skill === 'reading' && item.material.scope === 'section' && item.accuracy !== null).sort((a, b) => String(a.record.payload.date ?? '').localeCompare(String(b.record.payload.date ?? '')) || a.record.createdAt - b.record.createdAt || a.record.seq - b.record.seq).filter(item => {
    const key = titleKey(item.material!); if (seenArticles.has(key)) return false; seenArticles.add(key); return true;
  }).reverse();
  let level: 1 | 2 | 3 = dayLevel(day), reason: 'scheduled' | 'advance' | 'repeat-level' = 'scheduled';
  const latest = attempts[0], lastLevel = latest?.material?.skill === 'reading' ? latest.material.passageNumber : undefined;
  if (lastLevel) {
    const sameLevel = attempts.filter(item => item.material?.skill === 'reading' && item.material.passageNumber === lastLevel).slice(0, 3);
    if (sameLevel.length === 3 && sameLevel.every(item => Number(item.accuracy) >= 0.85) && lastLevel < 3) { level = (lastLevel + 1) as 2 | 3; reason = 'advance'; }
    else if (Number(latest.accuracy) <= 0.5) { level = lastLevel as 1 | 2 | 3; reason = 'repeat-level'; }
    else level = Math.max(level, lastLevel) as 1 | 2 | 3;
  }
  const used = new Set(currentAttemptHeads(records, planId).filter(item => item.payload.skill === 'reading').map(item => String(item.payload.contentId)));
  const usedTitles = new Set(materials.filter(item => used.has(item.id)).map(titleKey));
  const available = (item: LocalMaterial) => item.skill === 'reading' && item.passageNumber === level && !used.has(item.id) && !usedTitles.has(titleKey(item));
  const scheduled = reason === 'scheduled' && day <= 14 ? buildListeningReadingSchedule(materials).days[day - 1].reading : null;
  const planned = scheduled ? pool.find(item => item.id === scheduled.id && item.version === scheduled.version && item.contentHash === scheduled.contentHash && available(item)) : undefined;
  const chosen = planned ?? pool.find(available) ?? null;
  return { material: chosen ? brief(chosen) : null, passageNumber: level, reason, notice: chosen ? reason === 'advance' ? '最近3次同级首答正确率均达到85%，提前选下一篇级别；学习时长不变。' : reason === 'repeat-level' ? '最近一次正确率不高于50%，下一次保留同级并换另一篇。' : '按P1至P3阶梯选材；出现频率不表示难度。' : `还缺可用的P${level}新篇目，不重复旧篇充数。` };
}
export function officialTypeCalibration(records: readonly Revision[], materials: readonly LocalMaterial[], planId: string) {
  const groups = new Map<string, { skill: 'reading' | 'listening'; questionType: string; correct: number; total: number; attemptIds: string[] }>();
  const seenMaterials = new Set<string>();
  const firstClaims = currentAttemptHeads(records, planId).sort((a, b) => String(a.payload.date ?? '').localeCompare(String(b.payload.date ?? '')) || a.createdAt - b.createdAt || a.seq - b.seq);
  for (const record of firstClaims) {
    if (record.payload.scope !== 'type-drill' || record.payload.materialSource !== 'official' || record.payload.firstAttempt !== true) continue;
    const material = matchedMaterial(record, materials);
    if (!material || material.pool === 'holdout' || material.scope !== 'type-drill' || material.source.materialSource !== 'official' || !material.questions.length || material.skill === 'listening' && !material.audio) continue;
    try { validatePayload('attempt', record.payload); } catch { continue; }
    const identity = `${material.skill}:${material.id}@${material.version}@${material.contentHash}`;
    if (seenMaterials.has(identity)) continue;
    seenMaterials.add(identity);
    if (!Array.isArray(record.payload.questionResults) || record.payload.questionResults.length !== material.questions.length || record.payload.questionResults.some(result => !isObject(result) || !material.questions.some(question => question.id === result.questionId))) continue;
    for (const result of record.payload.questionResults) {
      if (!isObject(result) || result.answerDisputed === true) continue;
      const question = material.questions.find(item => item.id === result.questionId);
      if (!question) continue;
      const key = `${material.skill}:${question.type}`, group = groups.get(key) ?? { skill: material.skill, questionType: question.type, correct: 0, total: 0, attemptIds: [] };
      group.total++; if (result.correct === true) group.correct++;
      if (!group.attemptIds.includes(record.id)) group.attemptIds.push(record.id);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.skill.localeCompare(b.skill) || a.questionType.localeCompare(b.questionType)).map(group => ({ ...group, accuracy: group.total ? group.correct / group.total : null }));
}
