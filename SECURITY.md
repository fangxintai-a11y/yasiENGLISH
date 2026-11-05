# 安全与隐私 / Security and privacy

## 数据去哪里

词光没有账号、服务器端存储、统计或追踪。学习进度只保存在当前浏览器的 localStorage，可以在「我的」里导出为 JSON 备份。导入备份时会逐字段校验，畸形数据会被丢弃。

Word Atlas has no accounts, server-side storage, analytics or tracking. Progress lives in the browser's localStorage and can be exported as JSON. Imported backups are validated field by field.

## 凭据 / Credentials

网页运行不需要任何 API key。只有 `scripts/atlas/` 中的内容生成脚本需要调用模型服务，它们从环境变量（`SUB2_BASE_URL`、`SUB2_API_KEY`、`ELEVENLABS_API_KEY`）或仓库外的目录（`ATLAS_SECRETS`）读取凭据，不会写入仓库。

- 不要使用 `VITE_*` 变量存放凭据，它们会被打包进浏览器代码。
- 公开前运行 `npm run pack:public`，它会按白名单导出并扫描凭据和个人路径。扫描是辅助手段，不能替代人工检查。
- 如果凭据意外泄露，请立刻在服务商处吊销或轮换。

## 报告问题 / Reporting

发现安全问题请通过 GitHub 私密漏洞报告（Security → Report a vulnerability）联系维护者，不要公开贴出细节。

## 评分与反馈的隐私边界

默认本地评分计算不发网络请求。选择自动接口后，仅向学习者自己填写的地址发送当前任务；请求不附带本站Cookie，重定向不携带密钥。接口配置和密钥分别保存在本机，密钥仅存于`band-galaxy:llm-secret:<id>`，不进入JSON备份、同步快照或服务端数据库。复制提示词只生成文本，由学习者自行决定粘贴位置。旧版密钥在启动迁移时仅删除，不读取或搬到新配置，原有阅读、记忆钩子及作答记录保留。

为避免本机占位值误拦，已知密钥只有达到16字符才在普通文本中作子串检测；更短值仅完整值匹配，ab/test/ollama等明确占位不参与普通文本匹配。真实密钥前缀格式与明确凭据字段的保护始终保留。
