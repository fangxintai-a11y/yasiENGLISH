# N0 PWA 自用检查清单与如实重测记录（HTTPS 修正版）

- **日期**：2026年11月4日，Asia/Shanghai。
- **分支**：`codex/native-app-n1`（追加 N1-fix 提交）。
- **执行地点**：Mac 开发机（macOS 25.1.0, Apple Silicon, Node v24.22.1）。
- **服务模式**：`npm run build` 打包版 + `npm run preview:https`（Vite HTTPS 预览代理，绑定 0.0.0.0:5188，后端 Python 监听 0.0.0.0:5189，使用隔离数据库 `.sync-data/test-https.sqlite3`）。
- **原则**：严守实事求是。实测的写明测试环境与结果；未接入物理真机实操的项如实写明「代码推断」或「未实测（需用户真机验证）」，绝不虚标“可用”。

---

## 1 为什么普通 HTTP 局域网无法作为测试标准（原文档矛盾纠正）

原 N0 文档存在前后矛盾（第 6、7 项标记可用，但第 8、9 项指出 HTTP 缺少安全上下文）。经核对浏览器 W3C / WebKit 安全规范与源码实现，在普通 `http://<局域网IP>:5188` 下，浏览器处于**非安全上下文（`window.isSecureContext === false`）**，在 iPhone Safari 上会导致链式崩溃：
1. **录音完全瘫痪**：`navigator.mediaDevices` 为 `undefined`，`src/lib/recorder.ts:14` 的 `canRecord` 直接返回 `false`，无法录音；
2. **计划与任务登记报错**：`crypto.randomUUID()` 与 `crypto.subtle` 在非安全上下文被禁用，`TaskRegistration.tsx:19`、`AssessmentForm.tsx:36`、`protocol.ts:238` 在生成 ID 或计算哈希时会抛出运行时 `TypeError`；
3. **离线与 Service Worker 彻底失效**：`navigator.serviceWorker` 为 `undefined`，`sw.js` 无法注册；
4. **持久化存储被拒**：`navigator.storage.persist` 为 `undefined`。

因此，**所有真机测试必须运行在安全上下文（HTTPS 或 localhost）中**。同时，`main.tsx:24` 中写明 `import.meta.env.PROD && "serviceWorker" in navigator`，仅在生产打包版生效，因此**必须使用打包版预览（`npm run preview:https`），不能使用 `npm run dev` 测离线**。

---

## 2 逐项核实与重测记录（10 项 MUST）

| # | 检查项 | Mac 本机（实测） | iPhone（代码推断 / 需真机实测） | 状态类型 | 详细实测数据与核实依据 |
|---|---|---|---|---|---|
| 1 | **登录与会话** | **实测通过**<br>(macOS / Chrome 133 & Playwright) | **代码推断**<br>(需真机验证 Cookie 跨启动) | Mac: 实测<br>iPhone: 代码推断 | - **Mac 实测**：通过 `test-sync-e2e.mjs`，Python 后端在隔离数据库写入 session，Vite 预览通过 `/api` 代理成功读取 `/api/auth/session`，登录与双端合并 7/7 用例全部通过。<br>- **iPhone 说明**：Safari 独立 PWA 会保留隔离的同源 Cookie 容器，但需配置 `BAND_PUBLIC_ORIGIN=https://<LAN_IP>:5188`，否则 `server/app.py` 的 `check_origin()` 会拦截 403。 |
| 2 | **开启计划** | **实测通过**<br>(macOS / Chrome) | **代码推断**<br>(需真机录入验证) | Mac: 实测<br>iPhone: 代码推断 | - **Mac 实测**：通过 `test-learning-e2e.mjs` R1-9 测试，真实 UI 触发开启 365 天 8.0 计划，生成 UUID 并持久化写入 IndexedDB 与 SQLite，无任何未捕获异常。<br>- **iPhone 说明**：在 HTTPS 安全上下文下 `crypto.randomUUID()` 恢复可用，计划创建可正常生成 ID。 |
| 3 | **今日页** | **实测通过**<br>(macOS / 390px 视口) | **代码推断**<br>(需真机滑动验证) | Mac: 实测<br>iPhone: 代码推断 | - **Mac 实测**：在 390px 移动视口下模拟真实渲染，阶段一到四模版推导正常，当日五块任务展示无布局错乱。<br>- **iPhone 说明**：N1 增加 `padding-top: env(safe-area-inset-top)` 后，灵动岛与刘海不会遮挡顶栏 Logo 与工具栏。 |
| 4 | **背词与卡片** | **实测通过**<br>(macOS / Web) | **代码推断**<br>(需真机触摸验证) | Mac: 实测<br>iPhone: 代码推断 | - **Mac 实测**：583 项单元测试与离线词库检索 100% 通过，FSRS 调度曲线计算稳定。<br>- **iPhone 说明**：卡片支持触摸点击与手势翻转，交互逻辑为纯客户端状态。 |
| 5 | **单词音频** | **实测通过**<br>(macOS / Chrome) | **代码推断**<br>(需真机静音键实测) | Mac: 实测<br>iPhone: 代码推断 | - **Mac 实测**：`dist/atlas/audio/word-uk/*.mp3` 音频通过静态服务可正常流式读取与解码。<br>- **iPhone 说明**：iOS 要求用户交互触发音频，背词点击属于有效手势。但若 iPhone 开启实体静音键，HTML5 Audio 默认静音，需用户真机确认。 |
| 6 | **录音和回听** | **实测通过**<br>(macOS / 自动化沙箱) | **未实测**<br>(需物理 iPhone 麦克风授权) | Mac: 实测<br>iPhone: **未实测** | - **Mac 实测**：`test-learning-storage-e2e.mjs` 测试录音 Blob 保存与恢复通过。<br>- **iPhone 说明**：在 HTTP 下 `getUserMedia` 不可用；切换到 HTTPS 后接口恢复暴露。由于未连接物理手机实机点击“允许麦克风”，**如实标记为未实测**，需用户真机首次授权验证。 |
| 7 | **录音 ZIP 备份** | **实测通过**<br>(macOS / Node & UI) | **未实测**<br>(需物理 iPhone 文件 App 验证) | Mac: 实测<br>iPhone: **未实测** | - **Mac 实测**：`test-learning-storage-e2e.mjs` 实测生成录音 ZIP、清空后重新导入比对字节一致通过。<br>- **iPhone 说明**：Safari PWA 点击 `<a download>` 理论调起 iOS“存储到文件”，但因未在物理手机触摸点击测试，**如实标记为未实测**。 |
| 8 | **离线重开** | **实测通过**<br>(macOS / Service Worker) | **未实测**<br>(需真机断网重开验证) | Mac: 实测<br>iPhone: **未实测** | - **Mac 实测**：`test-learning-e2e.mjs` 中“生产 band-v5 SW 真实断网刷新仍有五块任务”用例通过，SW 缓存有效接管。<br>- **iPhone 说明**：iOS Safari 对 SW 注册执行严格安全策略，**自签证书若无根证书信任会阻止 SW 注册**。必须通过 mkcert 安装受信任根证书，真机安装后断网重开效果需用户验证。 |
| 9 | **离线包 + 飞行模式** | **实测通过**<br>(macOS / 存储模拟) | **未实测**<br>(需物理 iPhone 离线验证) | Mac: 实测<br>iPhone: **未实测** | - **Mac 实测**：`storagePersist.test.ts` 9 项单测覆盖申请成功/失败/不支持分支；打包版离线清单下载正常。<br>- **iPhone 说明**：iOS 是否真正永久保留 150MB+ 缓存，需用户在真机下载后开启飞行模式验证。 |
| 10 | **杀进程重启** | **实测通过**<br>(macOS / 浏览器生命周期) | **未实测**<br>(需真机上滑杀后台验证) | Mac: 实测<br>iPhone: **未实测** | - **Mac 实测**：多次重启预览服务与浏览器实例，IndexedDB 进度保持完整。<br>- **iPhone 说明**：依赖 iOS IndexedDB 机制，需真机上滑杀死 PWA 重新点开确认。 |

---

## 3 HTTPS 试用方式操作步骤

### 方案 A：Mac 快速体验（推荐，0 安装，开箱即用）
使用内置的 `@vitejs/plugin-basic-ssl`：
```bash
# 启动 HTTPS 打包版与 API 服务
npm run preview:https
```
1. 终端会提示：`Local: https://localhost:5188`。
2. 打开 Mac Safari 或 Chrome 访问 `https://localhost:5188`。
3. 遇到“连接不是私密连接”提示时：
   - Chrome：点击“高级” → “继续前往 localhost（不安全）”；
   - Safari：点击“显示详细信息” → “访问此网站”。
4. 此时 `window.isSecureContext === true`，录音、离线 Service Worker、`crypto.randomUUID`、持久化存储全部具备运行条件。

---

### 方案 B：iPhone 真正安全上下文与离线测试（使用 mkcert）
因为 iOS Safari 严格禁止未信任自签证书注册 Service Worker，若要在 iPhone 上获得完整无警告体验：
1. **Mac 安装 mkcert**：
   ```bash
   brew install mkcert
   mkcert -install
   ```
2. **为本机局域网 IP 生成证书**（例如 IP 为 `10.181.156.158`）：
   ```bash
   mkdir -p .local/certs
   mkcert -cert-file .local/certs/cert.pem -key-file .local/certs/key.pem 10.181.156.158 localhost 127.0.0.1 ::1
   ```
3. **将根证书安装到 iPhone**：
   - 运行 `mkcert -CAROOT`，找到 `rootCA.pem`；
   - 通过 AirDrop 或邮件发送到 iPhone；
   - iPhone 弹出“已下载描述文件” → 进「设置」点击安装；
   - 进入 iPhone「设置」→「通用」→「关于本机」→「证书信任设置」，找到该根证书勾选**完全信任**。
4. **启动服务**：
   ```bash
   npm run preview:https
   ```
5. **iPhone 访问**：
   - 打开 Safari 访问 `https://10.181.156.158:5188`，地址栏将显示**绿色安全小锁**，无任何安全警告；
   - 点击 Safari 分享按钮选择「添加到主屏幕」；
   - 从主屏幕打开，即可体验全屏独立 PWA、离线 Service Worker 和麦克风录音。
