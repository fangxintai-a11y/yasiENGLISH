import type { Revision } from "../../protocol";
import { speakingListSummary } from "../../speakingList";
import { speakingCauseOptions } from "../../speakingRubric";

const causeLabels = new Map(
  speakingCauseOptions().map((item) => [item.id, item.label]),
);
export function SpeakingWorkList({
  works,
  records,
  disabled,
  onOpen,
}: {
  works: readonly Revision[];
  records: readonly Revision[];
  disabled: boolean;
  onOpen: (work: Revision) => void;
}) {
  return (
    <section
      className="panel"
      aria-label="我的口语"
      data-testid="speaking-work-list"
    >
      <h2>我的口语</h2>
      {!works.length ? (
        <p>尚未保存作答。</p>
      ) : (
        works.map((work) => {
          const summary = speakingListSummary(work, records);
          return (
            <article key={work.id} className="panel">
              <button
                type="button"
                className="link"
                disabled={disabled}
                data-work-id={work.id}
                data-revision-id={work.revisionId}
                onClick={() => onOpen(work)}
              >
                {String(work.payload.date ?? "日期未记录")} · Part{" "}
                {summary.part ?? "未知"} ·{" "}
                {summary.durationSeconds === null
                  ? "时长未记录"
                  : `${summary.durationSeconds.toFixed(1)}秒`}
              </button>
              <p className="muted">
                {summary.part === 2 && (
                  <>
                    {summary.part2Full === null
                      ? "说满情况未记录"
                      : summary.part2Full
                        ? "已说满120秒"
                        : "未说满120秒"}{" "}
                    ·{" "}
                  </>
                )}
                {summary.hasRecordingReference
                  ? "已关联录音（本机文件由播放器检查）"
                  : "无录音引用"}{" "}
                · {summary.hasTranscript ? "有转写" : "无转写"} ·{" "}
                {summary.hasHumanCalibration
                  ? "已有真人四维评阅"
                  : "真人未评估"}
              </p>
              <p className="muted">
                错因：
                {summary.errorCauses.length
                  ? summary.errorCauses
                      .map((cause) => causeLabels.get(cause) ?? cause)
                      .join("、")
                  : "尚未标记"}
              </p>
            </article>
          );
        })
      )}
    </section>
  );
}
