import { Download, KeyRound, RotateCcw, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAtlas } from "../atlas/context";
import { getKey, setKey } from "../ielts/aikey";
import { allCards } from "../ielts/exam";
import { isMastered } from "../store/srs";
import { AI_MODELS, dayKey, exportBackup, importBackup, resetProgress, store, useStore, type Settings } from "../store/store";
import { ExamFields } from "../ui/ExamSetup";
import { OfflinePanel } from "../ui/OfflinePanel";
import { toast } from "../ui/Toast";
import { streakOf } from "./Today";

export function Me({ privateAvailable }: { privateAvailable: boolean }) {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const saveError = useStore((s) => s.saveError);
  const file = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const cards = allCards(progress).map(([, c]) => c);
    const days = Object.values(progress.days);
    const r = days.reduce((n, d) => n + d.r, 0);
    const c = days.reduce((n, d) => n + d.c, 0);
    const t = days.reduce((n, d) => n + d.t, 0);
    const now = Date.now();
    const forecast = Array.from({ length: 7 }, (_, i) => {
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      end.setDate(end.getDate() + i);
      const start = new Date(end);
      start.setHours(0, 0, 0, 0);
      return cards.filter((x) => (i === 0 ? x.due <= end.getTime() : x.due >= start.getTime() && x.due <= end.getTime())).length;
    });
    void now;
    const words = Object.values(progress.cards);
    return { learned: words.length, mastered: words.filter(isMastered).length, reviews: r, accuracy: r ? Math.round((c / r) * 100) : 0, minutes: Math.round(t / 60), forecast };
  }, [progress]);

  const set = (patch: Partial<Settings>) => store.settings(patch);
  const download = () => {
    const blob = new Blob([exportBackup()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `band-galaxy-backup-${dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const restore = async (f: File) => {
    if (f.size > 30 * 1024 * 1024) return toast("文件太大，不像是学习备份。", "warn");
    const r = importBackup(await f.text());
    toast(r.ok ? `已恢复 ${r.cards} 个词的记忆` : r.error, r.ok ? "ok" : "warn");
  };
  const maxF = Math.max(1, ...stats.forecast);

  return (
    <div className="page me">
      <header className="page-head">
        <p className="eyebrow">我的</p>
        <h1 className="display">你的星空</h1>
      </header>

      <section className="stat-strip">
        <div>
          <dt>连续学习</dt>
          <dd>
            {streakOf(progress.days)}
            <small>天</small>
          </dd>
        </div>
        <div>
          <dt>已点亮</dt>
          <dd>{stats.learned.toLocaleString()}</dd>
        </div>
        <div>
          <dt>长期记住</dt>
          <dd>{stats.mastered.toLocaleString()}</dd>
        </div>
        <div>
          <dt>首次正确率</dt>
          <dd>
            {stats.accuracy}
            <small>%</small>
          </dd>
        </div>
        <div>
          <dt>学习时长</dt>
          <dd>
            {stats.minutes}
            <small>分钟</small>
          </dd>
        </div>
      </section>

      <div className="me-grid">
        <section className="panel">
          <h3 className="eyebrow">过去 20 周</h3>
          <Heatmap days={progress.days} />
          <p className="muted">一格是一天，颜色越深，那天答得越多。「长期记住」指记忆稳定度超过 21 天。</p>
        </section>

        <section className="panel">
          <h3 className="eyebrow">未来 7 天的复习量</h3>
          <ol className="forecast">
            {stats.forecast.map((n, i) => (
              <li key={i}>
                <span style={{ height: `${(n / maxF) * 100}%` }} />
                <b>{n}</b>
                <small>{i === 0 ? "今天" : i === 1 ? "明天" : `+${i}`}</small>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel settings">
          <h3 className="eyebrow">考试计划</h3>
          <ExamFields />
          {progress.placement && (
            <p className="muted">
              摸底结果：约认识 {progress.placement.estimate.toLocaleString()} 个词，{progress.placement.seeded.toLocaleString()} 个已会的词在分散抽查中。
            </p>
          )}
          <button className="btn btn-ghost" onClick={() => store.settings({ onboarded: false })}>
            重新摸底
          </button>
        </section>

        <AiPanel />

        <section className="panel settings">
          <h3 className="eyebrow">学习设置</h3>
          <Field label="每日新词" hint="只在没设考试日期时生效；设定后由计划自动倒推。">
            <div className="segmented">
              {[5, 10, 15, 20, 30].map((n) => (
                <button key={n} className={settings.dailyNew === n ? "is-on" : ""} onClick={() => set({ dailyNew: n })}>
                  {n}
                </button>
              ))}
            </div>
          </Field>
          <Field label="从哪个难度开始" hint="跳过已经熟悉的低级别词。">
            <div className="segmented">
              {atlas.cefr.map((l, i) => (
                <button key={l} className={settings.startLevel === i ? "is-on" : ""} onClick={() => set({ startLevel: i })}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label="目标记忆率" hint="越高复习越频繁。90% 是大多数人的甜点。">
            <div className="segmented">
              {[0.85, 0.9, 0.95].map((n) => (
                <button key={n} className={settings.retention === n ? "is-on" : ""} onClick={() => set({ retention: n })}>
                  {Math.round(n * 100)}%
                </button>
              ))}
            </div>
          </Field>
          <Field label="发音">
            <div className="segmented">
              <button className={settings.accent === "uk" ? "is-on" : ""} onClick={() => set({ accent: "uk" })}>
                英式
              </button>
              <button className={settings.accent === "us" ? "is-on" : ""} onClick={() => set({ accent: "us" })}>
                美式
              </button>
            </div>
          </Field>
          <Field label="外观">
            <div className="segmented">
              {(
                [
                  ["system", "跟随系统"],
                  ["light", "浅色"],
                  ["dark", "深色"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={settings.theme === k ? "is-on" : ""} onClick={() => set({ theme: k })}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Toggle label="自动播放发音" on={settings.autoplay} set={(v) => set({ autoplay: v })} />
          <Toggle label="界面音效" on={settings.sfx} set={(v) => set({ sfx: v })} />
          <Toggle label="开屏动画（每天一次）" on={settings.splash} set={(v) => set({ splash: v })} />
          <Toggle label="新词先猜后看（先遮住释义，想一想再揭晓）" on={settings.guessFirst} set={(v) => set({ guessFirst: v })} />
          <Toggle label="听力拼写卡（王陆语料库词，识别稳定后解锁听写）" on={settings.trackL} set={(v) => set({ trackL: v })} />
          <Toggle label="写作产出卡（学术词表 AWL，根据中文和语境写出单词）" on={settings.trackP} set={(v) => set({ trackP: v })} />
          {privateAvailable && (
            <Field label="词库" hint="私人词库只在本机开发服务器中可用，不会被打包发布。">
              <div className="segmented">
                <button className={settings.dataset === "open" ? "is-on" : ""} onClick={() => set({ dataset: "open" })}>
                  开放图鉴
                </button>
                <button className={settings.dataset === "private" ? "is-on" : ""} onClick={() => set({ dataset: "private" })}>
                  私人 8000
                </button>
              </div>
            </Field>
          )}
        </section>

        <OfflinePanel />

        <section className="panel">
          <h3 className="eyebrow">数据</h3>
          <p className="muted">进度只存在这台设备的浏览器里：没有账号，没有服务器。换设备时，导出备份再导入即可。</p>
          {saveError && <p className="warn-text">浏览器拒绝保存（可能是隐私模式或空间已满）。请尽快导出备份。</p>}
          <div className="data-actions">
            <button className="btn btn-ghost" onClick={download}>
              <Download size={18} /> 导出备份
            </button>
            <button className="btn btn-ghost" onClick={() => file.current?.click()}>
              <Upload size={18} /> 导入备份
            </button>
            <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0]).finally(() => (e.target.value = ""))} />
            <button
              className="btn btn-ghost btn-danger"
              onClick={() => {
                if (confirm("确定清空这个词库的全部学习记录？此操作无法撤销，建议先导出备份。")) {
                  resetProgress();
                  toast("学习记录已清空");
                }
              }}
            >
              <RotateCcw size={18} /> 清空记录
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** The learner's own Claude API key, kept in this browser only. */
function AiPanel() {
  const model = useStore((s) => s.settings.aiModel);
  const [key, setKeyState] = useState(getKey);
  const [show, setShow] = useState(false);
  const saved = !!getKey();
  return (
    <section className="panel settings">
      <h3 className="eyebrow">AI 助教 · Claude</h3>
      <p className="muted">错词阅读和造句批改会用你自己的 Claude API Key，从浏览器直接请求 api.anthropic.com，费用记在你的账户上。Key 只保存在这台设备的浏览器里，不会进入导出的备份。</p>
      <label className="field">
        <div>
          <b>API Key</b>
          <small>{saved ? "已保存在本机" : "在 console.anthropic.com 创建"}</small>
        </div>
        <span className="key-row">
          <KeyRound size={16} />
          <input type={show ? "text" : "password"} value={key} onChange={(e) => setKeyState(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} aria-label="Claude API Key" />
          <button type="button" className="link" onClick={() => setShow(!show)}>
            {show ? "隐藏" : "显示"}
          </button>
        </span>
      </label>
      <div className="data-actions">
        <button
          className="btn btn-primary"
          onClick={() => {
            setKey(key);
            toast(key.trim() ? "API Key 已保存在本机" : "已清除 API Key", "ok");
          }}
        >
          保存
        </button>
        {saved && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setKey("");
              setKeyState("");
              toast("已清除 API Key");
            }}
          >
            清除
          </button>
        )}
      </div>
      <Field label="模型" hint="Opus 质量最好；Sonnet / Haiku 更快更便宜。">
        <div className="segmented">
          {AI_MODELS.map((m) => (
            <button key={m} className={model === m ? "is-on" : ""} onClick={() => store.settings({ aiModel: m })}>
              {m.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2")}
            </button>
          ))}
        </div>
      </Field>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="field toggle">
      <b>{label}</b>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => set(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

function Heatmap({ days }: { days: Record<string, { r: number }> }) {
  const weeks = 20;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (weeks * 7 - 1) - end.getDay());
  const cells: { k: string; v: number; future: boolean }[] = [];
  const d = new Date(start);
  for (let i = 0; i < (weeks + 1) * 7; i++) {
    const k = dayKey(d);
    cells.push({ k, v: days[k]?.r ?? 0, future: d > end });
    d.setDate(d.getDate() + 1);
  }
  const lvl = (v: number) => (v === 0 ? 0 : v < 10 ? 1 : v < 25 ? 2 : v < 50 ? 3 : 4);
  return (
    <div className="heatmap" role="img" aria-label="学习热力图">
      {cells.map((c) => (
        <span key={c.k} className={`h${c.future ? "x" : lvl(c.v)}`} title={`${c.k} · ${c.v} 题`} />
      ))}
    </div>
  );
}
