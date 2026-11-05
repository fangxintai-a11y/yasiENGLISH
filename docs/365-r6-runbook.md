# R6 候选发布、正式部署与回滚 runbook

候选为分支`codex/ielts-365-r6-release`，版本`365.0.0-rc1`，标签`v365-rc1`。**用户尚未单独说“上线”时，只执行A节的本机检查/打包；B至F节全部停止。** 不合并main，不在候选阶段安装或修改生产机。服务器只解包，不运行npm构建。443及Xray保持原样；不创建swap。

本runbook复用`ops/deploy/yasi-deploy`、`yasi-rollback`和`backup-sync.py`，没有另一套发布系统。主机事实及来源见[365-r6-server-facts.md](./365-r6-server-facts.md)。本地候选记录见[365-r6-delivery.md](./365-r6-delivery.md)。

## A. 现在可执行：本机与隔离演练

在仓库根目录执行，任何服务/数据库只在测试自己的临时目录。端口和浏览器测试需要本机权限，不能把沙箱EPERM称为产品失败。

```bash
npm test
npx tsc -b
npm run test:server
npm run test:r6-release
npm run test:r6-private
python3 ops/deploy/test_receiver.py
```

预期：所有命令退出0；单测不少于R5的1290、server不少于374；打包测试拒绝不完整共享媒体、脏构建、SHA漂移、数据库/密钥；receiver输出包括空机首次发布、第二次发布、代码回滚、DB不倒回、混合daily/predeploy最近14份、失败恢复等场景成功。receiver把工具放临时目录、替换系统管理及公网检查命令，仅启动loopback临时API，**不执行真实SSH、systemctl安装或生产发布**。未参与开发的复核AI须只照本节执行并报告真实退出码，不能只读源码就声称演练通过。

以下准备只生成Mac文件。Git当前树不再包含MP3/M4A/PDF；完整本机媒体必须预先从此用户Mac的已有文件恢复，不能从新clone假定音频已在。`public/atlas/`还需现有图片与JSON；额外媒体目录是`public/ielts/phrase/`、`public/sfx/`、`public/curriculum365/v1/audio/`。共享资源不与每次应用包重复上传。

```bash
# 固定到交付记录给出的“应用构建提交”，它可早于后续仅增加runbook的标签提交。
R6_SOURCE_COMMIT='<交付记录中的完整40位应用构建提交>'
test -z "$(git status --porcelain)"
git switch --detach "$R6_SOURCE_COMMIT"
test "$(git rev-parse HEAD)" = "$R6_SOURCE_COMMIT"
npm ci
BAND_BUILD_COMMIT="$R6_SOURCE_COMMIT" npm run build
node -e 'const b=JSON.parse(require("fs").readFileSync("dist/build-info.json")); if(b.sourceDirty) process.exit(1); console.log(b)'
R6_RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${R6_SOURCE_COMMIT:0:8}"
python3 scripts/release/pack-app.py --source-root "$PWD" --dist dist \
  --commit "$R6_SOURCE_COMMIT" --out "local-content/releases/$R6_RELEASE_ID.tar.gz" \
  --atlas-out local-content/releases/shared-atlas
shasum -a 256 "local-content/releases/$R6_RELEASE_ID.tar.gz"
```

预期：`sourceDirty=false`；包小于50MiB；旁边`.tar.gz.json`给出固定commit、SHA256、字节数与全部文件清单；包只有`dist/`、清单指定的`server/`运行模块及`release-manifest.json`，没有atlas、MP3/M4A/PDF、local-content、local-bank、数据库或密钥。共享目录含图集及`_public/`下额外媒体。工具拒绝覆盖已有候选包；重新打包需换发布号，不改变已交付制品。

构建完成后执行浏览器验收。与仓库CI一致，使用当前Playwright包配套浏览器，避免本机Chrome自动升级改变运行环境；`executablePath()`的含义见[Playwright版本文档](https://github.com/microsoft/playwright/blob/v1.64.1/docs/src/api/class-browsertype.md)。本次为156.0.8078.4，测试脚本既有`CHROME_PATH`入口，不改断言。若尚未安装配套浏览器，先执行`npx playwright install chromium`。

```bash
export CHROME_PATH="$(node --input-type=module -e 'import {chromium} from "playwright"; console.log(chromium.executablePath())')"
test -x "$CHROME_PATH"
node scripts/test-r3-e2e.mjs
node scripts/test-r4-e2e.mjs
node scripts/test-r5-e2e.mjs
(
  for R6_RUN in 1 2 3; do
    node scripts/test-r6-e2e.mjs || exit "$?"
  done
)
```

预期：原R3/R4/R5退出0；R6三次都退出0、pageErrors为空，1.5万条后首屏仍严格小于2000ms。保留每次日志和实际退出码，有失败则停止，不能用后续单次成功补称“三次全过”。三个R6脚本顺序运行，期间不重建或更改源码；浏览器播放测试也不与其他套件并行。真实Safari/用户安装PWA另按F节执行，不由自动化浏览器结果代替。

### 私有材料交给资料AI准备

```bash
node scripts/release/pack-private-audio.mjs \
  --bank local-content/r5-ready-bank-20261105.json \
  --audio-root public/local-bank \
  --prompts local-content/r5-prompt-bank.json \
  --out local-content/release-private
```

预期：只转码已导入且严格完整的Cambridge四节听力，带全部阅读JSON与写说题目；其他听力保留本机。每段AAC-LC/单声道/目标48kbps、时长误差≤0.1秒，生成`audio/<压缩SHA>.m4a`、`manifest.json`、`prompts.json`、`pack-report.json`和`private-files.txt`。独立transport manifest的`sha256`是压缩字节SHA，`sourceSha256`是原始音频SHA；原材料id/version/contentHash保留，避免旧作答和审校失效。再次执行复用已验证输出；原件或产物校验失败则停止。完整32套转码及容量由资料AI实测，不把短自写音频测试当成真题转码完成。

## B. 仅用户说“上线”后：目标机与网络准备

目标固定`fangxintai@35.213.5.225`。不要连接已弃用旧机。首先从Mac只读执行：

```bash
dig @8.8.8.8 ibaz.cn A +short
ssh fangxintai@35.213.5.225 'free -m; df -h /; sudo ss -ltnp; systemctl is-active xray.service'
```

预期DNS仅目标A记录`35.213.5.225`；443仍由Xray占用；80/8443准备给本站；根盘可用至少满足两份应用、共享资源、私有材料、数据库和14份备份，部署后余量≥3GB。与事实表不符则停止查明。用户在GCP控制台仅放行目标机TCP80与8443入站，保留已有SSH/VPN规则，不修改443或Xray。此处不依赖未知project/zone/instance名称，不自动创建范围不明的防火墙规则。

以下命令在目标机Bash执行：

```bash
sudo mkdir -p /srv/yasi/{atlas,private,backups,incoming,tools}
sudo chown -R fangxintai: /srv/yasi
sudo chmod 700 /srv/yasi/backups
sudo apt-get update
sudo apt-get install -y caddy
sudo ss -ltnp
```

预期443仍为Xray。全新机器的包默认`caddy.service`若已被apt自动启动，只停止这个刚安装的默认实例，然后使用本站专用`band-galaxy-web.service`，避免两个Caddy争用80/admin端口；已有其他Caddy配置或服务则停止核实，不能覆盖它们。

```bash
sudo systemctl disable --now caddy.service
```

在申请证书前验证80确实公网可达。只启动本站临时HTTP证明页，不申请证书：

```bash
mkdir -p /srv/yasi/http-probe/.well-known/acme-challenge
printf 'band-galaxy-http01-ready\n' > /srv/yasi/http-probe/.well-known/acme-challenge/probe
sudo systemd-run --unit=band-galaxy-http-probe --collect \
  /usr/bin/python3 -m http.server 80 --bind 0.0.0.0 --directory /srv/yasi/http-probe
```

从Mac执行`curl --fail http://ibaz.cn/.well-known/acme-challenge/probe`，预期200且正文`band-galaxy-http01-ready`。失败先排查DNS、防火墙/80路由，不开始ACME。成功后在服务器`sudo systemctl stop band-galaxy-http-probe`释放80。该临时服务只属于本站，不触碰443或其他服务。用户还须确认GCP已放行8443，再继续。

## C. 上传固定制品、共享资源和工具

从Mac设置A节生成的真实发布号/包SHA（不要把占位符当值），先核本地包摘要再传输：

```bash
shasum -a 256 "local-content/releases/$R6_RELEASE_ID.tar.gz"
rsync -av --checksum "local-content/releases/$R6_RELEASE_ID.tar.gz" \
  "fangxintai@35.213.5.225:/srv/yasi/incoming/"
# 首次上传；词汇数据/媒体不变时跳过，应用升级不重复传图集。
rsync -av --checksum local-content/releases/shared-atlas/ \
  fangxintai@35.213.5.225:/srv/yasi/atlas/
# 仅清单内私有材料；不传源PDF、原始MP3或输出目录杂物。
rsync -av --checksum --files-from=local-content/release-private/private-files.txt \
  local-content/release-private/ fangxintai@35.213.5.225:/srv/yasi/private/
rsync -av --checksum ops/deploy/ fangxintai@35.213.5.225:/srv/yasi/incoming-tools/
```

预期接收端包SHA与Mac相同；私有目录在仓库和releases外；共享目录只有一份。先看`pack-report.json`的真实总量与服务器`df -h /`，如预估部署后少于3GB则停止，不上传全部4.6GB原音频或其他4.1GB来源。

在服务器安装本次固定提交的工具及配置：

```bash
sudo install -m 755 /srv/yasi/incoming-tools/{yasi-deploy,yasi-rollback,backup-sync.py,check-site.py,check-certificate.py} /srv/yasi/tools/
sudo install -m 644 /srv/yasi/incoming-tools/systemd/band-galaxy*.service /etc/systemd/system/
sudo install -m 644 /srv/yasi/incoming-tools/systemd/band-galaxy*.timer /etc/systemd/system/
sudo install -m 644 /srv/yasi/incoming-tools/Caddyfile /etc/caddy/band-galaxy.Caddyfile
install -m 600 /srv/yasi/incoming-tools/server.env.example /srv/yasi/server.env
sudo caddy adapt --config /etc/caddy/band-galaxy.Caddyfile --adapter caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/band-galaxy.Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
```

预期配置验证成功，站点监听只有80/8443（Caddy本机管理端口不对公网暴露），HTTP-01启用、TLS-ALPN挑战关闭。专用API只绑定127.0.0.1:5189，`EnvironmentFile`设置唯一账号、关闭注册、Secure cookie和目录。不要以`--insecure`跳过证书核验。

## D. 首次唯一账号与发布

服务器Bash交互输入初始化密码，不打印、不放shell参数值，不进包或Git：

```bash
umask 077
read -rp '唯一账号名: ' R6_OWNER_USERNAME
read -rsp '唯一账号密码: ' R6_OWNER_PASSWORD
printf '\n'
printf '%s' "$R6_OWNER_PASSWORD" > /srv/yasi/owner-init.secret
unset R6_OWNER_PASSWORD
chmod 600 /srv/yasi/owner-init.secret
```

现在DNS/80/8443前置检查已通过，才启动专用Caddy，HTTP-01自动取得Let’s Encrypt证书；服务不绑定443：

```bash
sudo systemctl enable --now band-galaxy-web.service
sudo ss -ltnp
sudo python3 /srv/yasi/tools/check-certificate.py --host ibaz.cn --port 8443
```

预期证书检查输出`Certificate valid until ...`且为可信公网证书。签发异步进行，若尚未完成，先等专用Caddy日志显示成功再重跑该只读检查，不带`--insecure`。证书失败看`journalctl -u band-galaxy-web.service`，不改Xray、不尝试443挑战。证书有效后执行以下真实首次发布；`R6_ARCHIVE_SHA`必须是A节完整摘要，`R6_SOURCE_COMMIT`和`R6_RELEASE_ID`与包一致，在服务器重新赋值真实值：

```bash
sudo env BAND_DEPLOY_ROOT=/srv/yasi BAND_DEPLOY_WEB_ROOT=/srv/yasi \
  BAND_DEPLOY_HOST=ibaz.cn BAND_DEPLOY_HTTPS_PORT=8443 BAND_DEPLOY_API_PORT=5189 \
  BAND_DEPLOY_API_SERVICE=band-galaxy.service BAND_DEPLOY_SINGLE_USER=1 \
  BAND_DEPLOY_FIRST_INSTALL=1 BAND_DEPLOY_MIN_FREE_MB=3328 \
  BAND_DEPLOY_ATLAS_ROOT=/srv/yasi/atlas BAND_DEPLOY_DB=/srv/yasi/progress.sqlite3 \
  BAND_DEPLOY_BACKUP_DIR=/srv/yasi/backups \
  BAND_DEPLOY_BACKUP_SCRIPT=/srv/yasi/tools/backup-sync.py \
  BAND_DEPLOY_SITE_CHECK_SCRIPT=/srv/yasi/tools/check-site.py \
  BAND_DEPLOY_OWNER_USERNAME="$R6_OWNER_USERNAME" \
  BAND_DEPLOY_OWNER_PASSWORD_FILE=/srv/yasi/owner-init.secret \
  /srv/yasi/tools/yasi-deploy --prebuilt \
  "/srv/yasi/incoming/$R6_RELEASE_ID.tar.gz" "$R6_ARCHIVE_SHA" "$R6_SOURCE_COMMIT" "$R6_RELEASE_ID"
```

预期：先输出`Single-owner database writer: fangxintai`，核对systemd实际User与默认`BAND_DEPLOY_API_USER=fangxintai`一致且非root。备份、建号和短效会话写库均在该用户下执行，DB及备份保持0600且fangxintai可读写，不能因sudo变成root所有。随后摘要/提交/共享资源/运行模块/临时库烟测通过；已有数据库先一致备份；空库只创建一个owner；API和current链接切换；临时短效会话验证首页/API/词汇Range，finally撤销；只保留current和previous，不回写旧数据库。失败自动恢复代码链接和API状态，保留DB及新备份。首次无上一版时失败不能伪称已回滚到旧版本，应恢复空安装状态并保留数据排查。

```bash
sudo rm -f /srv/yasi/owner-init.secret
unset R6_OWNER_USERNAME
sudo systemctl enable --now band-galaxy.service band-galaxy-backup.timer band-galaxy-cert-renew.timer
sudo systemctl start band-galaxy-backup.service
sudo systemctl is-active band-galaxy.service band-galaxy-web.service
sudo systemctl list-timers 'band-galaxy-*'
stat -c '%U %a %n' /srv/yasi/progress.sqlite3
find /srv/yasi/backups -maxdepth 1 -name '*.sqlite3' -exec stat -c '%U %a %n' {} \;
```

预期每日04:00 Asia/Shanghai备份，daily与predeploy合计保留真实时间最近14份；数据库未初始化时备份器如实提示无库。证书由Caddy内部自动续期，04:15 timer检查实际证书链和到期日，异常只reload本站web并报错，不把reload谎称为已经强制续期。每周从Mac拉回一份最近备份（先SSH列出真实文件名，再填变量）：

```bash
rsync -av --checksum "fangxintai@35.213.5.225:/srv/yasi/backups/$R6_BACKUP_FILENAME" \
  local-content/server-backups/
```

资料AI补齐并重新上传私有清单后，手机和Mac各在“我的”点击准备私有题库更新目录，再选题缓存音频；学习记录仍随账号同步，素材缓存分别保存在各设备。

第二次及之后部署沿用同一命令，改`BAND_DEPLOY_FIRST_INSTALL=0`并删除两项OWNER参数；已有唯一owner不重新建号。发布包仍在Mac构建并固定提交/SHA。

## E. 回滚代码，不回滚学习成果

先`readlink -f /srv/yasi/current`并列出`/srv/yasi/releases/`，选实际保留的上一版。首次部署只有一版则没有可回滚对象；第二次发布成功后才有previous。调用：

```bash
sudo env BAND_DEPLOY_ROOT=/srv/yasi BAND_DEPLOY_WEB_ROOT=/srv/yasi \
  BAND_DEPLOY_HOST=ibaz.cn BAND_DEPLOY_HTTPS_PORT=8443 BAND_DEPLOY_API_PORT=5189 \
  BAND_DEPLOY_API_SERVICE=band-galaxy.service BAND_DEPLOY_SINGLE_USER=1 \
  BAND_DEPLOY_DB=/srv/yasi/progress.sqlite3 \
  BAND_DEPLOY_BACKUP_DIR=/srv/yasi/backups \
  BAND_DEPLOY_BACKUP_SCRIPT=/srv/yasi/tools/backup-sync.py \
  BAND_DEPLOY_SITE_CHECK_SCRIPT=/srv/yasi/tools/check-site.py \
  /srv/yasi/tools/yasi-rollback "/srv/yasi/releases/$R6_PREVIOUS_RELEASE_ID"
```

预期：先备份、校验API协议/迁移版本及模块hash，恢复代码和API链接，通过鉴权健康检查。原SQLite保持不倒回，目标不兼容则拒绝，不用旧副本覆盖新学习记录。不碰共享图集、private目录或Xray。

## F. 上线后只读核验与真机检查

规划/复核AI在用户批准后执行只读curl/SSH核验，不自行部署：

- `curl -sI https://ibaz.cn:8443/`：跳到登录页；HSTS在Web层存在。
- 未登录请求`/api/learning/v2/changes?cursor=0`或`/private/manifest.json`、任意真实私有音频：401或403。
- 用户正常登录后用其会话对真实`/private/audio/<sha>.m4a`发`Range: bytes=0-99`：206、恰好100字节。Cookie文件若临时落盘必须600并及时删除，不把Cookie打印到报告。
- `sudo ss -ltnp`：443仍为Xray，8443本站，5189仅127.0.0.1；`systemctl is-active xray.service`与部署前一致。
- `systemctl is-active band-galaxy.service band-galaxy-web.service`及备份timer最近一次结果正常；检查证书到期日和`df -h /`剩余≥3GB。
- Me准备私有听读/写说题库。抽3套听力分别验证在线播、复盘拖动、缓存后真断网播放；未准备的音频如实提示联网准备。手机与Mac分别缓存素材，文字进度同步。
- iPhone Safari用添加到主屏幕安装，Mac Safari添加到程序坞或Chrome安装；独立全屏启动、390布局、离线保存和联网补传、会话过期重登录保留outbox。

截图留用户Mac本地、不进Git。候选阶段的本机Chrome和假麦克风测试不能替代真实iPhone/Mac PWA结果；真机与真实容量/证书/公网Range均在上线后填记录，目前不声称已完成。
