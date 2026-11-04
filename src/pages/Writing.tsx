import { useEffect, useMemo, useState } from "react";
import type { Route } from "../lib/router";
import { words } from "../ielts/scoring/rules/text";
import {
  elapsedWritingSeconds,
  newWritingDraft,
  type WritingDraft,
} from "../study365/writingModel";
import type { Revision } from "../study365/protocol";
import { useActivePlan } from "../study365/useActivePlan";
import {
  availableWritingMaterials,
  externalWritingId,
  resolveWritingContext,
  WRITING_OUTLINE_HINTS,
  type WritingContext,
  type WritingMaterial,
  type WritingMode,
} from "../study365/writingTasks";

type WritingRoute = Extract<Route, { page: "writing" }>;
const labelOf = (draft: WritingDraft) =>
  `写作 ${draft.taskType === "task1" ? "Task 1" : draft.scope === "paragraph" ? "Task 2 段落" : "Task 2"}`;
const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const tableDescription = (material?: WritingMaterial) =>
  material?.taskData?.kind === "table"
    ? [
        material.taskData.description,
        material.taskData.columns.join(" | "),
        ...material.taskData.rows.map((row) => row.join(" | ")),
      ].join("\n")
    : undefined;
function createDraft(
  plan: Revision,
  context: WritingContext,
  taskType: "task1" | "task2",
  paragraph = false,
): WritingDraft {
  const material = availableWritingMaterials(context.day).find(
    (item) => item.taskType === taskType,
  );
  return newWritingDraft({
    planId: plan.id,
    taskType,
    scope: paragraph ? "paragraph" : "full",
    date: context.date,
    day: context.day,
    taskId: context.taskId,
    prompt: material?.prompt ?? "",
    contentId: material?.id ?? externalWritingId(context.date, Date.now()),
    contentVersion: material?.version,
    materialSelfCheck: material?.selfCheck ?? [],
    tableDescription: tableDescription(material),
    timer: {
      elapsedSeconds: 0,
      runningSince: null,
      limitSeconds: paragraph
        ? context.plannedMinutes * 60
        : taskType === "task1"
          ? 1200
          : 2400,
      timed: false,
    },
  });
}
export function Writing({ route }: { route: WritingRoute }) {
  const { learning, plan, error } = useActivePlan();
  if (!learning.ready)
    return (
      <div className="page">
        <p>正在读取写作任务…</p>
      </div>
    );
  if (!plan)
    return (
      <div className="page">
        <section className="panel" aria-label="写作工作台">
          <h1>写作工作台</h1>
          <p>请先开启365天计划。</p>
          <a href="#/">前往今日</a>
        </section>
      </div>
    );
  if (error)
    return (
      <div className="page">
        <p role="alert">{error}</p>
      </div>
    );
  try {
    const context = resolveWritingContext(plan, learning.records, route);
    return (
      <WritingEditor
        key={`${learning.userId ?? "guest"}:${plan.id}:${context.date}:${context.taskId}`}
        plan={plan}
        context={context}
      />
    );
  } catch (error) {
    return (
      <div className="page">
        <h1>写作工作台</h1>
        <p role="alert">
          {error instanceof Error ? error.message : "任务暂不可用。"}
        </p>
        <a href="#/">返回今日</a>
      </div>
    );
  }
}
function WritingEditor({
  plan,
  context,
}: {
  plan: Revision;
  context: WritingContext;
}) {
  const [mode, setMode] = useState<WritingMode>(context.defaultMode),
    [now, setNow] = useState(Date.now);
  const [drafts, setDrafts] = useState<WritingDraft[]>(() =>
    context.block
      ? context.defaultMode === "pair"
        ? [
            createDraft(plan, context, "task1"),
            createDraft(plan, context, "task2"),
          ]
        : [
            createDraft(
              plan,
              context,
              context.defaultMode === "task1" ? "task1" : "task2",
              context.defaultMode === "paragraph",
            ),
          ]
      : [],
  );
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const visible = useMemo(
    () =>
      drafts.filter((draft) =>
        mode === "pair"
          ? draft.scope === "full"
          : mode === "paragraph"
            ? draft.taskType === "task2" && draft.scope === "paragraph"
            : draft.taskType === mode && draft.scope === "full",
      ),
    [drafts, mode],
  );
  const update = (id: string, change: (draft: WritingDraft) => WritingDraft) =>
    setDrafts((previous) =>
      previous.map((draft) =>
        draft.id === id ? { ...change(draft), updatedAt: Date.now() } : draft,
      ),
    );
  const changeMode = (next: WritingMode) => {
    setMode(next);
    setDrafts((previous) => {
      const values = [...previous];
      const required =
        next === "pair"
          ? (["task1", "task2"] as const)
          : ([next === "task1" ? "task1" : "task2"] as const);
      for (const taskType of required)
        if (
          !values.some(
            (draft) =>
              draft.taskType === taskType &&
              draft.scope === (next === "paragraph" ? "paragraph" : "full"),
          )
        )
          values.push(
            createDraft(plan, context, taskType, next === "paragraph"),
          );
      return values;
    });
  };
  const start = (id: string) => {
    const at = Date.now();
    setDrafts((previous) =>
      previous.map((draft) => ({
        ...draft,
        timer: {
          ...draft.timer,
          elapsedSeconds: elapsedWritingSeconds(draft, at),
          runningSince: draft.id === id ? at : null,
          timed: draft.id === id ? true : draft.timer.timed,
        },
        updatedAt: at,
      })),
    );
    setNow(at);
  };
  const pause = (id: string) =>
    update(id, (draft) => ({
      ...draft,
      timer: {
        ...draft.timer,
        elapsedSeconds: elapsedWritingSeconds(draft),
        runningSince: null,
      },
    }));
  return (
    <div className="page">
      <section
        className="panel"
        aria-label="写作工作台"
        data-testid="writing-workbench"
      >
        <p className="eyebrow">365天训练 · {context.date}</p>
        <h1>写作工作台</h1>
        <p>今日写作计划 {context.plannedMinutes} 分钟。提纲时间计入写作。</p>
        <a href="#/">返回今日任务</a>
        {!context.block ? (
          <p>这一天没有写作任务。已保存作品会在作品列表中显示。</p>
        ) : (
          <>
            <label className="field">
              <span>练习类型</span>
              <select
                aria-label="练习类型"
                value={mode}
                onChange={(event) =>
                  changeMode(event.target.value as WritingMode)
                }
              >
                <option value="task1">Task 1</option>
                <option value="task2">Task 2</option>
                <option value="paragraph">Task 2 段落练习</option>
                <option value="pair">Task 1 + Task 2（20 + 40分钟）</option>
              </select>
            </label>
            {mode === "paragraph" && (
              <p>这是段落练习，不计作完整 Task 2 测评。</p>
            )}
            {visible.map((draft) => (
              <DraftEditor
                key={draft.id}
                draft={draft}
                now={now}
                materials={availableWritingMaterials(context.day)}
                onChange={(change) => update(draft.id, change)}
                onStart={() => start(draft.id)}
                onPause={() => pause(draft.id)}
              />
            ))}
            <p role="status" data-testid="writing-local-status">
              当前输入尚未保存。
            </p>
          </>
        )}
      </section>
      <section
        className="panel"
        aria-label="我的写作作品"
        data-testid="writing-work-list"
      >
        <h2>我的作品</h2>
        <p>暂无已提交作品。</p>
      </section>
    </div>
  );
}
function DraftEditor({
  draft,
  materials,
  now,
  onChange,
  onStart,
  onPause,
}: {
  draft: WritingDraft;
  materials: WritingMaterial[];
  now: number;
  onChange: (change: (draft: WritingDraft) => WritingDraft) => void;
  onStart: () => void;
  onPause: () => void;
}) {
  const available = materials.filter(
    (material) => material.taskType === draft.taskType,
  );
  const material = available.find((item) => item.id === draft.contentId);
  const [source, setSource] = useState<"builtin" | "external" | "custom">(
    material
      ? "builtin"
      : draft.sourceRef
        ? "external"
        : draft.contentId?.startsWith("custom-")
          ? "custom"
          : "external",
  );
  const elapsed = elapsedWritingSeconds(draft, now),
    remaining = Math.max(0, draft.timer.limitSeconds - elapsed),
    count = words(draft.text).length;
  const chooseSource = (value: "builtin" | "external" | "custom") => {
    setSource(value);
    onChange((previous) => {
      const selected = value === "builtin" ? available[0] : undefined;
      return {
        ...previous,
        prompt: selected?.prompt ?? "",
        contentId: selected?.id ?? `${value}-${previous.date}-${previous.id}`,
        contentVersion: selected?.version,
        sourceRef: undefined,
        tableDescription: tableDescription(selected),
        materialSelfCheck: selected?.selfCheck ?? [],
      };
    });
  };
  return (
    <article
      className="panel"
      aria-label={labelOf(draft)}
      data-testid="writing-editor"
      data-draft-id={draft.id}
    >
      <h2>{labelOf(draft).replace("写作 ", "")}</h2>
      <label className="field">
        <span>题目来源</span>
        <select
          aria-label="题目来源"
          value={source}
          onChange={(event) =>
            chooseSource(event.target.value as typeof source)
          }
        >
          {available.length > 0 && <option value="builtin">当天内置题</option>}
          <option value="external">外部题</option>
          <option value="custom">自定义题</option>
        </select>
      </label>
      {source === "builtin" && (
        <>
          <label>
            内置题目
            <select
              aria-label="内置题目"
              value={draft.contentId}
              onChange={(event) => {
                const item = available.find(
                  (material) => material.id === event.target.value,
                )!;
                onChange((previous) => ({
                  ...previous,
                  prompt: item.prompt,
                  contentId: item.id,
                  contentVersion: item.version,
                  tableDescription: tableDescription(item),
                  materialSelfCheck: item.selfCheck,
                }));
              }}
            >
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">自编练习材料，尚待独立人工审校。</p>
        </>
      )}
      {source === "external" && (
        <label className="field">
          <span>外部题出处（必填）</span>
          <input
            aria-label="外部题出处"
            value={draft.sourceRef ?? ""}
            maxLength={300}
            placeholder="例如：剑桥20 Test 1 Task 2"
            onChange={(event) =>
              onChange((previous) => ({
                ...previous,
                sourceRef: event.target.value,
              }))
            }
          />
        </label>
      )}
      <label style={{ display: "block" }}>
        题目
        <textarea
          aria-label="题目"
          value={draft.prompt}
          readOnly={source === "builtin"}
          maxLength={8000}
          rows={4}
          style={{ width: "100%" }}
          onChange={(event) =>
            onChange((previous) => ({
              ...previous,
              prompt: event.target.value,
            }))
          }
        />
      </label>
      {material?.taskData?.kind === "table" && (
        <div style={{ overflowX: "auto" }}>
          <table aria-label="Task 1题目数据表">
            <caption>{material.taskData.description}</caption>
            <thead>
              <tr>
                {material.taskData.columns.map((value) => (
                  <th key={value}>{value}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {material.taskData.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((value, i) => (
                    <td key={i}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {source !== "builtin" && draft.taskType === "task1" && (
        <label style={{ display: "block" }}>
          题图文字说明
          <textarea
            aria-label="题图文字说明"
            value={draft.tableDescription ?? ""}
            maxLength={2000}
            rows={2}
            style={{ width: "100%" }}
            placeholder="图在书上看，在这里记下图的对象、单位和时间。"
            onChange={(event) =>
              onChange((previous) => ({
                ...previous,
                tableDescription: event.target.value,
              }))
            }
          />
        </label>
      )}
      <div className="data-actions">
        <button
          className="btn btn-primary"
          type="button"
          disabled={draft.timer.runningSince !== null}
          onClick={onStart}
        >
          开始计时
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={draft.timer.runningSince === null}
          onClick={onPause}
        >
          暂停计时
        </button>
      </div>
      <p role="status">
        剩余 {formatTime(remaining)} · 已用 {formatTime(elapsed)}
      </p>
      {elapsed >= draft.timer.limitSeconds && (
        <p role="status">
          时间已到，可以继续写。
          {elapsed > draft.timer.limitSeconds
            ? `已超时 ${formatTime(elapsed - draft.timer.limitSeconds)}。`
            : ""}
        </p>
      )}
      <h3>提纲</h3>
      <ul>
        {WRITING_OUTLINE_HINTS[draft.taskType].map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
      <textarea
        aria-label="提纲"
        data-testid="writing-outline"
        value={draft.outline}
        maxLength={8000}
        rows={3}
        style={{ width: "100%" }}
        onChange={(event) =>
          onChange((previous) => ({ ...previous, outline: event.target.value }))
        }
      />
      <h3>正文</h3>
      <p>
        {count} 词
        {draft.scope === "paragraph"
          ? " · 段落练习"
          : ` · 至少 ${draft.taskType === "task1" ? 150 : 250} 词`}
      </p>
      <textarea
        aria-label="作文正文"
        data-testid="writing-body"
        value={draft.text}
        maxLength={20000}
        rows={14}
        style={{ width: "100%", lineHeight: 1.8 }}
        onChange={(event) =>
          onChange((previous) => ({ ...previous, text: event.target.value }))
        }
      />
      <label>
        <input
          type="checkbox"
          checked={draft.conditions.unseen}
          onChange={(event) =>
            onChange((previous) => ({
              ...previous,
              conditions: {
                ...previous.conditions,
                unseen: event.target.checked,
              },
            }))
          }
        />{" "}
        这是未做过的题目
      </label>
    </article>
  );
}
