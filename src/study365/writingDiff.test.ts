import assert from "node:assert/strict";
import test from "node:test";
import { paragraphDiff, wordDiff, writingRevisionChain } from "./writingDiff";
import type { Revision } from "./protocol";
const record = (id: string, parent?: string): Revision => ({
  id,
  revisionId: id,
  kind: "essay",
  datasetId: null,
  planId: "plan",
  baseRevision: null,
  seq: 1,
  createdAt: 1,
  deleted: false,
  conflict: false,
  contentHash: "a".repeat(64),
  payload: {
    planId: "plan",
    text: id,
    ...(parent ? { parentRevisionId: parent } : {}),
  },
});
test("word differences preserve every source character and distinguish changed words", () => {
  const before = "A small train.\n😀 stays.",
    after = "A fast train.\n😀 remains.";
  const result = wordDiff(before, after);
  assert.equal(
    result
      .filter((x) => x.kind !== "add")
      .map((x) => x.text)
      .join(""),
    before,
  );
  assert.equal(
    result
      .filter((x) => x.kind !== "remove")
      .map((x) => x.text)
      .join(""),
    after,
  );
  assert.ok(
    result.some((x) => x.kind === "remove" && x.text.includes("small")),
  );
  assert.ok(result.some((x) => x.kind === "add" && x.text.includes("fast")));
  assert.ok(result.some((x) => x.kind === "equal" && x.text.includes("train")));
  assert.deepEqual(wordDiff("", "new"), [{ kind: "add", text: "new" }]);
  assert.deepEqual(wordDiff("old", ""), [{ kind: "remove", text: "old" }]);
  assert.deepEqual(wordDiff("same", "same"), [{ kind: "equal", text: "same" }]);
});
test("paragraph alignment retains unchanged anchors after a new paragraph", () => {
  const rows = paragraphDiff(
    "First.\n\nOld middle.\n\nLast.",
    "First.\n\nNew middle.\n\nAdded.\n\nLast.",
  );
  assert.equal(rows[0].before, rows[0].after);
  assert.equal(rows.at(-1)?.before, "Last.");
  assert.equal(rows.at(-1)?.after, "Last.");
  assert.ok(rows.some((r) => r.before === "" && r.after === "Added."));
});
test("revision chain follows exact submitted parents and excludes another plan", () => {
  const first = record("first"),
    second = record("second", "first"),
    third = record("third", "second");
  assert.deepEqual(
    writingRevisionChain(third, [second, first]).items.map((r) => r.id),
    ["first", "second", "third"],
  );
  assert.equal(
    writingRevisionChain(third, [{ ...second, planId: "other" }, first])
      .missingParent,
    true,
  );
  assert.equal(
    writingRevisionChain(third, [second, first]).missingParent,
    false,
  );
});
test("incomplete or cyclic history stays bounded without inventing originals", () => {
  const one = record("one", "two"),
    two = record("two", "one");
  assert.equal(writingRevisionChain(one, [two]).cycle, true);
  assert.equal(writingRevisionChain(one, []).missingParent, true);
});
