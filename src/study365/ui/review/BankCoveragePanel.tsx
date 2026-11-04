import { useMemo, useState } from "react";
import {
  bankCoverage,
  exportBankGaps,
  type SequenceOriginCatalog,
} from "../../bankCoverage";
import type { LocalMaterial } from "../../localBankSchema";
import type { Revision } from "../../protocol";
const skillName = (skill: string) => (skill === "listening" ? "听力" : "阅读");
export function BankCoveragePanel({
  bank,
  records,
  planId,
  sequenceOrigins = [],
}: {
  bank: readonly LocalMaterial[];
  records: readonly Revision[];
  planId: string;
  sequenceOrigins?: readonly SequenceOriginCatalog[];
}) {
  const coverage = useMemo(
    () => bankCoverage(bank, records, planId, [], sequenceOrigins),
    [bank, records, planId, sequenceOrigins],
  );
  const [message, setMessage] = useState("");
  const download = () => {
    const blob = new Blob([JSON.stringify(exportBankGaps(coverage), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "bank-gaps.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMessage("已导出缺口清单，可交资料抓取方补齐。");
  };
  return (
    <section
      className="panel"
      aria-label="题库完整性"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>题库完整性与覆盖</h2>
      <p>
        只统计本机已读到的原件；内置兜底不充数。同一整套与分篇重复题只算一次，音频引用齐备不等于当前浏览器已经缓存。
      </p>
      <button className="btn btn-ghost" onClick={download}>
        导出缺口清单JSON
      </button>
      <h3>整套与检查池</h3>
      {coverage.exams.map((row) => (
        <p key={row.skill} data-coverage-exams={row.skill}>
          {skillName(row.skill)}：完整整套{row.complete}套 · 单轨/整篇可做
          {row.fullPlayable}套
          {row.skill === "listening" ? ` · 四节可连播${row.sequential}套` : ""}{" "}
          · 检查池{row.holdout}/{row.holdoutRequired}套
          {row.holdoutMissing ? `（还缺${row.holdoutMissing}套）` : ""}
          。全年需要{row.annualRequired}套，对照未见练习整套{row.unseenPractice}
          套，还缺{row.annualMissing}套。
        </p>
      ))}
      <h3>每日单节／单篇库存</h3>
      {coverage.sections.map((row) => (
        <p key={row.skill} data-coverage-sections={row.skill}>
          {skillName(row.skill)}：练习池{row.available}份，已做{row.done}
          份，未做{row.remaining}份；按每天一份可支撑约{row.daysRemaining}
          天，对照全年约{row.annualRequired}份还缺{row.annualMissing}
          份。检查池、短专项和重复整套不计入。
        </p>
      ))}
      <h3>答案审校进度</h3>
      <p data-testid="bank-audit-counts">
        独立题目{coverage.audits.independentQuestions}题；待审校
        {coverage.audits.pending}题，已审{coverage.audits.reviewed}
        题，其中答案有误{coverage.audits.keyWrong}题、歧义
        {coverage.audits.ambiguous}题。原始题目记录共
        {coverage.audits.rawQuestionEntries}条，包含整套与分篇重复。
      </p>
      <p>
        <a href="#/review?tab=answers">打开答案审校</a>
      </p>
      <h3>题型覆盖</h3>
      <p>
        来源与已做／未做按去重题数列出；复测新材料按未做且不含检查池的原材料份数列出。0项明确列缺口，不自动造题。
      </p>
      {(["listening", "reading"] as const).map((skill) => (
        <div
          key={skill}
          style={{ maxWidth: "100%", minWidth: 0, overflowX: "auto" }}
        >
          <h4>{skillName(skill)}</h4>
          <table
            style={{ width: "100%", tableLayout: "fixed", fontSize: "0.85rem" }}
          >
            <thead>
              <tr>
                <th style={{ width: "27%" }}>题型</th>
                <th>官方</th>
                <th>剑桥</th>
                <th>其他</th>
                <th>已做</th>
                <th>未做</th>
                <th>复测新材料</th>
              </tr>
            </thead>
            <tbody>
              {coverage.rows
                .filter((row) => row.skill === skill)
                .map((row) => (
                  <tr
                    key={row.questionType}
                    data-coverage-type={`${row.skill}:${row.questionType}`}
                  >
                    <th
                      scope="row"
                      style={{ overflowWrap: "anywhere", textAlign: "left" }}
                    >
                      {row.questionType}
                    </th>
                    {[
                      row.official,
                      row.cambridge,
                      row.other,
                      row.done,
                      row.unseen,
                      row.retestAvailable,
                    ].map((value, index) => (
                      <td
                        key={index}
                        style={
                          value === 0 ? { color: "var(--danger, #b42318)" } : {}
                        }
                      >
                        {value}
                        {value === 0 && (index === 0 || index === 5)
                          ? "（缺）"
                          : ""}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
