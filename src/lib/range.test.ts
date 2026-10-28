import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

// The Range logic lives in public/sw.js (plain JS, no modules). Run that exact block here.
const sw = fs.readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const block = /\/\/ <range-helper>[^\n]*\n([\s\S]*?)\/\/ <\/range-helper>/.exec(sw)?.[1];
if (!block) throw new Error("range-helper block missing from public/sw.js");

type Range = { start: number; end: number } | "unsatisfiable" | null;
const { parseRange, sliceResponse } = new Function(`${block}; return { parseRange, sliceResponse };`)() as {
  parseRange: (header: string | null, size: number) => Range;
  sliceResponse: (full: Response, header: string | null) => Promise<Response>;
};

test("parseRange handles open, closed and suffix ranges", () => {
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
});

test("parseRange clamps past the end and handles a suffix longer than the body", () => {
  assert.deepEqual(parseRange("bytes=50-5000", 100), { start: 50, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
});

test("parseRange flags unsatisfiable ranges and ignores unusable headers", () => {
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseRange("bytes=9-2", 100), null);
  assert.equal(parseRange("bytes=0-1,5-6", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  assert.equal(parseRange("bytes=-", 100), null);
  assert.equal(parseRange(null, 100), null);
});

const full = () => new Response(new Uint8Array(Array.from({ length: 100 }, (_, i) => i)), { headers: { "Content-Type": "audio/mpeg" } });

test("sliceResponse answers 206 with the right bytes and headers", async () => {
  const res = await sliceResponse(full(), "bytes=10-19");
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 10-19/100");
  assert.equal(res.headers.get("Content-Length"), "10");
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  assert.equal(res.headers.get("Content-Type"), "audio/mpeg");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], Array.from({ length: 10 }, (_, i) => 10 + i));
});

test("sliceResponse covers bytes=0-, suffix, 416 and a fallback to the full body", async () => {
  const open = await sliceResponse(full(), "bytes=0-");
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("Content-Range"), "bytes 0-99/100");
  assert.equal((await open.arrayBuffer()).byteLength, 100);

  const tail = await sliceResponse(full(), "bytes=-4");
  assert.equal(tail.headers.get("Content-Range"), "bytes 96-99/100");
  assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [96, 97, 98, 99]);

  const bad = await sliceResponse(full(), "bytes=500-");
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("Content-Range"), "bytes */100");

  const whole = await sliceResponse(full(), "bytes=1-2,5-6");
  assert.equal(whole.status, 200);
  assert.equal((await whole.arrayBuffer()).byteLength, 100);
});
