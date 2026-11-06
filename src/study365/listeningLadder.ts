import { SECTION_TARGETS } from "./protocol";
import type { LocalMaterial } from "./localBankSchema";

export type ListeningSection = 1 | 2 | 3 | 4;

/**
 * IELTS listening difficulty is carried by the Section number, not by `frequency`.
 * Days 1–20 climb one Section every five days; afterwards each week keeps one S1 and one S2
 * for accuracy upkeep and spends the rest on S3/S4, where most marks are lost.
 * Indexed from day 21; offsets 0 and 6 coincide with the rest day / weekly full paper in the
 * plan rhythm, so the five single-Section days receive S1, S3, S4, S2, S4.
 */
const WEEKLY_MIX: readonly ListeningSection[] = [3, 1, 3, 4, 2, 4, 4];
export function listeningSectionForDay(day: number): ListeningSection {
  if (!Number.isFinite(day) || day < 1) return 1;
  if (day <= 20) return (Math.ceil(day / 5) as ListeningSection);
  return WEEKLY_MIX[(Math.floor(day) - 21) % WEEKLY_MIX.length];
}

export function listeningStageLabel(day: number): string {
  if (day >= 1 && day <= 20) {
    const section = listeningSectionForDay(day);
    return `第${section}阶段 · Section ${section}（第${(section - 1) * 5 + 1}–${section * 5}天）`;
  }
  return `综合阶段 · 本日 Section ${listeningSectionForDay(day)}`;
}

const sectionOf = (item: LocalMaterial): number | undefined =>
  item.skill === "listening" ? item.section : undefined;

/** Exact Section first, then the nearest easier one, then harder; untagged material goes last. */
export function sectionDistance(item: LocalMaterial, wanted: ListeningSection): number {
  const section = sectionOf(item);
  if (!section) return 100;
  const gap = section - wanted;
  return gap === 0 ? 0 : gap < 0 ? -gap * 2 - 1 : gap * 2;
}

export function preferSection<T extends LocalMaterial>(
  candidates: readonly T[],
  wanted: ListeningSection,
): { items: T[]; section: number | undefined; exact: boolean } {
  if (!candidates.length) return { items: [], section: undefined, exact: false };
  const best = Math.min(...candidates.map((item) => sectionDistance(item, wanted)));
  const items = candidates.filter((item) => sectionDistance(item, wanted) === best);
  const section = sectionOf(items[0]);
  return { items, section, exact: section === wanted };
}

export function ladderNotice(day: number, picked: number | undefined): string {
  const wanted = listeningSectionForDay(day);
  const head = `听力${listeningStageLabel(day)}：按 Section 1→4 由易到难安排，再在本阶段内轮换题型。`;
  if (picked === undefined) return head;
  return picked === wanted
    ? head
    : `${head}本阶段的 Section ${wanted} 新材料已用完，临时改用最接近的 Section ${picked}。`;
}

export interface ListeningMethodCard {
  section: ListeningSection;
  title: string;
  scene: string;
  focus: string[];
  before: string[];
  traps: string[];
  review: string[];
}

const REVIEW = [
  "对答案后，只重听错题前后各 2 句，找到答案出现的原句。",
  "把“题干说法 → 录音原话”的同义替换记下来，这是最常见的丢分原因。",
  "错题按原因归类：拼写/单复数、没听出替换、跟丢位置、被干扰项带走。",
  "挑 3–5 句原文跟读一遍，第二天开练前先复听这几句。",
];

export const LISTENING_METHOD_CARDS: Record<ListeningSection, ListeningMethodCard> = {
  1: {
    section: 1,
    title: "Section 1 · 生活对话，先把送分题拿满",
    scene: "两人对话，订房、报名、咨询等日常场景。全卷最容易，目标是 10 题全对。",
    focus: ["表格 / 表单 / 笔记填空", "姓名拼写、电话、日期、价格、地址"],
    before: [
      "开播前用 30 秒圈出每空前后的关键词，并预判答案词性（数字、名字还是名词）。",
      "看清字数限制，例如 ONE WORD AND/OR A NUMBER。",
    ],
    traps: [
      "说话人先说一个答案又改口（“Actually, make that…”），以改口后为准。",
      "字母拼写：A/E/I、G/J、B/V 容易听混；13 和 30 这类数字注意重音。",
      "单复数漏 s、超字数，都会直接判错。",
    ],
    review: REVIEW,
  },
  2: {
    section: 2,
    title: "Section 2 · 生活独白，跟住顺序和方位",
    scene: "一个人介绍场所、活动或服务。开始出现地图题和多选题。",
    focus: ["地图 / 平面图", "单选 / 多选", "配对"],
    before: [
      "地图题先找到起点和入口，标好东南西北，再看各空在哪个位置。",
      "选择题先把选项之间的差别划出来，不要逐字读完。",
    ],
    traps: [
      "原文会提到所有选项，被否定或说“以前是”的那个不选。",
      "方位词：opposite、next to、beyond、at the end of 要提前熟悉。",
      "多选题不要求按顺序，但每个选项都要有原文依据。",
    ],
    review: REVIEW,
  },
  3: {
    section: 3,
    title: "Section 3 · 学术讨论，分清是谁的观点",
    scene: "2–4 人讨论作业或课题，语速更快，观点来回变化。",
    focus: ["单选 / 多选", "观点配对", "流程图与笔记填空"],
    before: [
      "先弄清有几个说话人、各自身份，在题旁标注可能是谁说的。",
      "配对题先读选项，再按题号顺序听。",
    ],
    traps: [
      "A 提出、B 否定、最后达成一致：答案在最后的结论。",
      "听到 but、however、actually 要立刻提高注意。",
      "题干与原文几乎都是同义替换，只等原词会错过答案。",
    ],
    review: REVIEW,
  },
  4: {
    section: 4,
    title: "Section 4 · 学术讲座，连续 10 空不能断",
    scene: "一人讲座，中间没有停顿，最难，也是 7.5→8.0 拉开差距的部分。",
    focus: ["笔记 / 摘要填空（占绝大多数）", "少量选择"],
    before: [
      "利用小标题判断讲座结构，听到小标题就知道进入下一组题。",
      "预判每空的词性和大致含义，学术词汇要能拼对。",
    ],
    traps: [
      "漏掉一空不要停，立刻看下一题，否则会连丢多题。",
      "答案多为原文原词，但题干部分已被改写。",
      "注意 -tion / -ment 等后缀拼写和名词复数。",
    ],
    review: REVIEW,
  },
};

export function methodCardFor(
  material: LocalMaterial | null | undefined,
  day: number,
): ListeningMethodCard {
  const section = material ? sectionOf(material) : undefined;
  const key = (section && section >= 1 && section <= 4
    ? section
    : listeningSectionForDay(day)) as ListeningSection;
  return LISTENING_METHOD_CARDS[key];
}

/** Keep the skill goal aligned with the project; raw-score cutoffs vary by paper. */
export const LISTENING_TARGET_NOTE =
  `听力训练目标 ${SECTION_TARGETS.listening.toFixed(1)}。Section 1–2 力争零失误，把容错留给 Section 3–4；原始正确数与分数的对应以具体试卷换算为准。`;
