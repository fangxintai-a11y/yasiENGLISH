import { promptStimulusUrl, type LocalPrompt } from "../../promptBankSchema";
import { practicePrompts, promptKey } from "../../promptWorkSelection";
export function PromptPicker({
  prompts,
  skill,
  taskType,
  part,
  value,
  disabled,
  onChoose,
}: {
  prompts: readonly LocalPrompt[];
  skill: "writing" | "speaking";
  taskType?: "task1" | "task2";
  part?: 1 | 2 | 3;
  value?: string;
  disabled?: boolean;
  onChoose: (prompt: LocalPrompt) => void;
}) {
  const choices = practicePrompts(prompts).filter(
    (prompt) =>
      prompt.skill === skill &&
      (prompt.skill === "writing"
        ? prompt.taskType === taskType
        : prompt.part === part),
  );
  const label = skill === "writing" ? "本机写作题库" : "本机口语题库";
  return (
    <details style={{ minWidth: 0, maxWidth: "100%" }}>
      <summary>查看/更换{skill === "writing" ? "写作" : "口语"}材料</summary>
      <label
        style={{
          display: "block",
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {label}
        <select
          aria-label={label}
          style={{
            display: "block",
            width: "100%",
            minWidth: 0,
            maxWidth: "100%",
          }}
          value={
            choices.some((prompt) => promptKey(prompt) === value) ? value : ""
          }
          disabled={disabled || !choices.length}
          onChange={(event) => {
            const prompt = choices.find(
              (prompt) => promptKey(prompt) === event.target.value,
            );
            if (prompt && !disabled) onChoose(prompt);
          }}
        >
          <option value="">
            {choices.length ? "选择已导入原题" : "本机还没有此类可用题目"}
          </option>
          {choices.map((prompt) => (
            <option key={promptKey(prompt)} value={promptKey(prompt)}>
              {prompt.skill === "writing"
                ? `${prompt.taskType === "task1" ? "Task 1" : "Task 2"} · ${prompt.questionType}`
                : `Part ${prompt.part}`}{" "}
              · {prompt.sourceRef} · {prompt.prompt}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        当前题目由平台安排。需要调整时可在此更换，开始作答后保留当前题目。
      </p>
    </details>
  );
}
export function PromptStimulus({ prompt }: { prompt?: LocalPrompt }) {
  if (!prompt || prompt.skill !== "writing" || prompt.taskType !== "task1")
    return null;
  const url = promptStimulusUrl(prompt);
  return (
    <section
      aria-label="Task 1原题材料"
      style={{ minWidth: 0, maxWidth: "100%" }}
    >
      {prompt.stimulusText && (
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {prompt.stimulusText}
        </p>
      )}
      {url && (
        <img
          src={url}
          alt="Task 1原题图"
          style={{ display: "block", maxWidth: "100%", height: "auto" }}
        />
      )}
    </section>
  );
}
