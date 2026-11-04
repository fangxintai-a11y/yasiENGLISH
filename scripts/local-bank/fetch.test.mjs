import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

test("official fetch uses local file fixtures, skips validated bytes and logs individual failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-fetch-fixture-"));
  try {
    const source = path.join(root, "source.pdf"),
      out = path.join(root, "downloaded"),
      manifest = path.join(root, "manifest.json");
    const original = Buffer.from("Original synthetic PDF test bytes\n");
    await fs.writeFile(source, original);
    const hash = createHash("sha256").update(original).digest("hex");
    const files = [
      {
        id: "good",
        path: "fixture.pdf",
        url: pathToFileURL(source).href,
        sha256: hash,
      },
      {
        id: "missing",
        path: "missing.pdf",
        url: pathToFileURL(path.join(root, "absent.pdf")).href,
      },
    ];
    await fs.writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        sourcePage: "self-authored local fixture",
        files,
      }),
    );
    const run = () =>
      spawnSync(
        "bash",
        ["scripts/fetch-official-samples.sh", out, "--manifest", manifest],
        { encoding: "utf8" },
      );
    let child = run();
    assert.equal(child.status, 0, child.stderr);
    let report = JSON.parse(
      await fs.readFile(path.join(out, "fetch-log.json"), "utf8"),
    );
    assert.equal(report.files[0].status, "downloaded");
    assert.equal(report.files[1].status, "failed");
    assert.deepEqual(
      await fs.readFile(path.join(out, "fixture.pdf")),
      original,
    );
    child = run();
    assert.equal(child.status, 0, child.stderr);
    report = JSON.parse(
      await fs.readFile(path.join(out, "fetch-log.json"), "utf8"),
    );
    assert.equal(report.files[0].status, "skipped");
    files[0].sha256 = "0".repeat(64);
    await fs.writeFile(
      manifest,
      JSON.stringify({ schemaVersion: 1, files: [files[0]] }),
    );
    run();
    report = JSON.parse(
      await fs.readFile(path.join(out, "fetch-log.json"), "utf8"),
    );
    assert.equal(report.files[0].status, "failed");
    assert.match(report.files[0].error, /SHA256/);
    assert.deepEqual(
      await fs.readFile(path.join(out, "fixture.pdf")),
      original,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
