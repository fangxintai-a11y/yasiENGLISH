#!/usr/bin/env node
/**
 * One-command script to launch Python API server and HTTPS Vite preview server.
 * Uses an isolated database (.sync-data/test-https.sqlite3) and never touches production.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === "IPv4" && !net.internal && net.address.startsWith("10.") || net.address.startsWith("192.168.") || net.address.startsWith("172.")) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

const host = process.env.HOST || getLanIp();
const webPort = Number(process.env.PORT || "5188");
const apiPort = Number(process.env.API_PORT || "5189");
const dbPath = path.resolve(root, ".sync-data/test-https.sqlite3");
const certPath = path.resolve(root, ".local/certs/cert.pem");
const keyPath = path.resolve(root, ".local/certs/key.pem");
const hasCustomCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

// Ensure .sync-data directory exists
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Check dist build
if (!fs.existsSync(path.resolve(root, "dist/index.html"))) {
  console.log("dist/index.html 未找到，正在自动构建打包版...");
  const build = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  await new Promise((resolve, reject) => {
    build.on("exit", (code) => (code === 0 ? resolve(null) : reject(new Error(`构建失败 (exit code: ${code})`))));
  });
}

console.log("\n============================================================");
console.log("雅思星图 HTTPS PWA 本地试用环境");
console.log("------------------------------------------------------------");
console.log(`局域网地址:   https://${host}:${webPort}`);
console.log(`本地环回:     https://localhost:${webPort}`);
console.log(`API 后端:     http://127.0.0.1:${apiPort} (通过 /api 代理)`);
console.log(`测试数据库:   ${dbPath}`);
console.log(`证书模式:     ${hasCustomCerts ? "自定义根证书 (.local/certs)" : "@vitejs/plugin-basic-ssl (自签名)"}`);
if (!hasCustomCerts) {
  console.log("提示: 若在 iPhone 上进行无警告的 Service Worker 离线测试，建议使用 mkcert 颁发信任证书：");
  console.log(`  1. brew install mkcert && mkcert -install`);
  console.log(`  2. mkdir -p .local/certs && mkcert -cert-file .local/certs/cert.pem -key-file .local/certs/key.pem ${host} localhost 127.0.0.1`);
  console.log(`  3. 将 $(mkcert -CAROOT)/rootCA.pem 发送至 iPhone 并信任描述文件`);
}
console.log("------------------------------------------------------------");
console.log("按 Ctrl+C 退出并停止全部后台服务");
console.log("============================================================\n");

// 1. Start Python API server
const publicOrigin = `https://${host}:${webPort}`;
const apiProcess = spawn(
  "python3",
  ["server/app.py", "--host", "0.0.0.0", "--port", String(apiPort), "--db", dbPath],
  {
    cwd: root,
    env: {
      ...process.env,
      BAND_PUBLIC_ORIGIN: publicOrigin,
      BAND_COOKIE_SECURE: "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

// 2. Start Vite Preview server with HTTPS
const previewProcess = spawn(
  process.execPath,
  [
    path.resolve(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "0.0.0.0",
    "--port",
    String(webPort),
    "--strictPort",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      BAND_HTTPS: "1",
      BAND_API_TARGET: `http://127.0.0.1:${apiPort}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

function cleanup() {
  console.log("\n正在关闭试用服务...");
  try {
    apiProcess.kill("SIGTERM");
  } catch {}
  try {
    previewProcess.kill("SIGTERM");
  } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
apiProcess.on("exit", (code) => {
  if (code !== null && code !== 0) console.error(`API 服务意外退出: ${code}`);
});
previewProcess.on("exit", (code) => {
  if (code !== null && code !== 0) console.error(`Preview 服务意外退出: ${code}`);
});
