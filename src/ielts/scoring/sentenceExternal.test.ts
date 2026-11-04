import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { acceptManual, saveFeedbackConfig, scoreSentence, type SentenceResult } from "./index";
import { SentenceGradeSchema } from "./schemas";
import { ERROR_CAUSES } from "../../study365/protocol";

const input = { word: "benefit", zh: "益处", sentence: "Residents benefit from a reliable service in their own community.", entry: null };
const body = { score: 2, usedCorrectly: true, verdict: "表达基本清楚。", corrected: input.sentence, better: "Reliable services benefit the whole community.", notes: [] };
const evidence = [{ kind: "metric", metric: "wordCount", value: 12, message: "词数证据。" }, { kind: "rule", ruleId: "external.collocation", message: "已核对搭配。" }];
const span = { kind: "span", text: "benefit", start: input.sentence.indexOf("benefit"), end: input.sentence.indexOf("benefit") + "benefit".length, message: "目标词位于原句。" };
async function manual(extra: Record<string, unknown>) {
  return acceptManual<SentenceResult>("sentence", JSON.stringify({ ...body, ...extra }), input);
}
async function automatic(wire: unknown, check: (result: SentenceResult, requests: RequestInit[]) => void) {
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), fetchBefore = globalThis.fetch;
  const data = new Map<string, string>(), requests: RequestInit[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) } });
  globalThis.fetch = async (_url, init) => { requests.push(init ?? {}); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wire) } }] }), { status: 200 }); };
  try {
    saveFeedbackConfig({ version: 1, providers: [{ id: "sentence-fixture", kind: "openai-compatible", label: "测试接口", baseURL: "https://sentence.example/v1", model: "user-selected", jsonMode: "json_schema", timeoutMs: 1000, tasks: ["sentence"] }] });
    check(await scoreSentence(input, { mode: "auto", now: 1 }), requests);
  } finally {
    globalThis.fetch = fetchBefore;
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("manual sentence preserves low confidence and legitimate rule/metric evidence", async () => {
  const result = await manual({ confidence: .15, evidence, cause: "synonym-miss" });
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.value.confidence, .15); assert.deepEqual(result.value.evidence, evidence); assert.equal(result.value.cause, "synonym-miss");
});
test("manual sentence keeps zero confidence instead of using the default", async () => {
  const result = await manual({ confidence: 0, evidence: [], cause: null });
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.confidence, 0);
});
test("all sixteen P1 error cause codes survive manual sentence feedback", async () => {
  for (const cause of ERROR_CAUSES) {
    const result = await manual({ cause });
    assert.equal(result.ok, true, cause); if (result.ok) assert.equal(result.value.cause, cause);
  }
});
for (const [label, cause] of [["unknown string", "invented-cause"], ["number", 42], ["object", { unexpected: true }]] as const) {
  test(`invalid sentence cause ${label} becomes null with an auditable warning`, async () => {
    const result = await manual({ cause });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.value.cause, null);
    assert.ok(result.value.warnings?.some((warning) => /cause/.test(warning) && /无效/.test(warning)));
  });
}
test("legacy sentence payload without metadata retains its previous defaults", async () => {
  const result = await manual({}); assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.value.confidence, .6); assert.deepEqual(result.value.evidence, []); assert.equal(result.value.cause, null);
  assert.equal(result.value.warnings?.length ?? 0, 0);
});
test("sentence cause warning survives the second strict schema parse", () => {
  const once = SentenceGradeSchema.parse({ ...body, cause: "invented-cause" });
  assert.equal(once.cause, null); assert.equal(once.warnings?.length, 1);
  assert.deepEqual(SentenceGradeSchema.parse(once), once);
});
test("invalid sentence cause reserves one warning slot through manual acceptance and repeated parses", async () => {
  const warnings = Array.from({ length: 16 }, (_, index) => `原有提示${index + 1}`);
  const result = await manual({ cause: "invented-cause", warnings });
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.value.score, body.score); assert.equal(result.value.cause, null);
  assert.equal(result.value.warnings?.length, 16);
  assert.match(result.value.warnings![0], /cause.*无效/);
  assert.deepEqual(result.value.warnings!.slice(1), warnings.slice(0, 15));
  const once = SentenceGradeSchema.parse({ ...body, cause: "invented-cause", warnings });
  const twice = SentenceGradeSchema.parse(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.warnings?.filter((warning) => /cause.*无效/.test(warning)).length, 1);
});
test("a secret in the warning that would be truncated is rejected before normalisation", async () => {
  const secret = "sk-" + "A".repeat(24);
  const warnings = [...Array.from({ length: 15 }, (_, index) => `原有提示${index + 1}`), secret];
  const escaped = [...secret].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const pasted = JSON.stringify({ ...body, cause: "invented-cause", warnings }).replace(secret, escaped);
  const result = await acceptManual<SentenceResult>("sentence", pasted, input);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.errors.join(" "), /密钥/); assert.equal(result.errors.join(" ").includes(secret), false); }
});
test("warning truncation does not hide an invalid final warning type", async () => {
  const result = await manual({ cause: "invented-cause", warnings: [...Array.from({ length: 15 }, (_, index) => `原有提示${index + 1}`), 42] });
  assert.equal(result.ok, false); if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("warnings.15：")));
});
test("invalid cause does not make an already oversized warning list acceptable", async () => {
  const result = await manual({ cause: "invented-cause", warnings: Array.from({ length: 17 }, (_, index) => `原有提示${index + 1}`) });
  assert.equal(result.ok, false); if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("warnings：")));
});
test("automatic sentence feedback preserves optional metadata after full schema round trip", async () => {
  await automatic({ ...body, confidence: .2, evidence, cause: "grammar" }, (result, requests) => {
    assert.equal(result.source, "ai"); assert.equal(result.provider, "sentence-fixture"); assert.equal(requests.length, 1);
    assert.equal(result.confidence, .2); assert.deepEqual(result.evidence, evidence); assert.equal(result.cause, "grammar");
  });
});
test("automatic invalid cause returns a null code and the warning instead of losing the result", async () => {
  await automatic({ ...body, confidence: .1, evidence: [], cause: "invented-cause" }, (result, requests) => {
    assert.equal(result.source, "ai"); assert.equal(result.cause, null); assert.equal(requests.length, 1);
    assert.ok(result.warnings?.some((warning) => /cause/.test(warning) && /无效/.test(warning)));
  });
});
test("sentence span matching the original offsets is preserved", async () => {
  const result = await manual({ confidence: .3, evidence: [span], cause: null });
  assert.equal(result.ok, true); if (result.ok) assert.deepEqual(result.value.evidence, [span]);
});
test("a changed sentence span start is rejected at its concrete evidence path", async () => {
  const result = await manual({ evidence: [{ ...span, start: span.start + 1 }] });
  assert.equal(result.ok, false); if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("evidence.0：")), JSON.stringify(result.errors));
});
test("a sentence span cannot claim an end beyond the original length", async () => {
  const result = await manual({ evidence: [{ kind: "span", text: input.sentence, start: 0, end: input.sentence.length + 1, message: "检查原句范围。" }] });
  assert.equal(result.ok, false); if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("evidence.0：")));
});
test("automatic fabricated sentence spans repair once then fall back", async () => {
  await automatic({ ...body, evidence: [{ ...span, start: span.start + 1 }] }, (result, requests) => {
    assert.equal(result.source, "rules"); assert.equal(requests.length, 2); assert.equal(result.needsManual, true);
    assert.equal(result.fallbackTrail[0]?.error, "schema");
  });
});
for (const confidence of [-.01, 1.01, "0.5", null]) test(`invalid sentence confidence ${String(confidence)} is rejected without coercion`, async () => {
  const result = await manual({ confidence }); assert.equal(result.ok, false);
});
test("an evidence metric without its value remains invalid", async () => {
  const result = await manual({ evidence: [{ kind: "metric", metric: "wordCount", message: "缺少测量值。" }] });
  assert.equal(result.ok, false); if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("evidence.0.metric：")));
});
test("unrelated sentence fields remain strictly rejected", async () => {
  const result = await manual({ debug: "unrelated" }); assert.equal(result.ok, false);
});
test("sentence JSON Schema advertises optional metadata and only valid cause codes", () => {
  const schema = z.toJSONSchema(SentenceGradeSchema);
  const serialized = JSON.stringify(schema);
  assert.ok(serialized.includes('"confidence"')); assert.ok(serialized.includes('"evidence"')); assert.ok(serialized.includes('"cause"'));
  for (const cause of ERROR_CAUSES) assert.ok(serialized.includes(JSON.stringify(cause)));
  assert.equal(schema.additionalProperties, false);
});
