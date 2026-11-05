import type { Revision } from "./protocol";
export interface WordChange {
  kind: "equal" | "add" | "remove";
  text: string;
}
function lengths(a: readonly string[], b: readonly string[]): Uint32Array {
  let row = new Uint32Array(b.length + 1);
  for (const value of a) {
    const next = new Uint32Array(b.length + 1);
    for (let j = 0; j < b.length; j++)
      next[j + 1] = value === b[j] ? row[j] + 1 : Math.max(next[j], row[j + 1]);
    row = next;
  }
  return row;
}
/** Hirschberg LCS keeps memory linear even when a long paragraph is replaced. */
function pairs(
  a: readonly string[],
  b: readonly string[],
  offsetA = 0,
  offsetB = 0,
): [number, number][] {
  if (!a.length || !b.length) return [];
  if (a.length === 1) {
    const at = b.indexOf(a[0]);
    return at < 0 ? [] : [[offsetA, offsetB + at]];
  }
  const half = Math.floor(a.length / 2),
    left = lengths(a.slice(0, half), b),
    right = lengths([...a.slice(half)].reverse(), [...b].reverse());
  let split = 0,
    best = -1;
  for (let j = 0; j <= b.length; j++) {
    const n = left[j] + right[b.length - j];
    if (n > best) {
      best = n;
      split = j;
    }
  }
  return [
    ...pairs(a.slice(0, half), b.slice(0, split), offsetA, offsetB),
    ...pairs(a.slice(half), b.slice(split), offsetA + half, offsetB + split),
  ];
}
function sequenceDiff(a: string[], b: string[]): WordChange[] {
  const output: WordChange[] = [];
  let i = 0,
    j = 0;
  for (const [x, y] of [...pairs(a, b), [a.length, b.length]]) {
    while (i < x) output.push({ kind: "remove", text: a[i++] });
    while (j < y) output.push({ kind: "add", text: b[j++] });
    if (x < a.length) {
      output.push({ kind: "equal", text: a[i++] });
      j++;
    }
  }
  return output;
}
const tokens = (text: string) =>
  text.match(/\s+|[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[^\s]/gu) ?? [];
export function wordDiff(before: string, after: string): WordChange[] {
  const merged: WordChange[] = [];
  for (const item of sequenceDiff(tokens(before), tokens(after))) {
    const previous = merged.at(-1);
    if (previous?.kind === item.kind) previous.text += item.text;
    else merged.push({ ...item });
  }
  return merged;
}
export function paragraphDiff(
  before: string,
  after: string,
): { before: string; after: string; changes: WordChange[] }[] {
  const paragraphs = (text: string) =>
    text ? text.split(/\r?\n[ \t]*\r?\n/) : [];
  const rows: { before: string; after: string; changes: WordChange[] }[] = [],
    removed: string[] = [],
    added: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      const a = removed[i] ?? "",
        b = added[i] ?? "";
      rows.push({ before: a, after: b, changes: wordDiff(a, b) });
    }
    removed.length = 0;
    added.length = 0;
  };
  for (const item of sequenceDiff(paragraphs(before), paragraphs(after))) {
    if (item.kind === "equal") {
      flush();
      rows.push({ before: item.text, after: item.text, changes: [item] });
    } else (item.kind === "remove" ? removed : added).push(item.text);
  }
  flush();
  return rows;
}
export function writingRevisionChain(
  work: Revision,
  records: readonly Revision[],
) {
  const byId = new Map(
    records
      .filter(
        (record) =>
          record.kind === "essay" &&
          record.planId === work.planId &&
          !record.deleted,
      )
      .map((record) => [record.revisionId, record]),
  );
  byId.set(work.revisionId, work);
  const items: Revision[] = [],
    seen = new Set<string>();
  let current: Revision | undefined = work,
    missingParent = false,
    cycle = false;
  while (current) {
    if (seen.has(current.revisionId)) {
      cycle = true;
      break;
    }
    seen.add(current.revisionId);
    items.push(current);
    const parent = current.payload.parentRevisionId;
    if (typeof parent !== "string") break;
    current = byId.get(parent);
    if (!current) missingParent = true;
  }
  return { items: items.reverse(), missingParent, cycle };
}
