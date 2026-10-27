import { store, useStore } from "../store/store";

export const BANDS = [5.5, 6, 6.5, 7, 7.5, 8];
export const MINUTES = [15, 20, 30, 45, 60, 90];

/** Exam date, target band and daily minutes: everything the plan is built from. */
export function ExamFields({ compact = false }: { compact?: boolean }) {
  const s = useStore((x) => x.settings);
  const today = new Date();
  const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return (
    <div className={`exam-fields ${compact ? "is-compact" : ""}`}>
      <label className="field">
        <div>
          <b>考试日期</b>
          <small>还没报名可以先空着，按自由节奏学。</small>
        </div>
        <span className="date-row">
          <input type="date" value={s.examDate} min={min} onChange={(e) => store.settings({ examDate: e.target.value })} aria-label="考试日期" />
          {s.examDate && (
            <button type="button" className="link" onClick={() => store.settings({ examDate: "" })}>
              清除
            </button>
          )}
        </span>
      </label>
      <div className="field">
        <div>
          <b>目标分数</b>
          <small>决定要掌握到哪个难度：6.5 分约到 B2，7.5 分约到 C1。</small>
        </div>
        <div className="segmented">
          {BANDS.map((b) => (
            <button key={b} type="button" className={s.targetBand === b ? "is-on" : ""} onClick={() => store.settings({ targetBand: b })}>
              {b}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <div>
          <b>每天能学多久</b>
          <small>计划按这个时间倒推：每天的量永远不会超出它。</small>
        </div>
        <div className="segmented">
          {MINUTES.map((m) => (
            <button key={m} type="button" className={s.dailyMinutes === m ? "is-on" : ""} onClick={() => store.settings({ dailyMinutes: m })}>
              {m}′
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
