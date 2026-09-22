# 隔离发布验收

`run.py` 创建随机 compose project、临时凭据、独立数据库/卷/动态端口，结束时仅清理本轮创建的资源。不会读取开发 `.env`、使用已有业务库或重新启动既有栈。需要本地 Docker、已审核的新旧镜像和 Python 3.11+。

先在仓库根目录构建最终镜像：

```sh
docker build -t aiqa-api:v1-review -f apps/api/Dockerfile .
docker build -t aiqa-worker:v1-review -f apps/worker/Dockerfile .
docker build -t aiqa-web:v1-review -f apps/web/Dockerfile .
docker build -t aiqa-intelligence:v1-review services/intelligence
python3 tools/release-acceptance/run.py
```

旧版本镜像通过 `AIQA_RELEASE_OLD_API`、`AIQA_RELEASE_OLD_SEED`、`AIQA_RELEASE_OLD_WORKER` 指定；本地缺旧镜像应明确失败，不能用新镜像冒充升级验证。旧 seed 镜像可与旧 API 不同，以保留历史打包行为。

验收流程：旧版空库安装/管理员 → 旧 worker 真实 Chromium 业务断言和截图/trace → 数据库+证据备份 → 新版全栈健康 → 旧报告仍 PASS → 新版独立空库迁移/初始化 → 备份恢复到另一个库和证据卷 → 完整报告逐项相同 → 新 worker 实际 Chromium 新运行 PASS。

产物在 `data/pilot-evidence/production-release-<随机项目>.json`，包含代码提交、未提交 diff 哈希、镜像 ID、备份哈希、运行 ID 和每个实际步骤；`production-release.json` 仅为最新副本。失败尝试独立保留，cleanupErrors 不为空不能作为干净通过。凭据只在权限 0600 的临时文件内，日志屏蔽其值。

夹具属于 synthetic，只证明安装/升级/证据恢复和真实浏览器组件，不能算第二真实业务项目或实际大模型验收。`container-fixture.ts` 仅复制到一次性验收容器，不进入生产镜像。
