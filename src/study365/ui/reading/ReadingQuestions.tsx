import type { LocalMaterial } from "../../localBankSchema";
export function ReadingQuestions({
  material,
  answers,
  onChange,
  disabled = false,
}: {
  material: LocalMaterial;
  answers: readonly string[];
  onChange: (answers: string[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, value: string) =>
    onChange(
      material.questions.map((_, i) =>
        i === index ? value : (answers[i] ?? ""),
      ),
    );
  return (
    <>
      {material.questions.map((q, index) => {
        const number = q.number ?? index + 1;
        const group =
          q.selectionCount && q.groupId
            ? material.questions
                .map((x, i) =>
                  x.groupId === q.groupId &&
                  x.selectionCount === q.selectionCount
                    ? i
                    : -1,
                )
                .filter((i) => i >= 0)
            : [];
        if (group.length && group[0] !== index) return null;
        if (group.length) {
          const values = group.map((i) => answers[i] ?? "").filter(Boolean);
          return (
            <fieldset key={q.id} data-question-id={q.id}>
              <legend>
                第
                {group
                  .map((i) => material.questions[i].number ?? i + 1)
                  .join("、")}
                题 · {q.prompt}（选择{q.selectionCount}项，顺序不限）
              </legend>
              {q.options?.map((o) => (
                <label key={o.id} className="r4-choice">
                  <input
                    type="checkbox"
                    aria-label={`第${number}题选项${o.id}`}
                    checked={values.includes(o.id)}
                    disabled={
                      disabled ||
                      (!values.includes(o.id) &&
                        values.length >= Number(q.selectionCount))
                    }
                    onChange={(event) => {
                      const selected = event.target.checked
                        ? [...values, o.id]
                        : values.filter((v) => v !== o.id);
                      const result = material.questions.map(
                        (_, i) => answers[i] ?? "",
                      );
                      group.forEach((i, at) => {
                        result[i] = selected[at] ?? "";
                      });
                      onChange(result);
                    }}
                  />
                  {o.id}. {o.text}
                </label>
              ))}
            </fieldset>
          );
        }
        const decisions =
          q.type === "true-false-not-given"
            ? ["TRUE", "FALSE", "NOT GIVEN"]
            : q.type === "yes-no-not-given"
              ? ["YES", "NO", "NOT GIVEN"]
              : null;
        const options =
          q.options ?? decisions?.map((value) => ({ id: value, text: value }));
        return (
          <label className="field" key={q.id} data-question-id={q.id}>
            <span>
              {number}. {q.prompt}
              {!q.answerVerified && <small>答案待核</small>}
              {!q.options && /completion|short-answer/.test(q.type) && (
                <small>
                  最多{q.answer.maxWords}词
                  {q.answer.allowNumber ? "，可另加1个数字" : ""}
                </small>
              )}
            </span>
            {options?.length ? (
              <select
                aria-label={`第${number}题`}
                value={answers[index] ?? ""}
                disabled={disabled}
                onChange={(e) => update(index, e.target.value)}
              >
                <option value="">请选择</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id === o.text ? o.text : `${o.id}. ${o.text}`}
                  </option>
                ))}
              </select>
            ) : (
              <input
                maxLength={500}
                aria-label={`第${number}题`}
                disabled={disabled}
                value={answers[index] ?? ""}
                onChange={(e) => update(index, e.target.value)}
              />
            )}
          </label>
        );
      })}
    </>
  );
}
