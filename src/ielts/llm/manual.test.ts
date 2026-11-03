import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createManualPrompt, validateManualResult } from "./manual";
const schema = z.strictObject({ band: z.number().min(0).max(9).refine((n) => Number.isInteger(n * 2)) });
test("manual prompt includes JSON Schema and accepts a fenced valid result", () => {
  assert.match(createManualPrompt("评分说明", "待评作品", schema).text, /JSON Schema/);
  assert.deepEqual(validateManualResult('```json\n{"band":7.5}\n```', schema), { ok: true, value: { band: 7.5 } });
});
test("manual invalid JSON and invalid band produce Chinese errors", () => {
  for (const raw of ['{"band":7.3}', "not a result"]) {
    const result = validateManualResult(raw, schema);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.every((error) => /[\u4e00-\u9fff]/.test(error)));
  }
});
