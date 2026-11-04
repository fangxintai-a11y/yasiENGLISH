# N1 PWA 优化交付记录

日期：2026年11月4日，Asia/Shanghai。
分支：`codex/native-app-n1`，继承 N0 提交 `381dd5fbc`（基于 `c2cd77c96` / `codex/ielts-365-r1-today`）。
性质：独立项目 N 线（自用手机 / 电脑 App），不修改 R 线任何分支与代码。

---

## 1 交付内容（N1 MUST 工单）

| 改动项 | 涉及文件 | 交付说明 |
|---|---|---|
| **持久化存储检测与申请** | `src/lib/storagePersist.ts`<br>`src/lib/storagePersist.test.ts` | 新增纯函数工具，提供 `checkStoragePersistence`、`requestStoragePersistence`、`getStorageEstimate`；支持无侵入式注入 mock 进行单测，覆盖**申请成功（granted）、被拒绝（denied）、环境不支持（unsupported）、抛出异常（throws）**等分支。 |
| **启动与下载生命周期持久化** | `src/lib/offline.ts`<br>`src/main.tsx` | 1. 应用启动入口 `main.tsx` 调用 `ensureStoragePersistence()`，尽可能早地申请持久化授权；<br>2. `loadManifest` 与 `refreshSpace` 均调用 `checkStoragePersistence()` 动态同步持久化状态；<br>3. `startPack` 下载前确保触发持久化申请。 |
| **“我的”页面真实占用与持久化状态** | `src/ui/OfflinePanel.tsx` | 在存储使用量后增加状态展示：<br>- `persisted === true`：显示 `· 已授予持久存储`（系统不会自动清理）；<br>- `persisted === false`：显示 `· 暂未持久存储（长期不用可能被清理）`，并附带“申请持久化”快捷重试链接。 |
| **iPhone PWA 独立运行元信息** | `index.html` | 补齐苹果 Web App 元标签：<br>- `<meta name="apple-mobile-web-app-capable" content="yes" />`<br>- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`<br>- `<meta name="apple-mobile-web-app-title" content="雅思星图" />`<br>- 视口增加 `interactive-widget=resizes-content`，防止键盘弹出遮挡内容。 |
| **iPhone 安全区与防自动缩放** | `src/styles/app.css`<br>`src/styles/ielts.css` | 1. `--top` 计算改为 `calc(64px + env(safe-area-inset-top))`，`.topbar` 增加 `padding-top: env(safe-area-inset-top)`，解决全屏 PWA 模式下灵动岛/刘海与顶部按钮遮挡冲突；<br>2. 针对移动端（`max-width: 640px`）限制 `input, select, textarea` 的最小字号为 16px，解决 iOS Safari 点击输入框触发整屏自动放大的问题。 |

---

## 2 自动化测试与质量自检结果

| 验证项 | 执行结果 | 说明 |
|---|---|---|
| `npm test` | **592 / 592 passed** | 原 583 项全部通过，新增 9 项 `storagePersist` 单元测试全部通过 |
| `npx tsc -b` | **通过** (Exit 0) | TypeScript 编译无任何类型错误 |
| `npm run test:server` | **61 / 61 passed** | 服务端用例全部通过 |
| `npm run test:sync` | **7 / 7 checks passed** | 双端进度合并、离线导入重载、Service Worker 隔离、密码修改等用例全绿 |
| `npm run test:learning` | **21 / 21 checks passed** | 原 P1 15 项 + R1 生产 UI 与离线 6 项全绿 |
| `node scripts/test-scoring-e2e.mjs` | **12 / 12 passed** | 评分链路端到端全绿 |
| `node scripts/test-learning-storage-e2e.mjs` | **4 / 4 passed** | 存储隔离与录音恢复全绿 |
| `npm run check:curriculum` | **通过** | 课程规则与资源校验通过 |
| `npm run check:vendor-text` | **通过** | 词条与代码敏感词守卫通过 |
| `npm run build` | **通过** (15.04s) | 生产包成功构建生成 `dist` |
| `check:vendor-text -- --dist` | **通过** | 编译产物守卫通过 |
| **受保护文件检查** | **Diff 为空** | `protocol.ts`、`calendar.ts`、`goals.ts`、`server/learning.py`、`plan-rules.json` 零改动 |

---

## 3 三项自检

1. **代码质量**：
   - 存储持久化与配额封装为纯函数工具 `src/lib/storagePersist.ts`，有独立 9 项测试覆盖所有边界分支；
   - 网页版现有 583 项单测与端到端测试 100% 保持不变并通过；
   - 未引入任何第三方外部 npm 依赖；受保护文件一字未改。
2. **是否服务每天使用**：
   - iPhone「添加到主屏幕」可真正全屏运行，顶栏不再与灵动岛/刘海打架；
   - 启动时自动申请持久化，离线包与学习记录不轻易被 iOS 清理；“我的”页面随时可核对存储状态。
3. **是否按任务书**：
   - 严格在 `codex/native-app-n1` 分支操作，未触碰 R 线分支；
   - 未部署到生产 `ibaz.cn:8443`，未合并 `main`；
   - N1 完成后在此停止，等待用户决定是否需要继续做原生壳（N2–N5）。
