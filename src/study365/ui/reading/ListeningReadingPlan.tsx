import { preferPracticeMaterial } from '../../materialPreferences';
import type { AcceptedPreferences } from '../../weeklyReview';
import type { LocalMaterial } from "../../localBankSchema";
import type { Revision } from "../../protocol";
import {
  buildListeningReadingSchedule,
  officialTypeCalibration,
  selectReadingForDay,
} from "../../listeningReadingSchedule";
import { currentAttempts } from "../../readingModel";
export const MATERIAL_SOURCE_LABELS = {
  official: "官方",
  cambridge: "剑桥",
  publisher: "出版材料（参考）",
  unofficial: "非官方（参考）",
};
export const PRACTICE_SCOPE_LABELS = {
  full: "整套",
  section: "单节／单篇",
  "type-drill": "题型精练",
  short: "短专项",
};
export function practiceSelection(
  bank: readonly LocalMaterial[],
  records: readonly Revision[],
  planId: string,
  day: number,
  date: string,
  skill: "reading" | "listening",
  requiresFull: boolean,
  preferences?: AcceptedPreferences,
) {
  const schedule = buildListeningReadingSchedule(bank),
    attempts = currentAttempts(records, planId);
  const isUsed = (m: LocalMaterial) =>
    attempts.some(
      (r) =>
        r.payload.contentId === m.id &&
        r.payload.contentVersion === m.version &&
        r.payload.contentHash === m.contentHash,
    );
  const fromRef = (
    ref:
      { id: string; version: string; contentHash: string } | null | undefined,
  ) =>
    ref
      ? (bank.find(
          (m) =>
            m.id === ref.id &&
            m.version === ref.version &&
            m.contentHash === ref.contentHash,
        ) ?? null)
      : null;
  const slot = day >= 1 && day <= 14 ? schedule.days[day - 1] : null;
  const official = fromRef(
    skill === "reading" ? slot?.readingOfficial : slot?.listeningOfficial,
  );
  const officialDone =
    !!official &&
    attempts.some(
      (r) =>
        r.payload.date === date &&
        r.payload.contentId === official.id &&
        r.payload.contentVersion === official.version &&
        r.payload.contentHash === official.contentHash,
    );
  let practice: LocalMaterial | null = null,
    notice = "";
  if (day >= 1 && day <= 365) {
    if (requiresFull) {
      practice =
        bank.find(
          (m) =>
            m.skill === skill &&
            m.scope === "full" &&
            m.pool !== "holdout" &&
            m.questions.length === 40 &&
            !isUsed(m),
        ) ?? null;
      if (!practice)
        notice =
          "当前缺少可在App直接作答的未见整套。单节或单篇只能登记部分完成；整套原件也可外部完成后登记。";
    } else if (skill === "reading") {
      const next = selectReadingForDay(bank, records, planId, day);
      practice = fromRef(next.material);
      notice = next.notice;
    } else {
      const reserved = new Set(
        bank
          .filter(
            (m) => m.skill === "listening" && m.scope === "full" && m.examId,
          )
          .map((m) => m.examId),
      );
      const eligible = bank.filter(
        (m) =>
          m.skill === "listening" &&
          m.pool !== "holdout" &&
          m.scope === "section" &&
          !!m.audio &&
          m.questions.length > 0 &&
          !(m.examId && reserved.has(m.examId)) &&
          !isUsed(m),
      );
      const scheduled = fromRef(slot?.listening);
      practice =
        scheduled && eligible.includes(scheduled)
          ? scheduled
          : (eligible.sort((a, b) => {
              const source = (m: LocalMaterial) =>
                m.source.materialSource === "cambridge"
                  ? 0
                  : m.source.materialSource === "unofficial"
                    ? 1
                    : m.source.materialSource === "official"
                      ? 2
                      : 3;
              const frequency = (m: LocalMaterial) =>
                m.frequency === "high" ? 0 : m.frequency === "medium" ? 1 : 2;
              return (
                source(a) - source(b) ||
                frequency(a) - frequency(b) ||
                a.id.localeCompare(b.id)
              );
            })[0] ?? null);
      if (!practice)
        notice =
          "还缺带音频和题答的新听力单节，不重复旧材料充数。可以使用下方官方题型练习或本周BBC泛听。";
    }
  }
  if (!requiresFull && preferences) {
    const adjusted = preferPracticeMaterial(practice, bank, records, planId, skill, preferences);
    practice = adjusted.material;
    if (adjusted.missingTypes.length) notice += ` 本周已采纳的偏重题型还缺新材料：${adjusted.missingTypes.join('、')}。`;
  }
  const preferred = official && !officialDone ? official : practice;
  return { schedule, official, practice, preferred, officialDone, notice };
}
export function ListeningReadingPlan({
  bank,
  records,
  planId,
  day,
  date,
  skill,
  requiresFull,
  preferences,
  officialCalibration,
  onChoose,
  disabled,
}: {
  bank: readonly LocalMaterial[];
  records: readonly Revision[];
  planId: string;
  day: number;
  date: string;
  skill: "reading" | "listening";
  requiresFull: boolean;
  preferences?: AcceptedPreferences;
  officialCalibration?: ReturnType<typeof officialTypeCalibration>;
  onChoose: (m: LocalMaterial) => void;
  disabled: boolean;
}) {
  const selected = practiceSelection(
      bank,
      records,
      planId,
      day,
      date,
      skill,
      requiresFull,
      preferences,
    ),
    calibration = (officialCalibration ?? officialTypeCalibration(records, bank, planId)).filter(
      (item) => item.skill === skill,
    );
  return (
    <section aria-label="听读选材计划">
      {!!preferences?.questionTypes[skill].length && <p>本周日常选材按已采纳建议优先弱项题型；整套测评和分钟预算保持原安排。</p>}
      <h2>{requiresFull ? "本次整套测评" : "今天的听读选材"}</h2>
      {selected.official && (
        <p>
          先做官方题型校准（约5分钟）：{selected.official.title}{" "}
          {selected.officialDone ? "· 今天已保存" : ""}{" "}
          <button
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onChoose(selected.official!)}
          >
            打开官方题型练习
          </button>
        </p>
      )}
      {selected.practice && (
        <p>
          {requiresFull ? "整套" : "正篇／单节"}：{selected.practice.title} ·{" "}
          {MATERIAL_SOURCE_LABELS[selected.practice.source.materialSource]}{" "}
          <button
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => onChoose(selected.practice!)}
          >
            打开推荐材料
          </button>
        </p>
      )}
      {selected.notice && <p>{selected.notice}</p>}
      <p><a href="#/review?tab=coverage">查看题库完整性与全年缺口</a></p>
      <p>
        {requiresFull
          ? "整套保留原测评时间，官方题型与复盘使用当天已有复盘预算，不增加120分钟总预算。"
          : "选材占用本块已有预算；若今天有泛读泛听卡，先从同一预算划出10–15分钟，剩余时间做题型练习。"}
      </p>
      <details>
        <summary>前14天题库与备用池</summary>
        <p>
          备用阅读 {selected.schedule.readingReserve.length}/14
          篇。P1→P3作为选材阶梯，用实际正确率校准；出现频率不代表难度。
        </p>
        {selected.schedule.shortages.length ? (
          <ul>
            {selected.schedule.shortages.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>前14天与阅读备用池已具备所需材料。</p>
        )}
      </details>
      {!!calibration.length && (
        <details>
          <summary>官方题型校准正确率</summary>
          <p>只统计官方样题的新首答，排除存疑题；短练不换算整套分。</p>
          <ul>
            {calibration.map((item) => (
              <li key={item.questionType}>
                {item.questionType}：{item.correct}/{item.total}（
                {Math.round((item.accuracy ?? 0) * 100)}%）
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function readingDailyRequirements(
  records: readonly Revision[],
  planId: string,
  date: string,
  taskId: string,
) {
  const reviewed = currentAttempts(records, planId).filter(
    (r) =>
      r.payload.skill === "reading" &&
      r.payload.date === date &&
      r.payload.taskId === taskId &&
      Array.isArray(r.payload.questionResults) &&
      r.payload.questionResults.length > 0 &&
      r.payload.questionResults.every(
        (q) =>
          !!q &&
          typeof q === "object" &&
          "reviewCorrect" in q &&
          typeof q.reviewCorrect === "boolean",
      ),
  );
  const official = reviewed.some(
    (r) =>
      r.payload.materialSource === "official" &&
      r.payload.scope === "type-drill",
  );
  const article = reviewed.some(
    (r) =>
      ["section", "full"].includes(String(r.payload.scope)) &&
      r.payload.firstAttempt === true,
  );
  return { official, article, complete: official && article };
}
