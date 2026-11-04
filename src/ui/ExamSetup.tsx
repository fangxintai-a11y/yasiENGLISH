import { store, useStore } from "../store/store";
import { GATE_TARGETS, SECTION_TARGETS } from "../study365/protocol";
import { useVocabularyBudget } from "../study365/useVocabularyBudget";

export const MINUTES = [15, 20, 30, 45, 60, 90];

/** Exam date, target band and daily minutes: everything the plan is built from. */
export function ExamFields({ compact = false }: { compact?: boolean }) {
  const s = useStore((x) => x.settings);
  const budget = useVocabularyBudget();
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
          <b>目标 {GATE_TARGETS.G4.overall.toFixed(1)}</b>
          <small>听 {SECTION_TARGETS.listening.toFixed(1)} · 读 {SECTION_TARGETS.reading.toFixed(1)} · 写 {SECTION_TARGETS.writing.toFixed(1)} · 说 {SECTION_TARGETS.speaking.toFixed(1)}</small>
        </div>
      </div>
      <div className="field">
        <div>
          <b>每天词汇练习多久</b>
          <small>未开启365天计划时使用。</small>
        </div>
        {budget.managed ? <p role="status">由今日计划决定：今天 {budget.minutes} 分钟</p> : <div className="segmented">
          {MINUTES.map((m) => (
            <button key={m} type="button" className={s.dailyMinutes === m ? "is-on" : ""} onClick={() => store.settings({ dailyMinutes: m })}>
              {m}′
            </button>
          ))}
        </div>}
      </div>
    </div>
  );
}
