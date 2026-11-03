# 部署制品与回滚工具

这些脚本随P1数据通路一起纳入仓库，保证新增的 `server/learning.py` 能进入正式API制品。脚本来自现有运维工具，本次没有执行生产安装或发布。

| 文件 | 用途 |
| --- | --- |
| yasi-deploy | 接收并核验发布包，构建候选前端/API制品，验证后切换 |
| yasi-rollback | 回滚前端/API代码链接，保留学习数据库 |
| backup-sync.py | 使用SQLite backup API制作一致性备份 |
| test_receiver.py | 临时目录与模拟命令中的部署、制品缺失和回滚故障场景 |

API运行文件由 [server/runtime-files.json](../../server/runtime-files.json)列出。发布接收器读取这份清单，将运行模块完整复制到候选和正式API目录；缺少模块时必须在切换前失败。没有清单的历史版本按原单文件API处理。

在仓库根目录运行隔离验证：

```sh
python3 ops/deploy/test_receiver.py
```

这是直接运行的场景脚本，不使用unittest discovery。它在临时目录中模拟部署和回滚，替换系统管理、网络检查和构建命令，不读取生产数据库、不连接服务器。33个场景通过不等于真实服务器发布或真机验收完成。

生产脚本依赖已配置的Linux、Bash、Python、Node/npm、Nginx和systemd环境。服务器安装路径、服务配置及本地上传步骤沿用现有维护流程；新增运行模块时同步维护清单和候选制品验证。不要在仓库中保存SSH密钥、known_hosts、真实部署日志或生产数据库。

每阶段推送GitHub分支只保存可复核的代码与文档，不自动安装服务器工具。生产安装或应用发布按单独确认的上线流程执行。
