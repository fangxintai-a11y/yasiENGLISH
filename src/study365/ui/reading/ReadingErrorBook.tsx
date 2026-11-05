import { useState } from "react";
import type { LocalMaterial } from "../../localBankSchema";
import type { Revision } from "../../protocol";
import {
  LISTENING_READING_CAUSES,
  LR_CAUSE_LABELS,
  readingErrorRows,
  recentReadingStatistics,
} from "../../readingReview";
export function ReadingErrorBook({
  records,
  planId,
  bank,
  today,
}: {
  records: readonly Revision[];
  planId: string;
  bank: readonly LocalMaterial[];
  today: string;
}) {
  const [skill, setSkill] = useState(""),
    [type, setType] = useState(""),
    [cause, setCause] = useState(""),
    [date, setDate] = useState("");
  const all = readingErrorRows(records, planId, bank),
    rows = all.filter(
      ({ work, result, question }) =>
        (!skill || work.payload.skill === skill) &&
        (!type || question?.type === type) &&
        (!cause || result.errorCause === cause) &&
        (!date || work.payload.date === date),
    );
  const stats = recentReadingStatistics(records, planId, bank, today);
  return (
    <section className="panel" aria-label="听读错题本">
      <h2>听读错题</h2>
      <p>保留首答与A-B复盘；答案存疑题不计为你的错题。</p>
      <div className="r4-columns">
        <label className="field">
          <span>日期</span>
          <input
            type="date"
            aria-label="错题日期"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="field">
          <span>科目</span>
          <select
            aria-label="错题科目"
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
          >
            <option value="">全部</option>
            <option value="listening">听力</option>
            <option value="reading">阅读</option>
          </select>
        </label>
        <label className="field">
          <span>题型</span>
          <select
            aria-label="错题题型"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">全部</option>
            {[
              ...new Set(
                all.flatMap((row) => (row.question ? [row.question.type] : [])),
              ),
            ].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>错因</span>
          <select
            aria-label="错题错因"
            value={cause}
            onChange={(e) => setCause(e.target.value)}
          >
            <option value="">全部</option>
            {LISTENING_READING_CAUSES.map((value) => (
              <option key={value} value={value}>
                {LR_CAUSE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!rows.length && <p>此筛选下暂无错题。</p>}
      {rows.map(({ work, result, question }) => (
        <article key={`${work.id}:${result.questionId}`}>
          <p>
            {String(work.payload.date)} ·{" "}
            {work.payload.skill === "listening" ? "听力" : "阅读"} ·{" "}
            {question?.type ?? "题型未知"} ·{" "}
            {LR_CAUSE_LABELS[String(result.errorCause)] ??
              String(result.errorCause)}
          </p>
          <p>{question?.prompt ?? "本机缺少原材料，请导入同版题库。"}</p>
          <a
            className="btn btn-ghost"
            href={`#/${work.payload.skill}?${new URLSearchParams({ work: work.id, date: String(work.payload.date) })}`}
          >
            回到原题与证据
          </a>
        </article>
      ))}
      <h3>近4周题型正确率</h3>
      {!stats.types.length && <p>完成复盘后显示统计。</p>}
      <ul>
        {stats.types.map((item) => (
          <li key={item.type}>
            {item.type}：{item.correct}/{item.total}（
            {Math.round(item.accuracy * 100)}%）
          </li>
        ))}
      </ul>
      <h3>近4周错因</h3>
      <ul>
        {stats.causes.map((item) => (
          <li key={item.errorCause}>
            {LR_CAUSE_LABELS[item.errorCause] ?? item.errorCause}：{item.count}
          </li>
        ))}
      </ul>
    </section>
  );
}
