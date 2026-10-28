# 部署到自己的云服务器：给 AI 助手的提示词

把下面整段（从「你是一名运维工程师」开始）复制给一个能登录你服务器、执行命令的 AI 助手。

---

你是一名运维工程师，帮我把一个纯静态网站部署到我的腾讯云轻量应用服务器（Lighthouse）上，并让它以后可以一键更新。动手前先读完全文。凡是会删除、覆盖已有内容的操作（例如服务器上已有的网站、Nginx 配置），先问我再做。

## 1. 要部署的项目

- 名称：雅思星图 Band Galaxy，一个雅思背单词的 PWA。React + TypeScript + Vite，纯静态，没有后端和数据库。
- 源码：https://github.com/fangxintai-a11y/yasiENGLISH （公开仓库，`main` 分支）。
- 体积：仓库约 750 MB，其中约 730 MB 是 7,298 张插画和 2 万多段 mp3。
- 构建：
  - 需要 Node.js 20 或以上（推荐 22）。
  - 先 `npm ci`，再 `npm run build`，产物在 `dist/`（约 720 MB、约 3.8 万个文件）。
  - 构建内容包括 TypeScript 检查、Vite 打包、生成离线包清单，并把 `public/` 原样复制进 `dist/`。
- 部署路径：
  - 部署在网站根路径 `/` 时，构建前**不要**设置 `ATLAS_BASE`。
  - 如果要放在子路径（例如 `/yasi/`），构建时设 `ATLAS_BASE=/yasi/`，Nginx 用对应的 `location /yasi/` + `alias`。
- 路由是 hash 路由（`#/...`），不需要服务端路由支持。
- 学习进度只存在用户浏览器里，服务器不保存任何用户数据。

## 2. 先检查，再动手（把结果告诉我）

1. 系统和资源：
   - `cat /etc/os-release`、`nproc`、`free -h`、`df -h`。
   - 磁盘至少要留 4 GB 空闲。
   - 内存小于 2 GB 时，先加 2 GB swap，否则构建可能被 OOM 杀掉。
2. 服务器地域：是否在中国大陆？这决定下面两件事：
   - 是否要用国内镜像。
   - 绑定域名时是否必须 ICP 备案。
3. 网络：
   - 测一下访问 `github.com` 和 `registry.npmjs.org` 的速度，例如 `curl -o /dev/null -w '%{time_total}\n'`。
   - 大陆服务器如果很慢，npm 用 `https://registry.npmmirror.com`，Node 安装包也从国内镜像下载。
4. 已有服务：
   - 用 `ss -ltnp` 看 80/443 是否已被占用。
   - 查看 `/etc/nginx/conf.d`、`/etc/nginx/sites-enabled` 里是否已有别的网站。
   - 已有网站不要动它，新增一个独立的 server 配置即可。
5. 问我：
   - 有没有域名？
   - 如果服务器在大陆，这个域名是否已经 ICP 备案？
   - 没有域名，就先用「公网 IP + HTTP」。

## 3. 部署步骤

1. **安装依赖**：`git`、`nginx`、Node.js 22（`npm` 随附）。
   - 优先用系统包管理器装 git 和 nginx。
   - Node 用官方二进制包或国内镜像里的同版本二进制包。
   - 装完确认 `node -v` ≥ 20。
2. **拉取代码**：`git clone --depth 1 https://github.com/fangxintai-a11y/yasiENGLISH.git /opt/yasi/src`
   - 大陆服务器克隆 750 MB 可能很慢或中断：
     - 先重试几次。
     - 不行就下载源码包 `https://codeload.github.com/fangxintai-a11y/yasiENGLISH/tar.gz/refs/heads/main` 后解压。
     - 也可以用你确认可靠的 GitHub 加速方式。
   - 都不行就告诉我，我把压缩包上传到服务器。
   - 不要使用来路不明的脚本。
3. **构建**：
   ```bash
   cd /opt/yasi/src
   export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1   # 只是开发依赖，构建用不到浏览器
   npm ci            # 大陆可加 --registry=https://registry.npmmirror.com
   npm run build
   ```
   构建失败时把完整报错贴给我，不要改源码。
4. **按版本目录发布**（便于回滚）：
   - 把 `dist/` 移到 `/opt/yasi/releases/<时间戳>/`。
   - 让软链接 `/var/www/yasi/current` 指向它。
   - 只保留最近 2 个版本。
   - 确保 Nginx 运行用户（`www-data` 或 `nginx`）对目录有读权限。
5. **配置 Nginx**：新建一个独立配置文件，例如 `/etc/nginx/conf.d/yasi.conf`。参考配置如下，按实际情况调整：

   ```nginx
   server {
       listen 80;
       server_name _;                      # 有域名就写域名；已有默认站点时不要抢 default_server
       root /var/www/yasi/current;
       index index.html;

       gzip on;
       gzip_min_length 1024;
       gzip_types text/css application/javascript application/json image/svg+xml application/manifest+json;
       # mp3/webp 已经是压缩格式，不要 gzip，以免破坏音频的 Range 请求

       # 带哈希的 JS/CSS/字体：长期缓存
       location /assets/ {
           add_header Cache-Control "public, max-age=31536000, immutable";
           try_files $uri =404;
       }
       # 插画、发音、品牌图、音效：缓存 30 天
       location ~ ^/(atlas/(img|thumb|audio)|brand|sfx)/ {
           add_header Cache-Control "public, max-age=2592000";
           try_files $uri =404;
       }
       # 词条和助记数据：缓存 1 天
       location ~ ^/(atlas/entries|ielts/mnemo)/ {
           add_header Cache-Control "public, max-age=86400";
           try_files $uri =404;
       }
       # 必须每次校验的入口文件：Service Worker、索引、离线包清单
       location ~ ^/(sw\.js|atlas/index\.json|ielts/tags\.json|offline/pack\.json)$ {
           add_header Cache-Control "no-cache";
           try_files $uri =404;
       }
       location = /manifest.webmanifest {
           types { } default_type application/manifest+json;
           add_header Cache-Control "no-cache";
       }
       location / {
           add_header Cache-Control "no-cache";
           try_files $uri $uri/ /index.html;
       }
   }
   ```

   然后 `nginx -t`，通过后 `systemctl reload nginx`，并设置开机自启。
   注意：不要在 server 级别写 `types { ... }`，那会覆盖全部 MIME 类型。
6. **防火墙**：
   - 系统防火墙（ufw / firewalld）放行 80 和 443。
   - 腾讯云控制台的「防火墙」规则你可能改不了，需要提醒我自己去控制台放行 TCP 80 和 443。
7. **HTTPS**（重要）：
   - PWA 的离线功能（Service Worker、「离线包」、添加到主屏幕后离线使用）**只在 HTTPS 下有效**。
   - 用 `http://IP` 访问能正常在线学习，但不能离线。
   - 有域名的情况：
     - 服务器在大陆时，域名必须已经 ICP 备案，否则会被拦截。
     - 证书用腾讯云免费 SSL 证书（下载 Nginx 格式），或用 acme.sh / certbot 申请 Let's Encrypt。
     - 配好 443，并把 80 跳转到 443。
   - 没有域名：只配 HTTP，并在总结里写明「离线功能需要域名 + HTTPS 才能用」。
8. **一键更新脚本**：写一个 `/usr/local/bin/yasi-update`，依次执行：
   - 拉取最新 `main`（`git fetch --depth 1 origin main && git reset --hard origin/main`）；
   - `npm ci`；
   - `npm run build`；
   - 发布为新的版本目录，原子切换软链接；
   - 删除旧版本，只保留 2 个；
   - `systemctl reload nginx`。

   任何一步失败都要停止，并保留当前线上版本不变。
   先不要加定时任务，问我要不要每天自动更新。

## 4. 验收（逐条执行，把输出贴给我）

把 `HOST` 换成 IP 或域名：

```bash
curl -sI http://HOST/ | head -5                                   # 200，Cache-Control: no-cache
curl -s  http://HOST/atlas/index.json | head -c 120               # JSON 开头
curl -sI http://HOST/atlas/img/abandon.webp | grep -i -E 'HTTP|content-type|cache-control'   # 200 image/webp, max-age=2592000
curl -sI http://HOST/atlas/audio/uk/abandon.mp3 | grep -i -E 'HTTP|content-type|accept-ranges'  # 200 audio/mpeg, Accept-Ranges: bytes
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' http://HOST/atlas/audio/uk/abandon.mp3   # 206
curl -sI http://HOST/sw.js | grep -i cache-control                # no-cache
curl -sI http://HOST/manifest.webmanifest | grep -i content-type  # application/manifest+json
ls /var/www/yasi/current/assets | head                            # 带哈希的 js/css
```

最后在我手机浏览器打开网址，确认首页、开始学习、点开单词能看到插画并听到发音。

## 5. 最后给我的总结

- 访问地址；是 HTTP 还是 HTTPS。
- 构建用的 Node 版本，以及 `dist` 的实际大小。
- 更新命令怎么用，回滚怎么做（把软链接指回上一个版本，再 reload nginx）。
- 需要我自己完成的事项（例如控制台防火墙、域名备案、DNS 解析），以及还没完成的事项。
- 不要在总结或日志里输出任何密码、私钥或证书私钥内容。
