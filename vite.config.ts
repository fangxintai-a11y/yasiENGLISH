import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
// Local-only content is never copied into dist or the public archive.
function localMedia(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) {
  const route = (req.url || "").split("?")[0];
  const root = path.resolve(".local");
  if (route === "/local/catalog.json") {
    const file = path.join(root, "catalog.json");
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(file).pipe(res);
    return;
  }
  const match = route.match(
    /^\/local\/media\/(image|uk|us|sentence)\/(\d{1,5})$/,
  );
  if (!match) {
    next();
    return;
  }
  try {
    const map = JSON.parse(
      fs.readFileSync(path.join(root, "media-map.json"), "utf8"),
    );
    const stored = map[match[2]]?.[match[1]];
    const file =
      typeof stored === "string"
        ? path.isAbsolute(stored)
          ? stored
          : path.resolve(root, stored)
        : undefined;
    if (!file || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const types: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
    };
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const r = range.match(/^bytes=(\d+)-(\d*)$/);
      const start = r ? Number(r[1]) : -1;
      const end = r && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start < 0 || start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", end - start + 1);
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", size);
      fs.createReadStream(file).pipe(res);
    }
  } catch {
    res.statusCode = 404;
    res.end();
  }
}
const packageInfo = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const buildCommit = process.env.BAND_BUILD_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(buildCommit)) throw new Error("BAND_BUILD_COMMIT must identify the full Git commit.");
export default defineConfig({
  define: { __BAND_BUILD__: JSON.stringify({ version: packageInfo.version, commit: buildCommit.slice(0, 9), fullCommit: buildCommit }) },
  // Deploy under a sub-path with ATLAS_BASE=/words/ npm run build
  base: process.env.ATLAS_BASE || "/",
  plugins: [
    react(),
    {
      name: "release-public-files",
      apply: "build",
      generateBundle() {
        const runtimeFiles = JSON.parse(fs.readFileSync("server/runtime-files.json", "utf8")) as string[];
        const apiFiles = Object.fromEntries(runtimeFiles.map(name => [name, createHash("sha256").update(fs.readFileSync(path.join("server", name))).digest("hex")]));
        const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal", "--", "src", "server", "vite.config.ts", "package.json", "public/sw.js"], { encoding: "utf8" }).trim();
        this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify({ version: packageInfo.version, fullCommit: buildCommit, sourceDirty: !!dirty, apiFiles }) });
      },
      closeBundle() {
        const publicRoot = path.resolve("public");
        fs.cpSync(publicRoot, path.resolve("dist"), { recursive: true, filter(source) {
          const rel = path.relative(publicRoot, source);
          return rel !== "local-bank" && !rel.startsWith(`local-bank${path.sep}`);
        } });
      },
    },
    {
      name: "private-local-library",
      configureServer(server) {
        server.middlewares.use(localMedia);
      },
      configurePreviewServer(server) {
        server.middlewares.use(localMedia);
      },
    },
  ],
  server: { port: 5188, strictPort: true, proxy: { "/api": process.env.BAND_API_TARGET || "http://127.0.0.1:5189" } },
  preview: { port: 5188, strictPort: true },
  build: { chunkSizeWarningLimit: 600, copyPublicDir: false },
});
