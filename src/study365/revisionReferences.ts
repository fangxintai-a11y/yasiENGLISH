import type { Revision } from "./protocol";
let references: readonly Revision[] = [];
/** Account-owned immutable revisions, replaced only by the active repository refresh. */
export function replaceRevisionReferences(value: readonly Revision[]) {
  references = value;
}
export function withRevisionReferences(heads: readonly Revision[]): Revision[] {
  const seen = new Set(heads.map((r) => r.revisionId));
  return [...heads, ...references.filter((r) => !seen.has(r.revisionId))];
}
