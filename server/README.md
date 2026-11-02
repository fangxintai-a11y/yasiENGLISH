# 学习进度同步 API

Python 3.10+ 标准库服务，SQLite 使用 WAL 和事务。监听本机回环地址，通过同域 Nginx `/api/` 反向代理访问。数据库必须放在发布目录之外，例如 `/var/lib/band-galaxy/progress.sqlite3`，不要放进 `public/`、`dist/` 或 Git。

本地开发：

```bash
BAND_DB_PATH=/tmp/band-galaxy-dev.sqlite3 BAND_PUBLIC_ORIGIN=http://localhost:5188 python3 server/app.py
python3 -m unittest discover -s server -p 'test_*.py' -v
```

前端开发服务器需将 `/api` 代理到 `http://127.0.0.1:5189`。API 不开放 CORS；写请求必须带与配置相同的 `Origin`。

生产环境配置：

```text
BAND_DB_PATH=/var/lib/band-galaxy/progress.sqlite3
BAND_PUBLIC_ORIGIN=https://www.i2023.com
BAND_COOKIE_SECURE=1
BAND_TRUST_PROXY=1
BAND_MAX_ACCOUNTS=1
BAND_SETUP_TOKEN_HASH=<首次注册配对码的 SHA-256，小写十六进制>
```

首次配对码应由安全随机数生成，至少 24 个随机字节，只向所有者交付一次。服务器只需保存其 SHA-256 哈希；也支持通过 `BAND_SETUP_TOKEN` 环境变量直接提供原码，但不得把原码提交到源码或写入日志。HTTPS 环境未配置配对码时拒绝注册，默认只允许创建一个账号。创建后用相同账号在各设备登录；可将 `BAND_ALLOW_REGISTER=0` 完全关闭后续注册。`BAND_TRUST_PROXY=1` 仅适用于本服务监听回环地址、且 Nginx 覆盖 `X-Real-IP` 的部署。

接口：

- `GET /api/health` → `{ok:true}`。
- `GET /api/auth/session` → `{user:{id,username}|null}`。
- `POST /api/auth/register`：`{username,password,setupToken?}`。
- `POST /api/auth/login`：`{username,password}`。
- `POST /api/auth/logout`：撤销当前设备会话。
- `GET /api/account/sessions` → `{sessions:[{id,device,createdAt,expiresAt,lastSeenAt,current}]}`。时间均为 Unix 毫秒；`id` 是独立随机公开标识，不是会话令牌或其哈希；设备名只使用 iPhone/Safari、Mac/Chrome 等简短固定格式。
- `POST /api/account/password`：`{currentPassword,newPassword}`。验证当前密码，事务内修改密码、撤销全部旧会话并为当前设备签发新 Cookie，返回 `{ok:true,user}`。
- `POST /api/account/sessions/revoke`：`{id}`，仅撤销本人其他设备的会话；当前设备请使用退出登录。
- `POST /api/account/sessions/revoke-others`：`{}`，退出本账号其他所有设备，保留当前登录。
- `GET /api/sync/{datasetId}` → `{revision,snapshot}`，空数据为 `{revision:0,snapshot:null}`。
- `GET /api/sync/{datasetId}?commitId={UUID}` → `{revision,snapshot,applied}`，用于确认丢失响应的提交是否已生效。
- `PUT /api/sync/{datasetId}`：`{revision,snapshot:{progress,settings},commitId:UUID}`。版本相符时保存并返回 `{revision,snapshot,applied:true}`；版本冲突返回 HTTP 409 和服务器当前 `{revision,snapshot,applied:false}`。同一提交 ID 重试返回当前快照和 `applied:true`，不会再次写入。

账号名为 3–40 位英文、数字、`.`、`_`、`-`，忽略大小写；密码为 10–256 位。密码采用随机盐和 PBKDF2-HMAC-SHA256（600,000 次），数据库只保存会话令牌的 SHA-256。会话使用 HttpOnly、SameSite=Strict、生产 Secure Cookie，30 天到期。账号和来源 IP 登录限速。快照必须属于当前用户和对应词库，每份请求上限 8 MB。API Key、密码、令牌及进行中的答题轮不会存入学习快照。

数据库保存用户、会话、每词库最新快照、最近 20 份历史快照和提交回执。提交回执用于断网重试去重，独立于历史快照保留。录音和媒体离线包不在此接口范围内。账号管理写接口同样要求同源请求和会话认证，另有限速。会话活跃时间最多每分钟更新一次；已过期会话不再接受请求或出现在设备列表。启动时自动迁移旧版会话表，保留仍有效的登录，并补充稳定公开 ID、创建时间和简短设备信息。

一致性备份（可在服务运行时执行）：

```bash
python3 server/app.py --db /var/lib/band-galaxy/progress.sqlite3 --backup /var/backups/band-galaxy/progress-20261102.sqlite3
```

备份使用 SQLite backup API，包含已提交的 WAL 数据；目标文件必须尚不存在，权限为 `0600`。不要在运行中仅复制主 `.sqlite3` 文件。数据库所在目录也应仅允许运行服务的系统用户访问。恢复时停止服务，将经过 `PRAGMA integrity_check` 检查的备份替换数据库，同时清除对应旧 `-wal`、`-shm` 后再启动。
