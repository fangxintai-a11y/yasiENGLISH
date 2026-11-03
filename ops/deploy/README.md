# 部署制品与回滚工具

这些是现有发布接收器和回滚脚本的参数化版本。本轮没有连接生产机、安装服务或发布应用；真实服务器的服务入口和静态目录尚未核验。

## 配置

部署与回滚从环境变量读取配置，不修改Nginx配置、不调用Nginx或任何服务的reload。公网端口必须大于等于1024，避免使用共享443端口；systemd只操作明确指定的API服务。

| 变量 | 含义与默认值 |
| --- | --- |
| BAND_DEPLOY_ROOT | 必填，发布根目录，含incoming、releases、api-releases等 |
| BAND_DEPLOY_WEB_ROOT | 必填，包含current静态资源链接的目录 |
| BAND_DEPLOY_HOST | 必填，健康检查的域名 |
| BAND_DEPLOY_HTTPS_PORT | 专用公网HTTPS端口，默认8443 |
| BAND_DEPLOY_API_PORT | 本机API端口，默认5189 |
| BAND_DEPLOY_API_SERVICE | 已有API systemd服务名，默认band-galaxy.service |
| BAND_DEPLOY_MIN_FREE_MB | 发布前最低可用空间，默认1024 MB；按实际产物和备份空间设置 |
| BAND_DEPLOY_LOCK | 发布锁路径，默认发布根目录/deploy.lock |
| BAND_DEPLOY_ENV_FILE | 已有API环境文件，默认发布根目录/server.env |
| BAND_DEPLOY_DB | 部署与回滚必填，真实SQLite文件路径 |
| BAND_DEPLOY_BACKUP_DIR | 默认数据库所在目录/backups |
| BAND_DEPLOY_BACKUP_SCRIPT | 部署与回滚必填，使用支持备份及--verify-api兼容检查的本目录backup-sync.py |
| BAND_DEPLOY_NPM_REGISTRY | 可选，仅源码构建模式使用的npm仓库 |

所有路径使用绝对路径。`WEB_ROOT/current`须已经指向`ROOT/releases/发布号`。API服务须已经通过`ROOT/api-current/app.py`运行，且该链接指向`ROOT/api-releases/发布号`。脚本会核对已有unit中包含这个入口；如果当前实际服务仍直接运行`/opt/bandgalaxy/app.py`，本脚本会停止，不会自动重写unit、移动现有入口或影响其他服务。是否迁移入口需另行核验并确认。

## 预构建模式

在构建机完成前端构建和测试，再制作只含以下内容的制品：

```text
dist/                       已构建的完整静态资源
server/runtime-files.json   API运行文件清单
server/app.py
server/learning.py          以及清单列出的其他Python运行模块
```

清单必须包含app.py和learning.py。tar.gz采用PAX格式，全局comment保存对应Git提交的完整40位SHA；不得包含符号链接、硬链接、路径穿越、密钥或数据库。包上传到配置的`ROOT/incoming/RELEASE_ID.tar.gz`后使用：

```sh
yasi-deploy --prebuilt ARCHIVE SHA256 COMMIT RELEASE_ID
```

预构建模式不运行npm、前端构建或源码单元测试。它核验包摘要、提交标识、路径与完整静态资源，按清单安装API模块，然后从候选API目录用临时SQLite和临时端口检查健康、未登录会话及学习接口鉴权。

候选验证后，先调用SQLite backup API备份真实数据库，再切API链接并重启配置的API服务，最后原子切换静态资源链接。公网健康与音频Range检查使用配置的域名和端口，例如`--resolve ibaz.cn:8443:127.0.0.1`。失败或信号中断时恢复代码链接和API服务状态，保留数据库及新备份，不用旧数据库覆盖发布后的成果。

省略`--prebuilt`仍可运行原有源码构建流程，需要Node/npm及足够的构建资源。对于1 GB内存、无swap的目标机，应使用预构建模式；1 GB空闲空间的隔离小样本测试通过，不代表真实完整制品必然有足够空间，发布前仍需核对解包、备份和保留上一版本所需容量。

回滚只接受配置发布目录里的版本：

```sh
yasi-rollback RELEASE_DIRECTORY
```

候选烟测会在API目录写入`runtime-meta.json`，记录临时库的学习迁移版本、学习协议版本和运行模块hash。含learning.py的回滚目标必须有这份记录，模块hash匹配、协议至少为2，而且迁移版本与当前真实数据库只读查得的版本一致；未标记的旧P1学习模块和版本不匹配的目标被拒绝。

不含learning.py的旧词汇API也必须核验代码来源：当前仅放行`V1.2.0-11.3`提交`f3384e35719b19f38e515f9cb8cfaca7c408f78f`的原始server/app.py，SHA256为`9b9b7a38e67eb5c9bc26983e5daf544f86df87b413739b7b84fc36be34379611`。单纯缺少learning.py或提供自报元数据不代表安全；缺模块的新版入口、修改过的旧入口和未知单文件API均被拒绝。新增词汇回滚版本须先核验代码，再更新此精确hash白名单。

自动失败恢复也执行同一检查。无法证明旧学习API兼容时恢复原代码链接，但停止配置的API服务并明确报错，不让未知旧代码恢复写入；新客户端遇能力不匹配时应暂停同步并保留outbox。任何代码回滚都不会恢复旧数据库覆盖新学习成果。发布工具与备份/兼容检查helper须使用同版本，不能只更新其中一个脚本。

## 隔离验证

```sh
python3 ops/deploy/test_receiver.py
```

测试在临时目录模拟系统管理、磁盘、构建和网络检查，候选API仅绑定本机临时端口，不读取生产数据库、不连接服务器。覆盖摘要和提交标识、路径穿越、源码构建失败、候选模块缺失、API与公网健康、Range、信号恢复、代码回滚、1 GB空闲下的预构建，以及专用8443健康检查。任何Nginx或reload调用都会使测试失败。

当前GitHub阶段提交只保存代码和验证证据，不等于已安装生产工具或完成真实服务器发布。
