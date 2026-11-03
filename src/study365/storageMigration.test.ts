import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLearningScopes, orderMutations, userScopeKey } from "./db";
import { emptyScope, type LearningScope, type Revision } from "./protocol";

const revision = (id: string, datasetId: string, seq: number): Revision => ({ id, datasetId, kind: "plan", planId: id,
  revisionId: `revision-${id}`, baseRevision: null, seq, payload: { datasetId, planId: id, targetBand: 7, studyBudgetMinutes: 150 },
  contentHash: "original-hash", createdAt: seq + 1, conflict: false, deleted: false });
const scope = (item: Revision, cursor: number): LearningScope => ({ ...emptyScope(), cursor, heads: { [item.id]: item }, revisions: { [item.revisionId]: item } });

test("user scope does not contain or change with a vocabulary bank", () => {
  assert.equal(userScopeKey("account-a"), "account:account-a");
  assert.notEqual(userScopeKey("account-a"), userScopeKey("account-b"));
});

test("dataset scopes merge all raw plans without rewriting historical hashes or payloads", () => {
  const a = revision("plan-a", "bank-a", 15), b = revision("plan-b", "bank-b", 23);
  const first = scope(a, 100), second = scope(b, 120);
  const result = mergeLearningScopes([first, second]);
  assert.deepEqual(Object.keys(result.heads).sort(), ["plan-a", "plan-b"]);
  assert.deepEqual(result.revisions[a.revisionId], a);
  assert.deepEqual(result.revisions[b.revisionId], b);
  assert.equal(result.cursor, 0, "old per-bank cursors must replay the user's full change stream");
  assert.equal(first.cursor, 100);
});

test("same immutable revision ID with different contents aborts migration", () => {
  const a = revision("plan-a", "bank-a", 15);
  const altered = { ...a, payload: { ...a.payload, title: "different" } };
  assert.throws(() => mergeLearningScopes([scope(a, 1), scope(altered, 2)]), /修订ID但内容不同/);
});

test("unsent requests and quarantine survive merge with unchanged IDs and bytes", () => {
  const item = revision("plan-a", "bank-a", 0), first = scope(item, 20);
  const request = { recordId: item.id, body: { schemaVersion: 1 as const, revisionId: item.revisionId, mutationId: "old-mutation", baseRevision: null, kind: item.kind, payload: item.payload }, local: item, createdAt: 100 };
  first.outbox = [request];
  const second = { ...emptyScope(), quarantine: [{ ...request, error: "needs repair", code: "invalid_learning_record", at: 200 }] };
  const merged = mergeLearningScopes([first, second]);
  assert.deepEqual(merged.outbox, []);
  assert.deepEqual(merged.quarantine[0].body, request.body);
  assert.deepEqual(merged.heads[item.id], item);
});

test("clock skew cannot queue feedback before its original work and plan", () => {
  const plan = revision("plan-a", "bank-a", 0), essay = { ...revision("essay-a", "bank-a", 0), kind: "essay" as const, planId: plan.id };
  const make = (item: Revision, createdAt: number, payload: Record<string, unknown>) => ({ recordId: item.id,
    body: { schemaVersion: 1 as const, revisionId: item.revisionId, mutationId: `mutation-${item.id}`, baseRevision: null, kind: item.kind, payload }, local: item, createdAt });
  const p = make(plan, 300, { planId: plan.id });
  const e = make(essay, 200, { planId: plan.id });
  const f = make({ ...revision("feedback-a", "bank-a", 0), kind: "feedback", planId: plan.id }, 100, { planId: plan.id, workRevisionId: essay.revisionId });
  assert.deepEqual(orderMutations([f, e, p]).map((item) => item.recordId), [plan.id, essay.id, f.recordId]);
  assert.equal(f.body.mutationId, "mutation-feedback-a");
});
