import { SPEAKING_CHECKLIST_IDS, SPEAKING_ERROR_CAUSES } from './speakingChecklist';

export const SPEAKING_RUBRIC_SOURCE = 'https://ielts.org/cdn/ielts-guides/ielts-speaking-band-descriptors.pdf';
export const SPEAKING_DIMENSION_LABELS = { fluency: '流利与连贯', lexical: '词汇', grammar: '语法', pronunciation: '发音' } as const;
export type SpeakingDimension = keyof typeof SPEAKING_DIMENSION_LABELS;
const items: Record<string, { dimension: SpeakingDimension; label: string }> = {
  'speaking-fluency-development': { dimension: 'fluency', label: '回答围绕问题展开，有理由或例子，长回答前后衔接清楚。' },
  'speaking-fluency-continuity': { dimension: 'fluency', label: '回听时能持续表达，停顿和重复没有打断主要意思。' },
  'speaking-fluency-linking': { dimension: 'fluency', label: '连接和指代自然，听者能跟上话题的推进。' },
  'speaking-lexical-precision': { dimension: 'lexical', label: '用词和搭配表达准确，不靠生硬难词掩盖含义。' },
  'speaking-lexical-paraphrase': { dimension: 'lexical', label: '遇到词语卡住时，能换一种说法讲清同一意思。' },
  'speaking-grammar-range': { dimension: 'grammar', label: '按表达需要灵活使用简单句和复杂句。' },
  'speaking-grammar-accuracy': { dimension: 'grammar', label: '回听并核对手动转写，反复的语法错误已标出并能改正。' },
  'speaking-pronunciation-intelligibility': { dimension: 'pronunciation', label: '回听实际声音时，大部分内容容易听懂，口音不妨碍意思。' },
  'speaking-pronunciation-stress': { dimension: 'pronunciation', label: '重音和分组有助于突出重点，节奏总体自然。' },
  'speaking-pronunciation-intonation': { dimension: 'pronunciation', label: '语调有变化，能帮助听者理解态度和句子关系。' },
};
export function speakingRubric() { return SPEAKING_CHECKLIST_IDS.map(id => ({ id, ...items[id] })); }
const causes: Record<string, string> = {
  'synonym-miss': '同义表达理解偏差', 'locating-error': '信息定位偏差', 'vocab-unknown': '词汇不熟', 'misread-question': '误读题意', 'tfng-inference': '对题意过度推断',
  grammar: '语法', 'lexical-misuse': '用词不当', coherence: '衔接与组织', 'fluency-pause': '停顿与重复', pronunciation: '发音', 'time-pressure': '时间压力', other: '其他（需说明）',
};
export function speakingCauseOptions() { return SPEAKING_ERROR_CAUSES.map(id => ({ id, label: causes[id] })); }
