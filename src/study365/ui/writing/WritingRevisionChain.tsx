import type { Revision } from "../../protocol";
import { writingRevisionChain } from "../../writingDiff";
export function WritingRevisionChain({
  work,
  records,
  onSelect,
}: {
  work: Revision;
  records: readonly Revision[];
  onSelect?: (work: Revision) => void;
}) {
  const chain = writingRevisionChain(work, records);
  return (
    <section className="panel" aria-label="写作修改链">
      <h2>修改链</h2>
      {chain.missingParent && (
        <p className="muted">部分早期修订尚未读取，历史引用仍保留。</p>
      )}
      {chain.cycle && <p role="alert">修订引用有循环，请保留原记录并检查。</p>}
      <ol>
        {chain.items.map((item, index) => (
          <li key={item.revisionId}>
            {onSelect ? (
              <button
                type="button"
                className="link"
                aria-current={
                  item.revisionId === work.revisionId ? "step" : undefined
                }
                onClick={() => onSelect(item)}
              >
                {!chain.missingParent && index === 0
                  ? "首稿"
                  : `修改稿 ${index}`}{" "}
                · {String(item.payload.date ?? "日期未记录")}
              </button>
            ) : (
              <span>
                {!chain.missingParent && index === 0
                  ? "首稿"
                  : `修改稿 ${index}`}{" "}
                · {String(item.payload.date ?? "日期未记录")}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
