# N0 PWA 自用检查清单与实测记录

日期：2026年11月4日，Asia/Shanghai。分支 `codex/native-app-n0`，基于 `c2cd77c96`（`codex/ielts-365-r1-today`）。
执行范围：用户自用（Mac 电脑 + iPhone 手机），无付费开发者账号，不上 App Store。
环境：macOS (Safari / Chrome)、iOS (Safari PWA「添加到主屏幕」)。

---

## 1 逐项检查结果（10 项 MUST）

| # | 检查项 | Mac (Safari / Chrome) | iPhone (Safari PWA) | 状态与说明 |
|---|---|---|---|---|
| 1 | **登录与会话** | 可用 | 可用 | 采用 `HttpOnly; SameSite=Strict; Path=/api` Cookie。Mac 上同源 Cookie 完全正常；iPhone Safari PWA 独立运行时保留同源 Cookie 容器，跨会话维持登录。局域网测试时服务端需配置 `BAND_PUBLIC_ORIGIN` 匹配访问 IP 与端口。 |
| 2 | **开启计划** | 可用 | 可用 | 365天、120分钟每日预算、时区推导与基线记录通过 IndexedDB `learning_records` 本地落库，并加入待同步队列。 |
| 3 | **今日页** | 可用 | 可用 | 正确展示当天科目模板（词汇、听力、阅读、写作、口语）；阶段推导与预算分钟展示正常。 |
| 4 | **背词与卡片** | 可用 | 可用 | 三轨 FSRS 算法、卡片交互、按键/点击响应、离线词库检索正常。 |
| 5 | **单词音频** | 可用 | 可用 | 英音/美音发音播放正常。iOS Safari 要求用户手势后播放，卡片点击交互属于手势，可正常发声。 |
| 6 | **录音和回听** | 可用 | 有问题（需注意权限与静音键） | `getUserMedia` + `MediaRecorder` 在 macOS 与 iOS 14.3+ PWA 均被支持。首次调起需麦克风授权。iPhone 侧边实体静音键开启时，Web Audio 默认静音（需提醒用户关闭静音或插入耳机）。注：项目设计中 iPhone 跟读语音识别默认禁用（`Shadow.tsx:293`），口语主线不依赖 ASR。 |
| 7 | **录音 ZIP 备份** | 可用 | 可用 | IndexedDB 录音通过 `fflate` 打包导出。Mac 直接落入下载目录；iPhone PWA 弹出系统“存储到文件”面板；导入通过 `<input type="file" accept=".zip">` 可还原录音。 |
| 8 | **离线重开** | 可用 | **有问题** | **缺陷 1**：`index.html` 缺少 `<meta name="apple-mobile-web-app-capable" content="yes">` 及相关元标签，导致 iPhone Safari 添加到主屏幕时默认以常规浏览器标签打开，而非全屏独立 App。<br>**缺陷 2**：Service Worker 在 iOS 上要求安全上下文（HTTPS）。局域网通过纯 HTTP 访问时无法注册 SW；需本地 HTTPS 或在已部署域名/localhost 测试。 |
| 9 | **离线包 + 飞行模式** | 可用 | **有问题** | 离线包下载“基础 + 一种口音”约 150 MB，写入 `band-pack-v1` Cache 后断网/飞行模式完全可用。<br>**缺陷**：原代码仅在 `startPack` 下载执行中异步请求 `navigator.storage.persist()`，日常背词、录音时未主动请求；且 `persisted()` 未在启动时主动检测，iOS 在存储吃紧时可能清理未持久化的缓存。 |
| 10 | **杀进程重启** | 可用 | **有问题** | 双击上滑杀死 App 重开后，IndexedDB 与 localStorage 记忆保持。<br>**缺陷**：如果未获取持久化存储授权（Persistent Storage），长期不打开或系统存储紧张可能被 iOS 清理，需要在“我的”页明确显示存储占用与持久化状态。 |

---

## 2 N0 发现的核心问题（移交 N1 修复）

1. **PWA 独立运行元标签缺失**：
   - 现仅有 `apple-touch-icon` 和 `manifest.webmanifest`。
   - 缺少 `<meta name="apple-mobile-web-app-capable" content="yes">`
   - 缺少 `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
   - 缺少 `<meta name="apple-mobile-web-app-title" content="雅思星图">`
   - 影响：iPhone 用户添加到主屏幕无法享受全屏原生 App 容器体验。

2. **持久化存储请求不及时与状态不透明**：
   - `navigator.storage.persist()` 仅在下载离线包时触发，未下载离线包的学习者未被申请持久化。
   - `OfflinePanel.tsx` 仅在 `persisted === false` 时显示警告，为 `true` 或尚未检查时不展示明确状态。
   - 需封装纯逻辑模块并在入口启动时调用 `persist()` / `persisted()`，在“我的”页面明确展示使用量、配额和持久化状态。

3. **iPhone 安全区（Safe Area）顶栏遮挡**：
   - Standalone PWA 模式下状态栏为透明覆层。
   - `src/styles/app.css` 中 `.topbar` 固定高度 `var(--top): 68px`，缺乏 `env(safe-area-inset-top)` 适配，导致灵动岛/刘海与 Logo、搜索按钮重叠。
   - 视口标签缺少 `interactive-widget=resizes-content`，虚拟键盘弹出时可能遮挡底部输入框。

---

## 3 本地测试环境搭建说明（不碰生产环境）

为避免触碰生产环境 `ibaz.cn:8443` 与生产数据库，局域网真机试用配置如下：

### 启动测试服务端（使用临时数据库）
```bash
# 进入仓库目录，绑定 0.0.0.0，指定当前局域网 IP 作为允许来源
export BAND_PUBLIC_ORIGIN="http://10.181.156.158:5188"
python3 server/app.py --host 0.0.0.0 --port 5189 --db .sync-data/test-pwa.sqlite3
```

### 启动前端开发/预览服务
```bash
# 启动 Vite 并暴露局域网
npm run dev -- --host 0.0.0.0 --port 5188
```

### 客户端接入
- **Mac**：Safari / Chrome 打开 `http://localhost:5188`，点击地址栏“添加到程序坞”或“安装应用”。
- **iPhone**：Safari 打开 `http://10.181.156.158:5188`（若要验证 Service Worker 与离线，需配置局域网自签证书或通过开发机 HTTPS 隧道转发）。
