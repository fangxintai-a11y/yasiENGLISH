import { ArrowRight, BookOpenText, CalendarClock, Headphones, PenLine, Sparkles, Swords, Waypoints, Wand2 } from "lucide-react";
import { useMemo } from "react";
import { useAtlas } from "../atlas/context";
import { allCards, examPlan, parseKey, SPRINT_DAYS } from "../ielts/exam";
import { useTags } from "../ielts/tags";
import { go, type Route } from "../lib/router";
import { store, useStore, type Step } from "../store/store";
import { ExamFields } from "../ui/ExamSetup";
import { toast } from "../ui/Toast";
import { ConfuseTab } from "./ielts/ConfuseTab";
import { ImportTab } from "./ielts/ImportTab";
import { ParaphraseTab } from "./ielts/ParaphraseTab";
import { ReadingTab } from "./ielts/ReadingTab";
import { SpellTab } from "./ielts/SpellTab";
import { WritingTab } from "./ielts/WritingTab";

const TABS = [
  ["plan", "考试计划", CalendarClock],
  ["spell", "拼写诊断", Headphones],
  ["para", "同义替换", Waypoints],
  ["confuse", "易混词", Swords],
  ["import", "文章取词", BookOpenText],
  ["reading", "AI 错词阅读", Sparkles],
  ["writing", "AI 造句批改", PenLine],
] as const;

export function Ielts({ route }: { route: Extract<Route, { page: "ielts" }> }) {
  const tab = TABS.some(([k]) => k === route.tab) ? route.tab! : "plan";
  return (
    <div className="page ielts">
      <header className="page-head">
        <p className="eyebrow">雅思专项 · IELTS Lab</p>
        <h1 className="display">按雅思的考法，练每一个词。</h1>
        <p className="lede">听力要拼对、阅读要认出改写、写作要用得出。这里是每一种记忆的专项训练。</p>
      </header>
      <nav className="lab-tabs" aria-label="专项">
        {TABS.map(([k, label, Icon]) => (
          <a key={k} href={`#/ielts?tab=${k}`} className={tab === k ? "is-on" : ""} aria-current={tab === k ? "page" : undefined}>
            <Icon size={17} strokeWidth={1.8} /> {label}
          </a>
        ))}
      </nav>
      {tab === "plan" && <PlanTab />}
      {tab === "spell" && <SpellTab />}
      {tab === "para" && <ParaphraseTab />}
      {tab === "confuse" && <ConfuseTab />}
      {tab === "import" && <ImportTab />}
      {tab === "reading" && <ReadingTab />}
      {tab === "writing" && <WritingTab />}
    </div>
  );
}

/** Start a drill round that never changes memory or daily stats. */
export function startPractice(steps: Step[], label: string) {
  if (!steps.length) {
    toast("这里暂时没有可练的词。", "warn");
    return;
  }
  const active = store.get().progress.session;
  if (active && !active.finished && !active.practice && !confirm("今天的旅程还没走完。先做专项练习吗？已答的题不会丢，剩下的复习会重新排。")) return;
  const t = Date.now();
  store.progress((p) => ({
    ...p,
    session: { id: `x${t}`, started: t, steps, index: 0, graded: {}, newIds: [], reviewIds: [], skillKeys: [], ms: {}, label, practice: true },
  }));
  go({ page: "learn" });
}

const DAY = 86400000;

function PlanTab() {
  const atlas = useAtlas();
  const tags = useTags();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const now = Date.now();
  const plan = useMemo(() => examPlan(atlas, progress, settings, tags, now), [atlas, progress, settings, tags]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useMemo(() => {
    const days = Array.from({ length: 14 }, () => ({ r: 0, l: 0, p: 0 }));
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    for (const [key, c] of allCards(progress)) {
      const d = Math.max(0, Math.floor((c.due - start.getTime()) / DAY));
      if (d < 14) days[d][parseKey(key).track]++;
    }
    return days;
  }, [progress]); // eslint-disable-line react-hooks/exhaustive-deps
  const capacity = Math.round((settings.dailyMinutes * 60) / plan.pace.review);
  const maxLoad = Math.max(capacity, ...load.map((d) => d.r + d.l + d.p), 1);

  return (
    <div className="lab-grid">
      <section className="panel">
        <h3 className="eyebrow">计划参数</h3>
        <ExamFields />
      </section>

      <section className="panel plan-numbers">
        <h3 className="eyebrow">引擎算出来的</h3>
        <dl>
          <div>
            <dt>目标词</dt>
            <dd>{plan.target.toLocaleString()}</dd>
            <small>目标 {settings.targetBand} 分对应的难度 + 听力高频词 + 学术词</small>
          </div>
          <div>
            <dt>已遇见</dt>
            <dd>{plan.met.toLocaleString()}</dd>
            <small>还剩 {plan.remaining.toLocaleString()} 个</small>
          </div>
          <div>
            <dt>每天新词</dt>
            <dd>{plan.phase === "learn" || plan.phase === "free" ? plan.newPerDay : 0}</dd>
            <small>{plan.days === null ? "自由节奏（设定考试日期后自动倒推）" : `全部学完需每天 ${plan.need} 个，约 ${plan.minutesNeeded} 分钟`}</small>
          </div>
          <div>
            <dt>你的速度</dt>
            <dd>
              {plan.pace.review.toFixed(1)}
              <small>秒/题</small>
            </dd>
            <small>从你最近 3 周的答题时间算出，越用越准</small>
          </div>
          <div>
            <dt>考试当天预计记得</dt>
            <dd>{plan.forecast.toLocaleString()}</dd>
            <small>若从今天起不复习：{plan.ifStop.toLocaleString()}</small>
          </div>
        </dl>
      </section>

      {plan.days !== null && plan.days >= 0 && (
        <section className="panel span-2">
          <h3 className="eyebrow">从今天到考试</h3>
          <div className="timeline">
            <span className="tl-learn" style={{ flex: Math.max(0, plan.days - SPRINT_DAYS) }}>
              学习期 · {Math.max(0, plan.days - SPRINT_DAYS)} 天
            </span>
            <span className="tl-sprint" style={{ flex: Math.min(SPRINT_DAYS, plan.days) || 1 }}>
              冲刺 · {Math.min(SPRINT_DAYS, plan.days)} 天
            </span>
            <b className="tl-exam">考试</b>
          </div>
          <p className="muted">冲刺期不学新词；最后 14 天复习目标记忆率自动升到 95%，间隔变短，让记忆在考试当天到达峰值。</p>
        </section>
      )}

      <section className="panel span-2">
        <h3 className="eyebrow">未来 14 天的复习量</h3>
        <ol className="load-chart" style={{ "--capn": capacity / maxLoad } as React.CSSProperties}>
          {load.map((d, i) => (
            <li key={i} title={`识别 ${d.r} · 听写 ${d.l} · 产出 ${d.p}`}>
              <span className="bar">
                <em className="lc-p" style={{ height: `${(d.p / maxLoad) * 100}%` }} />
                <em className="lc-l" style={{ height: `${(d.l / maxLoad) * 100}%` }} />
                <em className="lc-r" style={{ height: `${(d.r / maxLoad) * 100}%` }} />
              </span>
              <small>{i === 0 ? "今天" : i === 1 ? "明天" : `+${i}`}</small>
            </li>
          ))}
        </ol>
        <p className="forecast-legend">
          <i className="lg-r" /> 识别 <i className="lg-l" /> 听写 <i className="lg-p" /> 产出 <i className="lg-cap" /> 每天 {settings.dailyMinutes} 分钟能完成约 {capacity} 题
        </p>
        <p className="muted">超出虚线的部分不会堆到你头上：引擎按「对考试的价值 × 遗忘风险」排序，先做最要紧的，其余平摊到后几天。</p>
      </section>

      <section className="panel span-2 how">
        <h3 className="eyebrow">它是怎么算的</h3>
        <ol>
          <li>
            <b>记忆模型：</b>FSRS（Anki 同款开源算法）给每张卡算出稳定度 S，任意时刻的回忆概率 R(t) = 遗忘曲线(t, S)。
          </li>
          <li>
            <b>考试当天预测：</b>到考前还会复习的卡，按「两次复习之间的平均回忆率」计；考后才到期的卡，直接用遗忘曲线算考试那天的 R；再加上计划中还会学的新词。
          </li>
          <li>
            <b>每天学多少：</b>剩余目标词 ÷ 冲刺前的天数；再用你的真实答题速度和每个新词未来带来的复习量，检查能不能塞进每天的分钟数。
          </li>
          <li>
            <b>评分：</b>不让你自评。答错 = 重来；答对但超时、用了提示或重播 = 困难；否则 = 良好。阅读识别的时限是 3 秒。
          </li>
        </ol>
        <button className="btn btn-ghost" onClick={() => go({ page: "today" })}>
          回到今日 <ArrowRight size={18} />
        </button>
      </section>

      <section className="panel span-2 lab-ai-hint">
        <Wand2 size={22} strokeWidth={1.6} />
        <p className="muted">AI 错词阅读和造句批改需要你自己的 Claude API Key，在「我的 → AI 助教」里填写；Key 只保存在这台设备的浏览器里。</p>
      </section>
    </div>
  );
}
