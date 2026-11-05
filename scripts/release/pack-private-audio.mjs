#!/usr/bin/env node
/** Prepare private content on the Mac. Never downloads, uploads or rewrites originals. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
const { parseLocalBank, hashLocalMaterial } = await tsImport(
  "../../src/study365/localBankSchema.ts",
  import.meta.url,
);
const { deriveListeningSequences } = await tsImport(
  "../../src/study365/listeningSequence.ts",
  import.meta.url,
);
const { parsePrivateBankManifest } = await tsImport(
  "../../src/study365/privateBankManifest.ts",
  import.meta.url,
);
const { parsePromptBank } = await tsImport(
  "../../src/study365/promptBankSchema.ts",
  import.meta.url,
);
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "",
      error = "";
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      error = (error + bytes).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(`${path.basename(binary)} exited ${code}: ${error}`),
          ),
    );
  });
}
export async function probeAudio(file, ffprobe = "ffprobe") {
  const raw = JSON.parse(
    await command(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,profile,channels,bit_rate,duration:format=duration,bit_rate",
      "-of",
      "json",
      file,
    ]),
  );
  const stream = raw.streams?.[0],
    durationSeconds = Number(raw.format?.duration ?? stream?.duration),
    bitRate = Number(stream?.bit_rate ?? raw.format?.bit_rate);
  if (
    !stream ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(bitRate) ||
    bitRate <= 0
  )
    throw new Error(`Audio metadata invalid: ${path.basename(file)}`);
  return {
    durationSeconds,
    bitRate: Math.round(bitRate),
    codec: stream.codec_name,
    profile: stream.profile,
    channels: stream.channels,
  };
}
async function sourceFile(originalPath, root) {
  const relative = originalPath.replace(/^\/local-bank\//, "");
  if (
    !/^audio\/[a-zA-Z0-9/_-]+\.(mp3|m4a|ogg|wav|webm)$/.test(relative) ||
    relative.split("/").some((part) => [".", ".."].includes(part))
  )
    throw new Error("Source audio path is not a safe local-bank path");
  const base = await fs.realpath(root),
    resolved = await fs.realpath(path.resolve(base, relative));
  if (!resolved.startsWith(base + path.sep))
    throw new Error("Source audio escapes the selected audio root");
  return resolved;
}
async function atomicJSON(file, value) {
  const tmp = `${file}.part`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fs.rename(tmp, file);
}
export async function packPrivateAudio({
  bank,
  audioRoot,
  out,
  prompts,
  ffmpeg = "ffmpeg",
  ffprobe = "ffprobe",
}) {
  const destination = path.resolve(out);
  if (
    destination === project ||
    (destination.startsWith(project + path.sep) &&
      !destination.startsWith(path.join(project, "local-content") + path.sep))
  )
    throw new Error(
      "Private output inside this repository must be under ignored local-content/.",
    );
  const parsed = await parseLocalBank(
    JSON.parse(await fs.readFile(bank, "utf8")),
  );
  if (parsed.issues.length || parsed.duplicate)
    throw new Error(
      `Input bank must pass strict validation: ${parsed.issues.join("; ")}`,
    );
  const sequences = await deriveListeningSequences(
    parsed.materials.filter(
      (material) => material.source.materialSource === "cambridge",
    ),
  );
  const selected = new Set(
    sequences.flatMap((sequence) =>
      sequence.parts.map((part) =>
        JSON.stringify([part.id, part.version, part.contentHash]),
      ),
    ),
  );
  const materials = parsed.materials.filter(
    (material) =>
      material.skill === "reading" ||
      selected.has(
        JSON.stringify([material.id, material.version, material.contentHash]),
      ),
  );
  await fs.mkdir(path.join(destination, "audio"), { recursive: true });
  let previous = null;
  try {
    previous = await parsePrivateBankManifest(
      JSON.parse(
        await fs.readFile(path.join(destination, "manifest.json"), "utf8"),
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const transports = [],
    processed = new Set();
  let encoded = 0,
    reused = 0;
  for (const material of materials) {
    if (material.skill !== "listening" || !material.audio) continue;
    const originalPath = material.audio.path,
      source = await sourceFile(originalPath, audioRoot),
      original = await fs.readFile(source),
      sourceSha256 = hash(original);
    if (!material.audio.sha256 || sourceSha256 !== material.audio.sha256)
      throw new Error(
        `Original audio SHA does not match ${material.id}; original files were not changed.`,
      );
    const key = JSON.stringify([originalPath, sourceSha256]);
    if (processed.has(key)) continue;
    processed.add(key);
    const sourceMeta = await probeAudio(source, ffprobe);
    if (
      Math.abs(sourceMeta.durationSeconds - material.audio.durationSeconds) >
      0.100001
    )
      throw new Error(`Original duration does not match ${material.id}`);
    let transport = previous?.audioTransports.find(
      (item) =>
        item.originalPath === originalPath &&
        item.sourceSha256 === sourceSha256,
    );
    if (transport) {
      const existing = path.join(
        destination,
        transport.path.slice("/private/".length),
      );
      const bytes = await fs.readFile(existing),
        metadata = await probeAudio(existing, ffprobe);
      if (
        hash(bytes) !== transport.sha256 ||
        bytes.length !== transport.bytes ||
        metadata.codec !== "aac" ||
        metadata.profile !== "LC" ||
        metadata.channels !== 1 ||
        Math.abs(metadata.durationSeconds - sourceMeta.durationSeconds) >
          0.100001
      )
        throw new Error(
          `Existing encoded audio failed validation: ${material.id}`,
        );
      reused++;
    } else {
      const temporary = path.join(
        destination,
        "audio",
        `${sourceSha256}.part.m4a`,
      );
      await command(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-c:a",
        "aac",
        "-profile:a",
        "aac_low",
        "-ac",
        "1",
        "-b:a",
        "48k",
        "-movflags",
        "+faststart",
        temporary,
      ]);
      const bytes = await fs.readFile(temporary),
        metadata = await probeAudio(temporary, ffprobe),
        sha256 = hash(bytes);
      if (
        metadata.codec !== "aac" ||
        metadata.profile !== "LC" ||
        metadata.channels !== 1 ||
        Math.abs(metadata.durationSeconds - sourceMeta.durationSeconds) >
          0.100001
      )
        throw new Error(
          `Encoded audio failed codec/duration validation: ${material.id}`,
        );
      const target = path.join(destination, "audio", `${sha256}.m4a`);
      await fs.rename(temporary, target);
      transport = {
        originalPath,
        path: `/private/audio/${sha256}.m4a`,
        sha256,
        sourceSha256,
        durationSeconds: metadata.durationSeconds,
        sourceDurationSeconds: sourceMeta.durationSeconds,
        bitRate: metadata.bitRate,
        targetBitRate: 48000,
        codec: "aac",
        profile: "LC",
        channels: 1,
        bytes: bytes.length,
        sourceBytes: original.length,
      };
      encoded++;
    }
    transports.push(transport);
  }
  const body = {
      privateBankVersion: 1,
      materials,
      audioTransports: transports,
    },
    manifest = { ...body, contentHash: await hashLocalMaterial(body) };
  await parsePrivateBankManifest(manifest);
  let promptCount = 0;
  if (prompts) {
    const input = JSON.parse(await fs.readFile(prompts, "utf8")),
      parsedPrompts = await parsePromptBank(input);
    if (parsedPrompts.issues.length || parsedPrompts.duplicate)
      throw new Error(
        `Prompt bank must pass strict validation: ${parsedPrompts.issues.join("; ")}`,
      );
    await atomicJSON(path.join(destination, "prompts.json"), {
      importVersion: 1,
      prompts: parsedPrompts.prompts,
    });
    promptCount = parsedPrompts.prompts.length;
  }
  await atomicJSON(path.join(destination, "manifest.json"), manifest);
  const files = [
    "manifest.json",
    ...transports.map((item) => item.path.slice("/private/".length)),
    ...(prompts ? ["prompts.json"] : []),
  ].sort();
  const contentBytes = (
    await Promise.all(
      files.map(
        async (file) => (await fs.stat(path.join(destination, file))).size,
      ),
    )
  ).reduce((sum, size) => sum + size, 0);
  const result = {
    completeCambridgeExams: sequences.length,
    listeningSections: materials.filter(
      (material) => material.skill === "listening",
    ).length,
    readingMaterials: materials.filter(
      (material) => material.skill === "reading",
    ).length,
    prompts: promptCount,
    audioFiles: transports.length,
    encoded,
    reused,
    audioBytes: transports.reduce((sum, item) => sum + item.bytes, 0),
    originalAudioBytes: transports.reduce(
      (sum, item) => sum + item.sourceBytes,
      0,
    ),
    manifestHash: manifest.contentHash,
    output: destination,
    files,
    contentBytes,
  };
  await atomicJSON(path.join(destination, "pack-report.json"), result);
  await fs.writeFile(
    path.join(destination, "private-files.txt"),
    [...files, "pack-report.json"].join("\n") + "\n",
  );
  return result;
}
async function main(args) {
  if (args.includes("--help")) {
    console.log(
      "node scripts/release/pack-private-audio.mjs --bank local-content/r5-ready-bank-20261105.json --audio-root public/local-bank --out local-content/release-private [--prompts local-content/r5-prompt-bank.json]\nNo network, upload or source rewrite. Only complete Cambridge S1-S4 and all reading are selected.",
    );
    return;
  }
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      ![
        "--bank",
        "--audio-root",
        "--out",
        "--prompts",
        "--ffmpeg",
        "--ffprobe",
      ].includes(args[i]) ||
      !args[i + 1]
    )
      throw new Error("Unknown or incomplete argument; use --help");
    flags[args[i].slice(2)] = args[i + 1];
  }
  const result = await packPrivateAudio({
    bank:
      flags.bank ??
      path.join(project, "local-content/r5-ready-bank-20261105.json"),
    audioRoot: flags["audio-root"] ?? path.join(project, "public/local-bank"),
    out: flags.out ?? path.join(project, "local-content/release-private"),
    prompts: flags.prompts,
    ffmpeg: flags.ffmpeg,
    ffprobe: flags.ffprobe,
  });
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
