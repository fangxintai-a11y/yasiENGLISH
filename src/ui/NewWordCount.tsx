import { useState } from "react";
import { store, useStore } from "../store/store";

export function NewWordCountForm({
  initialValue,
  minimum = 1,
  label,
  submitLabel,
  onSubmit,
  available,
  disabled = false,
  activity = "学习",
  noun = "新词",
}: {
  initialValue: number;
  minimum?: 0 | 1;
  label: string;
  submitLabel: string;
  onSubmit: (count: number) => void;
  available?: number;
  disabled?: boolean;
  activity?: string;
  noun?: string;
}) {
  const [draft, setDraft] = useState(String(initialValue));
  const count = Number(draft);
  const valid =
    /^\d+$/.test(draft) &&
    Number.isInteger(count) &&
    count >= minimum &&
    count <= 100;
  const suggestions =
    minimum === 0
      ? [0, 5, 10, 15, 20, 30, 50, 100]
      : [5, 10, 15, 20, 30, 50, 100];
  return (
    <form
      className="new-word-count-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !disabled && available !== 0) onSubmit(count);
      }}
    >
      <label className="new-word-count-input">
        <b>{label}</b>
        <span>
          <input
            type="number"
            min={minimum}
            max={100}
            step={1}
            inputMode="numeric"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />{" "}
          个
        </span>
      </label>
      <div
        className="new-word-count-options"
        role="group"
        aria-label={`${label}快捷选择`}
      >
        {suggestions.map((n) => (
          <button
            key={n}
            type="button"
            className={`btn ${valid && n === count ? "btn-primary" : "btn-ghost"}`}
            aria-pressed={valid && n === count}
            onClick={() => setDraft(String(n))}
          >
            {n === 0 ? "只复习" : `${n} 个`}
          </button>
        ))}
      </div>
      {!valid && <p role="alert">请输入 {minimum}–100 之间的整数。</p>}
      {available !== undefined && (
        <p className="muted" role="status">
          {available === 0
            ? `当前范围没有待${activity}的${noun}。`
            : valid
              ? `本轮将${activity} ${Math.min(count, available)} 个${noun}${count > available ? `（当前仅剩 ${available} 个）` : ""}。`
              : `当前还有 ${available} 个${noun}。`}
        </p>
      )}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={!valid || disabled || available === 0}
      >
        {submitLabel}
      </button>
    </form>
  );
}

export function DailyNewWordSettings({ onSaved }: { onSaved?: () => void }) {
  const dailyNew = useStore((s) => s.settings.dailyNew);
  return (
    <div className="daily-new-word-settings">
      <NewWordCountForm
        key={dailyNew}
        initialValue={dailyNew}
        minimum={0}
        label="每日新词数量"
        submitLabel="保存每日数量"
        onSubmit={(count) => {
          store.settings({ dailyNew: count });
          onSaved?.();
        }}
      />
      <p className="muted small">
        当前每天 {dailyNew} 个新词；设为 0
        时只安排复习。考试日期和时间预算不会改动这个数量，学完后还可自选加学。
      </p>
    </div>
  );
}
