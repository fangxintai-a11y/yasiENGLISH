import { CALIBRATION_DIMENSION_LABELS, compareWeeklyCalibration } from "../calibration";
import { useLearning } from "../repository";

const sourceLabels = { self: "自评", ai: "AI估分", rules: "规则估计" };
const taskLabels = { task1: "写作 Task 1", task2: "写作 Task 2", speaking: "口语" };

export function CalibrationStatus() {
  const learning = useLearning();
  const comparisons = learning.ready ? compareWeeklyCalibration(learning.records) : [];
  if (!comparisons.length) return null;
  return (
    <section className="panel" aria-label="每周评分校准提示">
      <h3 className="eyebrow">每周评分校准</h3>
      <p className="muted">同一原稿的估分与人工评阅相差至少 0.5，需要校准判断。以下为练习评分偏差。</p>
      <ul>
        {comparisons.map((comparison) => (
          <li key={`${comparison.planId}:${comparison.weekIndex}:${comparison.workRevisionId}:${comparison.source}`}>
            <b>第 {comparison.weekIndex} 周 · {taskLabels[comparison.taskType]} · 作品 {comparison.workId}</b>
            {comparison.prompt && <p className="muted">{comparison.prompt.length > 160 ? `${comparison.prompt.slice(0, 160)}…` : comparison.prompt}</p>}
            <p>{sourceLabels[comparison.source]}：{comparison.differences.filter((difference) => difference.needsCalibration).map((difference) =>
              `${CALIBRATION_DIMENSION_LABELS[difference.dimension]}比人工评阅${difference.delta > 0 ? "高" : "低"} ${Math.abs(difference.delta).toFixed(1)}`,
            ).join("；")}。</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
