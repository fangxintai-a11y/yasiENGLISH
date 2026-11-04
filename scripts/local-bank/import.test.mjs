import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as cli from "../import-local-bank.mjs";
import { hashLocalMaterial } from "../../src/study365/localBankSchema.ts";
import { decodeLocalBankArchive } from "../../src/study365/localBankArchive.ts";

test("pack requires explicit selection and preserves selected material in a small verifiable ZIP", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-bank-cli-"));
  try {
    const material = {
      id: "self-authored-cli",
      version: "1",
      skill: "reading",
      title: "Original test text",
      source: {
        materialSource: "unofficial",
        sourceRef: "self-authored-cli",
        rights: "Original test fixture",
        answerVerified: false,
      },
      scope: "section",
      deliveryMode: "local-import",
      contentHash: "0".repeat(64),
      passage: "The fictional gate is blue.",
      paragraphs: [{ id: "pa", text: "The fictional gate is blue." }],
      passageNumber: 1,
      questions: [
        {
          id: "q1",
          type: "sentence-completion",
          prompt: "The gate is ____.",
          answer: { accepted: ["blue"], maxWords: 1 },
          evidence: {},
          answerVerified: false,
        },
      ],
    };
    material.contentHash = await hashLocalMaterial(material);
    const bank = path.join(root, "bank.json");
    await fs.writeFile(
      bank,
      JSON.stringify({ importVersion: 1, materials: [material] }),
    );
    assert.equal(typeof cli.packLocalBank, "function");
    await assert.rejects(
      cli.packLocalBank({ from: bank, out: path.join(root, "no.zip") }),
      /ids|book|limit|选择/,
    );
    const result = await cli.packLocalBank({
      from: bank,
      ids: material.id,
      out: path.join(root, "selected.zip"),
    });
    assert.equal(result.materials, 1);
    const decoded = await decodeLocalBankArchive(
      new Blob([await fs.readFile(path.join(root, "selected.zip"))]),
    );
    assert.equal(decoded.materials[0].contentHash, material.contentHash);
    const child = spawnSync(
      process.execPath,
      [
        "scripts/import-local-bank.mjs",
        "pack",
        "--from",
        bank,
        "--limit",
        "1",
        "--out",
        path.join(root, "bare-node.zip"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).materials, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pack refuses oversized selected audio before reading it into memory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "band-pack-limit-"));
  try {
    await fs.mkdir(path.join(root, "audio"));
    const file = await fs.open(path.join(root, "audio", "large.wav"), "w");
    await file.truncate(50 * 1024 * 1024 + 1);
    await file.close();
    const m = {
      id: "large-audio-fixture",
      version: "1",
      skill: "listening",
      title: "Original limit fixture",
      source: {
        materialSource: "unofficial",
        sourceRef: "synthetic-limit",
        rights: "Original test fixture",
        answerVerified: false,
      },
      scope: "short",
      deliveryMode: "local-import",
      contentHash: "0".repeat(64),
      transcript: "Original fixture.",
      audio: {
        path: "audio/large.wav",
        durationSeconds: 1,
        sha256: "a".repeat(64),
      },
      questions: [],
    };
    m.contentHash = await hashLocalMaterial(m);
    const bank = path.join(root, "bank.json");
    await fs.writeFile(
      bank,
      JSON.stringify({ importVersion: 1, materials: [m] }),
    );
    await assert.rejects(
      cli.packLocalBank({
        from: bank,
        limit: "1",
        "audio-root": root,
        out: path.join(root, "result.zip"),
      }),
      /50MB/,
    );
    await assert.rejects(fs.stat(path.join(root, "result.zip")), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
