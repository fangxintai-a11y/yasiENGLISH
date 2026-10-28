import { ArrowRight, CalendarClock, Flame, Keyboard, Mic, Sparkles, Sunrise } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { prefetch, useAtlas, useEntry } from "../atlas/context";
import { go, openWord } from "../lib/router";
import { cue } from "../lib/sound";
import { hashSeed } from "../lib/text";
import { fadingTonight, lastNightWords, parseKey, skillLevels, type ExamPlan, type Phase } from "../ielts/exam";
import { useTags } from "../ielts/tags";
import { buildSession, masteredCount, todayPlan } from "../store/session";
import { isMastered } from "../store/srs";
import { dayKey, store, useStore } from "../store/store";
import { Galaxy } from "../galaxy/Galaxy";
import { Highlight, Pronounce } from "../ui/EntryView";
import { Illustration } from "../ui/Illustration";
import { OfflineNudge } from "../ui/OfflineNudge";
import { Ring } from "../ui/Ring";
import { ExamFields } from "../ui/ExamSetup";
import { Sheet } from "../ui/Sheet";

const BRAND = `${import.meta.env.BASE_URL}brand`;

function greeting(h: number) {
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function streakOf(days: Record<string, { r: number }>) {
  let n = 0;
  const d = new Date();
  if (!(days[dayKey(d)]?.r > 0)) d.setDate(d.getDate() - 1);
  while (days[dayKey(d)]?.r > 0) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function Today() {
  const atlas = useAtlas();
  const tags = useTags();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const [setup, setSetup] = useState(false);
  const plan = useMemo(() => todayPlan(atlas, progress, settings), [atlas, progress, settings, tags]); // eslint-disable-line react-hooks/exhaustive-deps
  // Warm the first cards of today's journey so the session opens instantly.
  const firstIds = [...plan.due.slice(0, 4).map((k) => parseKey(k).id), ...plan.fresh.slice(0, 6)].join(",");
  useEffect(() => {
    const ids = firstIds.split(",").filter(Boolean);
    const t = window.setTimeout(() => void prefetch(atlas, ids), 800);
    return () => window.clearTimeout(t);
  }, [atlas, firstIds]);
  const now = new Date();
  const today = progress.days[dayKey()];
  const streak = streakOf(progress.days);
  const active = progress.session && !progress.session.finished && !progress.session.practice ? progress.session : null;
  const total = plan.due.length + plan.fresh.length + plan.unlock.length;
  const goal = plan.fresh.length + (today?.n ?? 0) + Math.min(plan.due.length, 60);
  const doneToday = today?.r ?? 0;
  const byTrack = (t: string) => plan.due.filter((k) => parseKey(k).track === t).length;
  const skillDue = byTrack("l") + byTrack("p") + plan.unlock.length;

  const start = (opts?: { reviewOnly?: boolean; extra?: number; ids?: string[]; label?: string }) => {
    if (!active) {
      const s = buildSession(atlas, progress, settings, {
        extraNew: opts?.extra,
        reviewOnly: opts?.reviewOnly,
        ids: opts?.ids,
        label: opts?.label,
      });
      if (!s.steps.length) return;
      store.progress((p) => ({ ...p, session: s }));
    }
    if (settings.sfx) void cue("start");
    go({ page: "learn" });
  };

  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const k = dayKey(d);
    return { k, label: "日一二三四五六"[d.getDay()], v: progress.days[k]?.r ?? 0, today: i === 6 };
  });

  const learned = Object.keys(progress.cards).length;
  const mastered = masteredCount(progress);
  const teaser = (active ? active.newIds : plan.fresh).slice(0, 5).map((id) => atlas.byId.get(id)!).filter(Boolean);
  const evening = now.getHours() >= 19;

  return (
    <div className="page today">
      <header className="greet">
        <p className="eyebrow">
          {now.getMonth() + 1}月{now.getDate()}日 · 星期{"日一二三四五六"[now.getDay()]}
        </p>
        <h1 className="display">{greeting(now.getHours())}，考鸭。</h1>
      </header>

      <ExamHero plan={plan.plan} onSetup={() => setSetup(true)} />

      <OfflineNudge />

      <section className={`journey ${total === 0 && !active ? "is-clear" : ""}`}>
        <img className="journey-art" src={`${BRAND}/hero.webp`} alt="" fetchPriority="high" />
        <div className="journey-body">
          {active ? (
            <>
              <p className="eyebrow eyebrow-light">旅程进行中</p>
              <h2>
                还剩 <b>{active.steps.length - active.index}</b> 步
              </h2>
              <p className="journey-lede">进度已保存，随时接着走。</p>
            </>
          ) : total > 0 ? (
            <>
              <p className="eyebrow eyebrow-light">{plan.plan.phase === "sprint" ? "冲刺期 · 今日只复习" : "今日旅程"}</p>
              <h2>
                {plan.due.length > 0 && (
                  <>
                    复习 <b>{plan.due.length}</b>
                  </>
                )}
                {plan.due.length > 0 && plan.fresh.length > 0 && <i> · </i>}
                {plan.fresh.length > 0 && (
                  <>
                    新词 <b>{plan.fresh.length}</b>
                  </>
                )}
              </h2>
              <p className="journey-lede">
                约 {plan.minutes} 分钟
                {skillDue > 0 && ` · 含听写 / 产出 ${skillDue} 张`}
                {plan.unlock.length > 0 && `（新解锁 ${plan.unlock.length}）`}。
                {plan.backlog
                  ? ` 积压了 ${plan.deferred} 个低优先级复习：今天先救最要紧的，其余平摊到之后几天，暂停新词。`
                  : evening && plan.fresh.length
                    ? " 睡前学新词，明早回测，睡眠会帮你巩固。"
                    : " 先温故，再知新。"}
              </p>
            </>
          ) : (
            <>
              <p className="eyebrow eyebrow-light">今日已完成</p>
              <h2>今天的星，都亮了。</h2>
              <p className="journey-lede">记忆需要一点留白。想多走一段，也可以。</p>
            </>
          )}
          {teaser.length > 0 && (
            <div className="teaser" aria-label="今天将遇见的新词">
              {teaser.map((w, i) => (
                <Illustration key={w.id} src={atlas.img(w, "thumb")} word={w.word} topic={w.topic} className={`teaser-${i}`} />
              ))}
              <span>今天会遇见它们</span>
            </div>
          )}
          <div className="journey-actions">
            {active || total > 0 ? (
              <button className="btn btn-primary btn-xl" onClick={() => start()}>
                {active ? "继续旅程" : "开始今天的旅程"} <ArrowRight size={20} />
              </button>
            ) : (
              <button className="btn btn-primary btn-xl" onClick={() => start({ extra: 5 })} disabled={plan.plan.phase === "sprint"}>
                再认识 5 个新词 <Sparkles size={18} />
              </button>
            )}
            {!active && plan.due.length > 0 && plan.fresh.length > 0 && (
              <button className="btn btn-glass" onClick={() => start({ reviewOnly: true })}>
                只复习
              </button>
            )}
            {!active && total === 0 && (
              <button className="btn btn-glass" onClick={() => go({ page: "ielts" })}>
                <Keyboard size={18} /> 雅思专项
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="today-grid">
        <ShadowPanel />
        <MorningCheck onStart={(ids) => start({ ids, label: "晨间回测" })} disabled={!!active} />
        <FadingStars onStart={(ids) => start({ ids, label: "救星行动" })} disabled={!!active} />
        <SkillPanel />
        <WordOfDay />

        <section className="panel streak-panel">
          <div className="panel-head">
            <h3 className="eyebrow">这一周</h3>
            <span className={`streak ${streak ? "is-on" : ""}`}>
              <Flame size={16} /> 连续 {streak} 天
            </span>
          </div>
          <div className="streak-body">
            <Ring value={goal ? doneToday / goal : 0} size={112} stroke={8} tone="terra">
              <b>{doneToday}</b>
              <small>今日答题</small>
            </Ring>
            <ol className="week">
              {week.map((d) => (
                <li key={d.k} className={`${d.v ? "is-on" : ""} ${d.today ? "is-today" : ""}`} title={`${d.k}：${d.v} 题`}>
                  <span style={{ "--h": Math.min(1, d.v / 40) } as React.CSSProperties} />
                  <small>{d.label}</small>
                </li>
              ))}
            </ol>
          </div>
          <dl className="mini-stats">
            <div>
              <dt>已点亮</dt>
              <dd>{learned.toLocaleString()}</dd>
            </div>
            <div>
              <dt>已掌握</dt>
              <dd>{mastered.toLocaleString()}</dd>
            </div>
            <div>
              <dt>全部词汇</dt>
              <dd>{atlas.count.toLocaleString()}</dd>
            </div>
          </dl>
        </section>

        <LevelPath />
        <GalaxyPanel learned={learned} total={atlas.count} />
        <Topics />
      </div>

      <Sheet open={setup} onClose={() => setSetup(false)} label="考试计划">
        <div className="setup-sheet">
          <p className="eyebrow">考试计划</p>
          <h2 className="display">从考试那天倒推。</h2>
          <ExamFields />
          <button className="btn btn-primary btn-xl" onClick={() => setSetup(false)}>
            好的 <ArrowRight size={20} />
          </button>
        </div>
      </Sheet>
    </div>
  );
}

const PHASE_NOTE: Record<Phase, string> = {
  free: "",
  learn: "学习期：每天新词 + 复习，考前 7 天进入冲刺。",
  sprint: "冲刺期：不再学新词，复习加密到 95% 记忆率，让记忆在考试当天达到峰值。",
  after: "考试已经过去，愿你考出理想分数。设定下一次考试，计划会重新倒推。",
};

/** Countdown and the forecast: how many target words you will still recall on exam day. */
function ExamHero({ plan, onSetup }: { plan: ExamPlan; onSetup: () => void }) {
  const minutes = useStore((s) => s.settings.dailyMinutes);
  const band = useStore((s) => s.settings.targetBand);
  if (plan.days === null)
    return (
      <section className="exam-hero is-empty">
        <CalendarClock size={26} strokeWidth={1.6} />
        <div>
          <b>还没设定考试日期</b>
          <p className="muted">设定后，计划会从考试那天倒推每天学多少，并算出考试当天你能记住几个词。</p>
        </div>
        <button className="btn btn-primary" onClick={onSetup}>
          设定考试 <ArrowRight size={18} />
        </button>
      </section>
    );
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / Math.max(1, plan.target)) * 100))}%`;
  const short = plan.newPerDay < plan.need;
  return (
    <section className="exam-hero">
      <button className="exam-count" onClick={onSetup} aria-label="修改考试计划">
        <small>距雅思</small>
        <b>{Math.max(0, plan.days)}</b>
        <small>天 · 目标 {band}</small>
      </button>
      <div className="exam-forecast">
        <p className="eyebrow">按计划走，考试当天预计记得</p>
        <p className="forecast-num">
          <b>{plan.forecast.toLocaleString()}</b>
          <span> / {plan.target.toLocaleString()} 个目标词</span>
        </p>
        <div className="forecast-bar" role="img" aria-label={`预计 ${plan.forecast}，若停止复习 ${plan.ifStop}`}>
          <span style={{ width: pct(plan.forecast) }} />
          <em style={{ width: pct(plan.ifStop) }} />
        </div>
        <p className="forecast-legend">
          <i className="lg-plan" /> 按计划 <i className="lg-stop" /> 如果今天起不再复习：只剩 <b>{plan.ifStop.toLocaleString()}</b>
        </p>
        <p className="muted">
          {plan.phase === "learn" && `每天 ${plan.newPerDay} 个新词 · `}
          {PHASE_NOTE[plan.phase]}
        </p>
        {short && plan.phase === "learn" && (
          <p className="warn-text">
            按每天 {minutes} 分钟，考前学不完全部 {plan.remaining.toLocaleString()} 个目标词；每天约 {plan.minutesNeeded} 分钟才够。{" "}
            <button className="link" onClick={onSetup}>
              调整
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

/** Memory curves made visible: these stars dim below the target tonight. */
function FadingStars({ onStart, disabled }: { onStart: (ids: string[]) => void; disabled: boolean }) {
  const progress = useStore((s) => s.progress);
  const fading = useMemo(() => fadingTonight(progress, Date.now()), [progress]);
  const sample = fading.slice(0, 18);
  if (!Object.keys(progress.cards).length) return null;
  return (
    <section className={`panel fading-panel ${fading.length ? "" : "is-calm"}`}>
      <div className="fading-sky" aria-hidden="true">
        {sample.map((id, i) => (
          <i key={id} style={{ "--i": i, "--x": `${(hashSeed(id) % 90) + 5}%`, "--y": `${(hashSeed(id + "y") % 70) + 10}%` } as React.CSSProperties} />
        ))}
      </div>
      <h3 className="eyebrow">遗忘曲线 · 今晚</h3>
      {fading.length ? (
        <>
          <p className="fading-num">
            <b>{fading.length}</b> 颗星今晚会变暗
          </p>
          <p className="muted">它们的记忆率正掉到 {Math.round(store.get().settings.retention * 100)}% 以下。现在复习一次，收益最大。</p>
          <button className="btn btn-terra" onClick={() => onStart(fading.slice(0, 60))} disabled={disabled}>
            先救它们 <ArrowRight size={18} />
          </button>
        </>
      ) : (
        <>
          <p className="fading-num">所有星都亮着</p>
          <p className="muted">今晚没有词会掉到目标记忆率以下。</p>
        </>
      )}
    </section>
  );
}

/** Three memories per word: reading, listening, writing. */
/** 跟读 on the home page: today's count and the way in. */
function ShadowPanel() {
  const shadow = useStore((s) => s.progress.shadow);
  const today = shadow.days[dayKey()] ?? 0;
  return (
    <section className="panel shadow-panel">
      <div className="panel-head">
        <h3 className="eyebrow">今日跟读</h3>
        <span className={`streak ${today ? "is-on" : ""}`}>
          <Mic size={15} /> 今天 {today} 句
        </span>
      </div>
      <p className="shadow-panel-lede">把刚学的词放进句子里说出来：听 → 跟 → 说 → 比，录下自己和原声对比。</p>
      <button className="btn btn-primary" onClick={() => go({ page: "shadow", run: true })}>
        {today ? "再跟 8 句" : "开口跟读 8 句"} <ArrowRight size={18} />
      </button>
    </section>
  );
}

function SkillPanel() {
  const atlas = useAtlas();
  const tags = useTags();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const lv = useMemo(() => skillLevels(atlas, progress, settings, tags, Date.now()), [atlas, progress, settings, tags]);
  const rows = [
    ["阅读识别", "3 秒内认出目标词", lv.reading, "r"],
    ["听力拼写", "王陆语料库词，听到能拼对", lv.listening, "l"],
    ["写作产出", "学术词表 AWL，想到能写出", lv.writing, "p"],
  ] as const;
  return (
    <section className="panel skill-panel">
      <div className="panel-head">
        <h3 className="eyebrow">一个词，三种记忆</h3>
        <button className="link" onClick={() => go({ page: "ielts" })}>
          专项练习
        </button>
      </div>
      <ul className="skill-bars">
        {rows.map(([name, desc, v, t]) => (
          <li key={name} className={`skill-${t}`}>
            <span>
              <b>{name}</b>
              <small>
                {desc} · {v.total.toLocaleString()} 词
              </small>
            </span>
            <i>
              <em style={{ width: `${v.value * 100}%` }} />
            </i>
            <strong>{Math.round(v.value * 100)}%</strong>
          </li>
        ))}
      </ul>
      <p className="muted">百分比 = 这一组词此刻能被想起的平均概率。认识 ≠ 会拼 ≠ 会用，三条记忆曲线分开排程。</p>
    </section>
  );
}

/** Sleep consolidates new words: test last night's words first thing in the morning. */
function MorningCheck({ onStart, disabled }: { onStart: (ids: string[]) => void; disabled: boolean }) {
  const progress = useStore((s) => s.progress);
  const now = new Date();
  const ids = useMemo(() => lastNightWords(progress, Date.now()), [progress]);
  if (now.getHours() < 5 || now.getHours() >= 13 || ids.length < 3) return null;
  return (
    <section className="panel morning-panel">
      <Sunrise size={26} strokeWidth={1.6} />
      <div>
        <h3 className="eyebrow">晨间回测</h3>
        <p>
          昨晚的 <b>{ids.length}</b> 个新词，睡了一觉还记得吗？
        </p>
        <p className="muted">睡眠会巩固睡前学的内容。醒来先测一遍，记得牢的会更牢。</p>
      </div>
      <button className="btn btn-primary" onClick={() => onStart(ids)} disabled={disabled}>
        测一测
      </button>
    </section>
  );
}

function GalaxyPanel({ learned, total }: { learned: number; total: number }) {
  const today = useStore((s) => s.progress.days[dayKey()]);
  const ids = useStore((s) => s.progress.cards);
  const todayIds = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Object.entries(ids)
      .filter(([, c]) => c.seen >= start.getTime())
      .map(([id]) => id);
  }, [ids]);
  void today;
  return (
    <section className="galaxy-panel" onClick={() => go({ page: "atlas", view: "galaxy" })} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && go({ page: "atlas", view: "galaxy" })}>
      <Galaxy mode="mini" highlight={todayIds} />
      <div className="galaxy-panel-copy">
        <p className="eyebrow eyebrow-light">你的词汇星图</p>
        <h3>
          已点亮 <b>{learned.toLocaleString()}</b> 颗星
        </h3>
        <p>{learned ? `还有 ${(total - learned).toLocaleString()} 颗在等你。金色是今天新点亮的。` : `${total.toLocaleString()} 个词是 ${total.toLocaleString()} 颗星。学会一个，就点亮一颗。`}</p>
        <span className="btn btn-glass">
          进入星图 <ArrowRight size={18} />
        </span>
      </div>
    </section>
  );
}

function WordOfDay() {
  const atlas = useAtlas();
  const pick = useMemo(() => {
    const pool = atlas.words.filter((w) => w.cefr >= 2 && w.media & 1);
    const list = pool.length ? pool : atlas.words;
    return list[hashSeed(dayKey()) % list.length];
  }, [atlas]);
  const { entry } = useEntry(pick?.id);
  if (!pick) return null;
  return (
    <section className="panel wotd" onClick={() => openWord(pick.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openWord(pick.id)} aria-label={`今日一词：${pick.word}`}>
      <Illustration src={atlas.img(pick)} word={pick.word} topic={pick.topic} className="wotd-art" />
      <div className="wotd-body">
        <h3 className="eyebrow">今日一词</h3>
        <p className="wotd-word" lang="en">
          {pick.word}
        </p>
        {entry && (
          <div onClick={(e) => e.stopPropagation()}>
            <Pronounce entry={entry} refw={pick} />
          </div>
        )}
        <p className="wotd-zh">{pick.zh}</p>
        {entry?.ex[0] && (
          <p className="wotd-ex" lang="en">
            <Highlight text={entry.ex[0].en} word={entry.w} />
          </p>
        )}
      </div>
    </section>
  );
}

function LevelPath() {
  const atlas = useAtlas();
  const cards = useStore((s) => s.progress.cards);
  const start = useStore((s) => s.settings.startLevel);
  const levels = useMemo(() => {
    const out = atlas.cefr.map((name) => ({ name, total: 0, seen: 0, mastered: 0 }));
    for (const w of atlas.words) {
      const l = out[w.cefr];
      l.total++;
      const c = cards[w.id];
      if (c) {
        l.seen++;
        if (isMastered(c)) l.mastered++;
      }
    }
    return out;
  }, [atlas, cards]);
  const NAMES = ["入门", "基础", "进阶", "中高", "高级", "精通"];
  return (
    <section className="panel path-panel">
      <div className="panel-head">
        <h3 className="eyebrow">学习路线 · 从 A1 到 C2</h3>
        <span className="legend">
          <i className="lg-seen" /> 已学 <i className="lg-done" /> 已掌握
        </span>
      </div>
      <ol className="route">
        {levels.map((l, i) => {
          const seen = l.seen / Math.max(1, l.total);
          const done = l.mastered / Math.max(1, l.total);
          return (
            <li key={l.name} className={`${i === start ? "is-start" : ""} ${l.seen ? "is-on" : ""}`}>
              <button onClick={() => go({ page: "atlas", level: l.name })} aria-label={`${l.name} ${NAMES[i]}，已学 ${l.seen} / ${l.total}`}>
                <span className="station" style={{ "--seen": seen, "--done": done } as React.CSSProperties}>
                  <b>{l.name}</b>
                </span>
                <span className="station-name">{NAMES[i]}</span>
                <span className="station-count">
                  {l.seen}
                  <small>/{l.total}</small>
                </span>
                {i === start && <span className="station-flag">起点</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Topics() {
  const atlas = useAtlas();
  const counts = useMemo(() => {
    const c = new Array(atlas.topics.length).fill(0);
    atlas.words.forEach((w) => c[w.topic]++);
    return c;
  }, [atlas]);
  return (
    <section className="topics-panel">
      <div className="panel-head">
        <h3 className="eyebrow">按雅思话题探索</h3>
        <button className="link" onClick={() => go({ page: "atlas" })}>
          打开图鉴
        </button>
      </div>
      <ul className="topic-tiles">
        {atlas.topics.map(([key, name], i) => (
          <li key={key}>
            <button onClick={() => go({ page: "atlas", topic: key })}>
              <img src={`${BRAND}/topic-${key}.webp`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
              <span>
                <b>{name}</b>
                <small>{counts[i]} 个词</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
