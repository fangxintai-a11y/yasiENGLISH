import { canonical, type LearningPayload, type Revision } from "./protocol";
import { draftFromRevision } from "./writingDrafts";
import type { WritingDraft } from "./writingModel";
import type { WritingMode } from "./writingTasks";

function content(payload: LearningPayload) {
  const fields = [
    "taskType",
    "date",
    "day",
    "taskId",
    "contentId",
    "contentVersion",
    "sourceRef",
    "parentRevisionId",
    "prompt",
    "text",
  ];
  const value = Object.fromEntries(
    fields
      .filter(
        (key) =>
          payload[key] !== undefined &&
          payload[key] !== null &&
          payload[key] !== "",
      )
      .map((key) => [key, payload[key]]),
  );
  const conditions = payload.conditions as Record<string, unknown> | undefined;
  return {
    ...value,
    scope: payload.scope ?? "full",
    conditions: {
      firstAttempt: !!conditions?.firstAttempt,
      unseen: !!conditions?.unseen,
    },
  };
}
function draftContent(draft: WritingDraft) {
  return content({
    ...draft,
    prompt: draft.tableDescription?.trim()
      ? `${draft.prompt}\n\n题图文字说明：${draft.tableDescription.trim()}`
      : draft.prompt,
  });
}
export function writingDraftIsDirty(
  draft: WritingDraft,
  base?: Revision,
): boolean {
  return (
    !base ||
    base.revisionId !== draft.baseRevision ||
    base.id !== draft.recordId ||
    canonical(draftContent(draft)) !== canonical(content(base.payload))
  );
}
function fromHead(local: WritingDraft, head: Revision): WritingDraft {
  const restored = draftFromRevision(head);
  return {
    ...restored,
    timer:
      local.scope === restored.scope
        ? { ...restored.timer, limitSeconds: local.timer.limitSeconds }
        : restored.timer,
    id: local.id,
    outline: local.outline,
    ...(local.contentId === head.payload.contentId &&
    local.contentVersion === head.payload.contentVersion
      ? { materialSelfCheck: local.materialSelfCheck }
      : {}),
  };
}
/** Unknown bases are conservative: keep the learner's version, including its CAS base. */
export function recoverWritingDraft(
  local: WritingDraft,
  head: Revision | undefined,
  history: readonly Revision[],
): WritingDraft {
  if (
    !head ||
    head.id !== local.recordId ||
    head.planId !== local.planId ||
    head.revisionId === local.baseRevision
  )
    return local;
  const base = history.find(
    (record) =>
      record.revisionId === local.baseRevision && record.id === local.recordId,
  );
  if (writingDraftIsDirty(local, base)) return local;
  return fromHead(local, head);
}
/** The record transaction may commit before local-draft persistence fails. */
export function adoptCommittedWritingHead(
  draft: WritingDraft,
  head?: Revision,
): WritingDraft | null {
  if (
    !head ||
    head.kind !== "essay" ||
    head.id !== draft.recordId ||
    head.planId !== draft.planId ||
    head.conflict ||
    head.deleted ||
    head.revisionId === draft.baseRevision ||
    canonical(draftContent(draft)) !== canonical(content(head.payload))
  )
    return null;
  if (head.payload.stage !== "draft") return fromHead(draft, head);
  return {
    ...draft,
    baseRevision: head.revisionId,
    stage: "draft",
    updatedAt: Date.now(),
    timer: {
      ...draft.timer,
      elapsedSeconds: Number(
        head.payload.elapsedSeconds ?? draft.timer.elapsedSeconds,
      ),
      runningSince: draft.timer.runningSince === null ? null : Date.now(),
    },
  };
}
/** A local chosen head descends from the canonical sibling, unlike the original
 * conflicting edit, whose base is still the common checkpoint. No history is removed. */
export function unresolvedWritingConflicts(
  head: Revision | undefined,
  revisions: readonly Revision[],
): Revision[] {
  if (!head) return [];
  const byId = new Map(
    revisions
      .filter(
        (record) =>
          record.kind === "essay" &&
          record.id === head.id &&
          record.planId === head.planId,
      )
      .map((record) => [record.revisionId, record]),
  );
  const conflicts = [...byId.values()].filter(
    (record) => record.conflict && !record.deleted && record.seq >= head.seq,
  );
  if (head.seq > 0) return conflicts.filter((record) => record.seq > head.seq);
  const ancestors: Revision[] = [];
  let cursor = head.baseRevision;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const ancestor = byId.get(cursor);
    if (!ancestor) break;
    ancestors.push(ancestor);
    cursor = ancestor.baseRevision;
  }
  return conflicts.filter(
    (conflict) =>
      !ancestors.some(
        (ancestor) =>
          !ancestor.conflict &&
          !ancestor.deleted &&
          ancestor.seq > 0 &&
          ancestor.baseRevision === conflict.baseRevision &&
          ancestor.revisionId !== conflict.revisionId,
      ),
  );
}
export function restoredWritingMode(
  drafts: readonly WritingDraft[],
  fallback: WritingMode,
): WritingMode {
  if (
    fallback === "pair" &&
    ["task1", "task2"].every((type) =>
      drafts.some((draft) => draft.taskType === type && draft.scope === "full"),
    )
  )
    return "pair";
  const latest = [...drafts].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest
    ? latest.scope === "paragraph"
      ? "paragraph"
      : latest.taskType
    : fallback;
}
