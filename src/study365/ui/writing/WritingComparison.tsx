import type { Revision } from "../../protocol";
import { paragraphDiff } from "../../writingDiff";
export function WritingComparison({
  previous,
  current,
}: {
  previous: Revision;
  current: Revision;
}) {
  if (previous.planId !== current.planId) return null;
  const rows = paragraphDiff(
    String(previous.payload.text ?? ""),
    String(current.payload.text ?? ""),
  );
  return (
    <section className="panel" aria-label="修改稿对比">
      <h2>修改稿对比</h2>
      <p className="muted">删除标在上一版，新增标在这一版。</p>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 480 }}>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}
          >
            <h3>上一版</h3>
            <h3>这一版</h3>
          </div>
          {rows.map((row, index) => (
            <div
              key={index}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
                gap: 20,
                marginBottom: 20,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              <p>
                {row.changes
                  .filter((change) => change.kind !== "add")
                  .map((change, i) =>
                    change.kind === "remove" ? (
                      <del key={i} style={{ background: "#fbe4e4" }}>
                        {change.text}
                      </del>
                    ) : (
                      <span key={i}>{change.text}</span>
                    ),
                  )}
              </p>
              <p>
                {row.changes
                  .filter((change) => change.kind !== "remove")
                  .map((change, i) =>
                    change.kind === "add" ? (
                      <ins key={i} style={{ background: "#ddf5e7" }}>
                        {change.text}
                      </ins>
                    ) : (
                      <span key={i}>{change.text}</span>
                    ),
                  )}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
