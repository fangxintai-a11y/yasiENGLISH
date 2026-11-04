import type { ReadingBody } from "../types";
export type TopicId = "transport" | "learning" | "cooling";
export type FactKey = "size" | "amount" | "direction" | "scope" | "method" | "outcome";
export type FactValue = number | "increase" | "decrease" | "same" | "all" | "restricted" | "primary" | "secondary" | boolean | null;
export interface ControlledFact { value: FactValue; evidence: string; description: string }
export interface ControlledReport { topic: TopicId; title: string; paragraphs: string[]; translation: string[]; facts: Record<FactKey, ControlledFact>; amountThreshold: number; statements: Record<"amount" | "notAmount" | "direction" | "scope" | "method" | "outcome", string>; sizeStatement: (number: number) => string }
export type Predicate = { op: "lt" | "gte"; value: number } | { op: "eq"; value: Exclude<FactValue, null> };
export interface ControlledQuestion { fact: FactKey; predicate: Predicate; statement: string }
const numberWords: Record<number, string> = { 3: "three", 4: "four", 5: "five", 6: "six", 8: "eight", 10: "ten", 12: "twelve", 18: "eighteen", 20: "twenty", 24: "twenty-four", 30: "thirty", 40: "forty", 45: "forty-five", 60: "sixty", 75: "seventy-five" };
const en = (number: number) => numberWords[number] ?? String(number);
const fact = (value: FactValue, evidence: string, description: string): ControlledFact => ({ value, evidence, description });
export function textSeed(value: string): number { let seed = 2166136261; for (const letter of value) { seed ^= letter.charCodeAt(0); seed = Math.imul(seed, 16777619); } return seed >>> 0; }
/** Background selection depends on the seed and fact key, never its truth
 * value. Known and unknown versions therefore share the same related context.
 * Unknown facts either omit the factual sentence, or retain related information
 * that cannot determine that fact; neither mode announces missing reporting. */
function factLine(value: FactValue, known: [string, string], related: [string, string], anchor: string, seed: number, key: FactKey) {
  const withContext = (textSeed(`${seed}:${key}`) & 1) === 0;
  return {
    text: [value === null ? "" : known[0], withContext ? related[0] : ""].filter(Boolean).join(" "),
    zh: [value === null ? "" : known[1], withContext ? related[1] : ""].filter(Boolean).join(""),
    evidence: value !== null ? known[0] : withContext ? related[0] : anchor,
  };
}
function shuffle<T>(values: T[], seed: number): T[] {
  const output = [...values]; let state = seed || 1;
  for (let index = output.length - 1; index > 0; index--) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; const target = (state >>> 0) % (index + 1); [output[index], output[target]] = [output[target], output[index]]; }
  return output;
}
/** No language inference: each predicate refers to one authored, typed fact. */
export function evaluateClaim(fact: ControlledFact, predicate: Predicate): "TRUE" | "FALSE" | "NOT GIVEN" {
  if (fact.value === null) return "NOT GIVEN";
  if (predicate.op !== "eq" && typeof fact.value !== "number") throw new Error("数值题必须引用数值事实。");
  const matches = predicate.op === "eq" ? fact.value === predicate.value : predicate.op === "lt" ? Number(fact.value) < predicate.value : Number(fact.value) >= predicate.value;
  return matches ? "TRUE" : "FALSE";
}
export function createControlledReport(topic: TopicId, variant: 0 | 1 | 2, seed: number): ControlledReport {
  const size = 3 + (seed >>> 5) % 4;
  if (topic === "transport") {
    const amount = [18, 24, null][variant], interval = [10, 30, null][variant];
    const sizeLine = `The pilot covered ${en(size)} routes.`;
    const amountLine = factLine(amount, [amount === null ? "" : `After the change, the average journey took ${en(amount)} minutes.`, amount === null ? "" : `调整后的平均单程为${amount}分钟。`],
      ["Stops near the market were listed as useful points for later observations.", "市场附近的车站被列为日后观察的合适地点。"], "Journey time concerns the length of a trip, whereas the interval describes how long passengers may wait for the next vehicle.", seed, "amount");
    const directionLine = factLine(interval, [interval === null ? "" : `The interval between buses ${interval < 20 ? "fell" : "rose"} from twenty minutes to ${en(interval)} minutes.`, interval === null ? "" : `班车间隔由20分钟${interval < 20 ? "缩短" : "延长"}至${interval}分钟。`],
      ["Passengers could check the route map at the main bus stops.", "乘客可以在主要车站查看线路图。"], "Journey time concerns the length of a trip, whereas the interval describes how long passengers may wait for the next vehicle.", seed, "direction");
    const scopeLine = factLine(["all", "restricted", null][variant] as FactValue,
      [["All residents could travel without paying during the trial.", "Only registered students could travel without paying; other residents still paid the standard fare.", ""][variant], ["所有居民试验期间免费乘车。", "只有注册学生免费，其他居民仍付标准票价。", ""][variant]],
      ["Stops near schools and shops were included in the route guide.", "线路指南列出了学校和商店附近的车站。"], "The distinction between access and use mattered to the evaluation.", seed, "scope");
    const methodLine = factLine(["primary", null, "secondary"][variant] as FactValue,
      [["Passenger numbers were assessed using automated counters, not a questionnaire.", "", "Passenger numbers were assessed using a questionnaire rather than automated counters."][variant], ["乘客数用自动计数器统计，而非问卷。", "", "乘客数来自问卷，而非自动计数器。"][variant]],
      ["The researchers visited the main terminal to discuss daily operations.", "研究人员到主要车站讨论日常运营。"], "The research method was intended to support careful comparison rather than a simple claim about everybody's behaviour.", seed, "method");
    const outcomeLine = factLine([null, true, false][variant],
      [["", "Staff received extra pay for work on the pilot.", "Staff received their usual pay, with no additional payment for the pilot."][variant], ["", "员工因试验工作获得额外报酬。", "员工只领取通常工资，没有试验额外报酬。"][variant]],
      ["Staff attended training on the new timetable before the pilot began.", "试验开始前，员工接受了新时刻表的培训。"], "The council also considered the resources needed to maintain the service.", seed, "outcome");
    return { topic, title: "城市交通试验：服务、费用与证据", amountThreshold: 20,
      paragraphs: [
        `A small city council wanted to understand how a different approach to public transport would affect daily travel. It organised a six-month pilot rather than immediately changing the entire network. ${sizeLine} The selected routes connected residential streets with shops and workplaces. Researchers treated the exercise as a practical analysis of services, so the published findings separated individual measures instead of describing the policy as a single success or failure.`,
        `${amountLine.text} ${directionLine.text} These measures answer different questions. Journey time concerns the length of a trip, whereas the interval describes how long passengers may wait for the next vehicle. A shorter trip does not necessarily imply more frequent buses. The report therefore treated the two measures separately and warned readers against replacing one measure with the other when discussing the benefit of the change.`,
        `${scopeLine.text} ${methodLine.text} The distinction between access and use mattered to the evaluation. A fare policy can make a service available to a group without proving how often its members actually travel. Similarly, an increase in recorded passenger numbers cannot, on its own, explain why individuals changed their choices. The research method was intended to support careful comparison rather than a simple claim about everybody's behaviour.`,
        `${outcomeLine.text} The council also considered the resources needed to maintain the service. Its final discussion asked whether the observed pattern could continue beyond a short pilot and whether a different district would provide the same context. The account did not claim that one timetable would suit every neighbourhood. Further decisions were to consider the individual measurements, the scope of the fare policy and the cost of continuing the service together.`,
      ],
      translation: [
        `市议会用六个月的试验评估公共交通调整，覆盖${size}条线路。研究按不同指标分别分析，不把政策简单归为成功或失败。`,
        `${amountLine.zh}${directionLine.zh}行程时长与候车间隔是不同指标，不能互相替代。`,
        `${scopeLine.zh}${methodLine.zh}可使用服务不等于实际使用，人数变化也不能单独解释个人动机。`,
        `${outcomeLine.zh}后续决策还需结合持续成本、不同地区条件和政策适用范围。`,
      ],
      facts: { size: fact(size, sizeLine, "试验覆盖的线路数量"), amount: fact(amount, amountLine.evidence, "调整后的平均单程分钟数"), direction: fact(interval === null ? null : interval < 20 ? "increase" : "decrease", directionLine.evidence, "班车发车频率的变化方向"), scope: fact(["all", "restricted", null][variant] as FactValue, scopeLine.evidence, "免费乘车是否覆盖所有居民"), method: fact(["primary", null, "secondary"][variant] as FactValue, methodLine.evidence, "乘客数量是否使用自动计数器统计"), outcome: fact([null, true, false][variant], outcomeLine.evidence, "员工是否因试验获得额外报酬") },
      statements: { amount: "The average journey after the change took less than twenty minutes.", notAmount: "The average journey after the change was not shorter than twenty minutes.", direction: "Buses arrived more frequently during the trial than before it.", scope: "Every resident was eligible for free travel during the pilot.", method: "The evaluation used automatic passenger counts rather than a questionnaire.", outcome: "Staff received additional pay for work on the pilot." }, sizeStatement: (number) => `The trial included ${number} routes.`,
    };
  }
  if (topic === "learning") {
    const amount = [45, 75, null][variant], attendance = [60, 20, null][variant];
    const sizeLine = `The programme operated through ${en(size)} study groups.`;
    const amountLine = factLine(amount, [amount === null ? "" : `A usual session lasted ${en(amount)} minutes.`, amount === null ? "" : `每次通常持续${amount}分钟。`],
      ["Participants worked through examples in pairs before sharing their ideas.", "参与者先两人一组练习例子，然后分享想法。"], "Attendance describes participation, while a useful assessment of progress requires another method.", seed, "amount");
    const directionLine = factLine(attendance, [attendance === null ? "" : `Regular attendance ${attendance > 40 ? "rose" : "fell"} from forty participants to ${en(attendance)} participants.`, attendance === null ? "" : `固定参加人数从40人${attendance > 40 ? "增至" : "减至"}${attendance}人。`],
      ["The library used a noticeboard to announce future group activities.", "图书馆用公告栏发布接下来的小组活动。"], "Attendance describes participation, while a useful assessment of progress requires another method.", seed, "direction");
    const scopeLine = factLine(["all", "restricted", null][variant] as FactValue,
      [["Every resident could enrol, whether or not they already held a library card.", "Enrolment was restricted to existing library members; other residents could not join this programme.", ""][variant], ["所有居民均可报名，不要求已有借阅卡。", "只有现有图书馆会员可报名，其他居民不能参加该项目。", ""][variant]],
      ["The library displayed programme notices near its entrance.", "图书馆在入口附近张贴了项目通知。"], "These details matter when interpreting comments from participants.", seed, "scope");
    const methodLine = factLine(["primary", null, "secondary"][variant] as FactValue,
      [["The evaluation gathered feedback through a written questionnaire rather than interviews.", "", "The evaluation gathered feedback through interviews, without using a written questionnaire."][variant], ["反馈通过书面问卷收集，而非访谈。", "", "反馈通过访谈收集，没有使用书面问卷。"][variant]],
      ["The organisers kept examples of tasks for a later planning meeting.", "组织者保留了部分任务样例，供之后的规划会议使用。"], "Feedback can identify a problem or suggest a useful change, but the way it is collected affects what can reasonably be concluded.", seed, "method");
    const outcomeLine = factLine([null, true, false][variant],
      [["", "Participants' examination scores were higher after the programme than before it.", "Participants' examination scores were unchanged after the programme."][variant], ["", "参与者项目后的考试成绩高于此前。", "参与者项目后的考试成绩没有变化。"][variant]],
      ["Participants prepared short explanations of skills they had practised.", "参与者为已经练习的技能准备了简短说明。"], "The final analysis also considered staff time and the continued availability of suitable materials.", seed, "outcome");
    return { topic, title: "社区学习项目：参与、方法与效果", amountThreshold: 60,
      paragraphs: [
        `A community library introduced a programme for adults who wanted a regular place to practise new skills. ${sizeLine} The organisers provided shared resources and asked each group to choose a practical task, such as comparing information or explaining a process. Their approach was intended to encourage independent learning while allowing people to ask questions. An evaluation was planned from the start, so that the library could distinguish evidence about participation from claims about learning.`,
        `${amountLine.text} ${directionLine.text} The organisers did not treat the number of people present as a direct measure of what they had learned. Attendance describes participation, while a useful assessment of progress requires another method. For example, a person may attend regularly but still find it difficult to apply a skill in a different context. The report discussed these limits before presenting any conclusion about the benefit of the programme.`,
        `${scopeLine.text} ${methodLine.text} These details matter when interpreting comments from participants. A policy covering a narrow group cannot automatically represent the preferences of the whole community. Feedback can identify a problem or suggest a useful change, but the way it is collected affects what can reasonably be concluded. The library therefore asked readers to consider both the scope of enrolment and the source of each observation.`,
        `${outcomeLine.text} The final analysis also considered staff time and the continued availability of suitable materials. It recommended reviewing separate indicators instead of combining them into a single attractive number. The organisers wanted a programme that could be sustained, rather than a brief increase in activity followed by a shortage of support. Future changes were to be judged against the stated purpose and the evidence available for each part of that purpose.`,
      ], translation: [
        `社区图书馆通过${size}个学习小组组织成人实践活动，提供共享资源，并从开始就计划评估。参与程度与学习结果需要分别看待。`,
        `${amountLine.zh}${directionLine.zh}出席不是能力本身的直接指标，技能迁移需要另行检查。`,
        `${scopeLine.zh}${methodLine.zh}应考虑覆盖范围与取样方法。`,
        `${outcomeLine.zh}长期决策还要考虑工作人员时间、材料与支持能力，不能合并所有指标得出过度简单的结论。`,
      ], facts: { size: fact(size, sizeLine, "学习小组数量"), amount: fact(amount, amountLine.evidence, "通常一次活动持续的分钟数"), direction: fact(attendance === null ? null : attendance > 40 ? "increase" : "decrease", directionLine.evidence, "固定出席人数的变化方向"), scope: fact(["all", "restricted", null][variant] as FactValue, scopeLine.evidence, "报名资格是否覆盖所有居民"), method: fact(["primary", null, "secondary"][variant] as FactValue, methodLine.evidence, "反馈是否通过书面问卷收集"), outcome: fact([null, true, false][variant], outcomeLine.evidence, "参与者项目后的考试分数是否提高") },
      statements: { amount: "A usual session lasted less than sixty minutes.", notAmount: "A usual session did not last less than sixty minutes.", direction: "More people attended regularly at the end than at the beginning.", scope: "All residents were eligible to enrol in the programme.", method: "The evaluation used a written questionnaire instead of interviews.", outcome: "Participants obtained higher examination scores after the programme." }, sizeStatement: (number) => `The programme included ${number} study groups.`,
    };
  }
  const amount = [8, 12, null][variant], water = [300, 100, null][variant];
  const sizeLine = `The monitoring work was carried out by ${en(size)} teams.`;
  const amountLine = factLine(amount, [amount === null ? "" : `The shaded surface was ${en(amount)} degrees cooler than the exposed surface.`, amount === null ? "" : `阴影地表比暴晒地表低${amount}度。`],
    ["The project included places where people waited outdoors during the afternoon.", "项目涉及人们下午在户外等候的地点。"], "The team kept cooling and resource use as separate indicators.", seed, "amount");
  const directionLine = factLine(water, [water === null ? "" : `Daily water use ${water > 200 ? "increased" : "decreased"} from two hundred litres at the start to ${water} litres in summer.`, water === null ? "" : `每日用水由起初200升${water > 200 ? "增至" : "减至"}夏季${water}升。`],
    ["Garden staff checked the planting beds during routine visits.", "园艺人员在日常巡视时检查种植区域。"], "The team kept cooling and resource use as separate indicators.", seed, "direction");
  const scopeLine = factLine(["all", "restricted", null][variant] as FactValue,
    [["Monitoring covered every neighbourhood in the city.", "Monitoring was limited to the central district; outer neighbourhoods were excluded.", ""][variant], ["监测覆盖全市每个社区。", "仅监测中心区，外部社区被排除。", ""][variant]],
    ["Local maps were used to discuss access to public spaces.", "团队利用本地地图讨论公共空间的通达情况。"], "Both the location and the research method affected the scope of the conclusions.", seed, "scope");
  const methodLine = factLine(["primary", null, "secondary"][variant] as FactValue,
    [["Measurements came from fixed sensors rather than visits with hand-held devices.", "", "Measurements came from visits with hand-held devices, not fixed sensors."][variant], ["数据来自固定传感器，而非携带设备到访测量。", "", "数据来自手持设备到访测量，而非固定传感器。"][variant]],
    ["The team marked observation points on a shared site plan.", "团队在共同使用的场地平面图上标出了观察点。"], "The analysis therefore separated what had actually been measured from the conditions under which a similar result might be expected elsewhere.", seed, "method");
  const outcomeLine = factLine([null, true, false][variant],
    [["", "Hospital visits by residents declined during the project.", "Hospital visits by residents did not decline during the project."][variant], ["", "项目期间居民就医次数下降。", "项目期间居民就医次数没有下降。"][variant]],
    ["Residents discussed which outdoor places they used most often.", "居民讨论了自己最常使用的户外地点。"], "The final discussion considered the resources required for continued care and the need to repeat measurements in different weather.", seed, "outcome");
  return { topic, title: "城市降温研究：测量与适用范围", amountThreshold: 10,
    paragraphs: [
      `An urban research project examined whether planting and shade could help residents during hot weather. ${sizeLine} The researchers wanted an assessment that distinguished surface conditions from the heat experienced by people. Their approach began with a practical question about where an intervention might provide a benefit, rather than an assumption that any green space would have the same effect. This helped them choose measures relevant to the policy being considered.`,
      `${amountLine.text} ${directionLine.text} The team kept cooling and resource use as separate indicators. A useful design may need continuing maintenance, and an attractive temperature reading does not remove that requirement. Equally, a change in water use does not by itself show how much protection a pedestrian received. The report explained why these measures needed to be interpreted together without treating them as interchangeable evidence.`,
      `${scopeLine.text} ${methodLine.text} Both the location and the research method affected the scope of the conclusions. Observations from one part of a city do not automatically describe another part with different buildings or patterns of activity. The analysis therefore separated what had actually been measured from the conditions under which a similar result might be expected elsewhere. Readers were asked to check the stated coverage before applying the findings to a new context.`,
      `${outcomeLine.text} The final discussion considered the resources required for continued care and the need to repeat measurements in different weather. It warned against treating one result as a universal promise. The researchers recommended comparing physical conditions, practical costs and the needs of residents explicitly. Future decisions were to consider each question separately, using suitable information and the practical context of the project.`,
    ], translation: [
      `城市项目由${size}个团队开展监测，关注树木和遮阴的降温作用。研究区分地表条件与人的热暴露，先明确政策问题再选择指标。`,
      `${amountLine.zh}${directionLine.zh}降温和资源投入是不同指标，不能互相替代。`,
      `${scopeLine.zh}${methodLine.zh}推论要限制在研究范围和方法支持的程度。`,
      `${outcomeLine.zh}后续还需不同天气下重复监测，并分别考虑各个问题、可用信息和项目的实际条件。`,
    ], facts: { size: fact(size, sizeLine, "开展监测的团队数量"), amount: fact(amount, amountLine.evidence, "阴影与暴晒地表的温差"), direction: fact(water === null ? null : water > 200 ? "increase" : "decrease", directionLine.evidence, "项目夏季用水相对起初的变化方向"), scope: fact(["all", "restricted", null][variant] as FactValue, scopeLine.evidence, "监测是否覆盖所有社区"), method: fact(["primary", null, "secondary"][variant] as FactValue, methodLine.evidence, "是否使用固定传感器而非手持设备到访测量"), outcome: fact([null, true, false][variant], outcomeLine.evidence, "项目期间居民就医次数是否下降") },
    statements: { amount: "The difference between shaded and exposed surfaces was below ten degrees.", notAmount: "The difference between shaded and exposed surfaces was not below ten degrees.", direction: "The project used more water in summer than at the start.", scope: "Every neighbourhood was included in the monitoring.", method: "The evaluation used stationary sensors rather than visits with hand-held instruments.", outcome: "Hospital visits by residents fell during the project." }, sizeStatement: (number) => `The monitoring involved ${number} teams.`,
  };
}
const oppositeStatements: Record<TopicId, Record<"direction" | "scope" | "method" | "outcome", string>> = {
  transport: { direction: "Buses arrived less frequently during the trial than before it.", scope: "Some residents were not eligible for free travel during the pilot.", method: "The evaluation used a questionnaire instead of automatic passenger counts.", outcome: "Staff did not receive additional pay for work on the pilot." },
  learning: { direction: "Fewer people attended regularly at the end than at the beginning.", scope: "Some residents were not eligible to enrol in the programme.", method: "The evaluation used interviews instead of a written questionnaire.", outcome: "Participants did not obtain higher examination scores after the programme." },
  cooling: { direction: "The project used less water in summer than at the start.", scope: "Some neighbourhoods were not included in the monitoring.", method: "The evaluation used visits with hand-held instruments rather than stationary sensors.", outcome: "Hospital visits by residents did not fall during the project." },
};
/** One question per independent fact. Candidate selection may change phrasing,
 * comparison or polarity, but never changes the authored report or its facts. */
export function selectControlledQuestions(report: ControlledReport, seed: number): ControlledQuestion[] {
  const alternatives = oppositeStatements[report.topic];
  const groups: ControlledQuestion[][] = [
    [{ fact: "amount", predicate: { op: "lt", value: report.amountThreshold }, statement: report.statements.amount }, { fact: "amount", predicate: { op: "gte", value: report.amountThreshold }, statement: report.statements.notAmount }],
    [{ fact: "direction", predicate: { op: "eq", value: "increase" }, statement: report.statements.direction }, { fact: "direction", predicate: { op: "eq", value: "decrease" }, statement: alternatives.direction }],
    [{ fact: "scope", predicate: { op: "eq", value: "all" }, statement: report.statements.scope }, { fact: "scope", predicate: { op: "eq", value: "restricted" }, statement: alternatives.scope }],
    [{ fact: "method", predicate: { op: "eq", value: "primary" }, statement: report.statements.method }, { fact: "method", predicate: { op: "eq", value: "secondary" }, statement: alternatives.method }],
    [{ fact: "outcome", predicate: { op: "eq", value: true }, statement: report.statements.outcome }, { fact: "outcome", predicate: { op: "eq", value: false }, statement: alternatives.outcome }],
    [3, 4, 5, 6].map((number) => ({ fact: "size", predicate: { op: "eq", value: number }, statement: report.sizeStatement(number) })),
  ];
  const selected = groups.map((group) => shuffle(group, seed ^ textSeed(group[0].fact))[0]);
  for (const wanted of ["TRUE", "FALSE"] as const) {
    const answers = selected.map((claim) => evaluateClaim(report.facts[claim.fact], claim.predicate));
    if (answers.includes(wanted)) continue;
    const index = shuffle([0, 1, 2, 3, 4, 5], seed ^ textSeed(wanted)).find((index) => {
      const answer = answers[index];
      return answer !== "NOT GIVEN" && answers.filter((value) => value === answer).length > 1
        && groups[index].some((claim) => evaluateClaim(report.facts[claim.fact], claim.predicate) === wanted);
    });
    if (index === undefined) throw new Error("受控阅读缺少可用的独立判断题。");
    selected[index] = shuffle(groups[index], seed ^ textSeed(wanted)).find((claim) => evaluateClaim(report.facts[claim.fact], claim.predicate) === wanted)!;
  }
  return shuffle(selected, seed ^ 0x9e3779b9);
}
export function renderControlledReading(report: ControlledReport, seed: number): ReadingBody {
  const claims = selectControlledQuestions(report, seed);
  const passage = report.paragraphs.map((paragraph) => paragraph.trim().replace(/\s+/g, " ")).join("\n\n");
  const questions = claims.map((claim) => {
    const evidence = report.facts[claim.fact], a = evaluateClaim(evidence, claim.predicate);
    if (!passage.includes(evidence.evidence)) throw new Error("题目证据必须来自本篇文章。");
    const expected = claim.predicate.value;
    const meaning = typeof expected === "number" ? `等于${expected}` : expected === "increase" ? "数量或频率上升" : expected === "decrease" ? "数量或频率下降" : expected === "all" ? "覆盖全部对象" : expected === "restricted" ? "至少有部分对象被排除" : typeof expected === "boolean" ? expected ? "该结果发生" : "该结果没有发生" : "采用题干描述的方法";
    const comparison = claim.predicate.op === "lt" ? `小于${claim.predicate.value}` : claim.predicate.op === "gte" ? `不小于${claim.predicate.value}` : meaning;
    const explanation = a === "NOT GIVEN" ? `原文未提供“${evidence.description}”所需的信息；引文只涉及相关背景，无法确定题干条件是否成立。` : `核对“${evidence.description}”：原文事实${typeof evidence.value === "number" ? `为${evidence.value}` : "见引文"}，题干要求${comparison}，${a === "TRUE" ? "与事实一致" : "与事实冲突"}。`;
    return { q: claim.statement, a, why: `原文：“${evidence.evidence}” ${explanation}` };
  });
  return { title: report.title, passage, zh: report.translation.join("\n\n"), questions };
}
