# 1.0 容器部署

在仓库根目录使用 Node/worker/web/Python 四类镜像，PostgreSQL、Redis 和证据卷独立持久化。所有端口默认仅绑定本机。生产反向代理和 TLS 由部署方配置；不要把开发 .env 或密钥加入镜像。

## 安装与启动

```sh
cp deploy/.env.production.example deploy/.env.production
# 编辑本地文件，填写独立数据库口令、会话密钥、智能服务令牌和初始管理员。
docker compose -p aiqa-prod -f deploy/compose.production.yaml --env-file deploy/.env.production build
docker compose -p aiqa-prod -f deploy/compose.production.yaml --env-file deploy/.env.production up -d --wait
```

Compose 自动等待数据库健康、迁移成功、初始管理员初始化完成，再启动 API；worker 也等待迁移和智能服务。缺配置或迁移失败会阻止依赖服务启动。初始管理员密码只给 seed 容器，不进入 API/worker 环境；种子幂等且不覆盖已有账号。

默认页面 http://127.0.0.1:7100。模型未配置时可以登录、管理资产、运行已批准计划；需要模型的作业返回明确未配置错误，不能生成虚构结果。配置说明见 [Python 服务](../services/intelligence/README.md)。待测网址与测试账号应通过准备中心登记，并将引用对应的环境变量安全注入 worker；不要直接编辑镜像。

GitHub App 为可选覆盖配置，见 [接入说明](../docs/delivery/github-app-integration.md)。工程运行器在独立受信任主机部署，见 [运行器](../tools/self-hosted-runner/README.md)；不要把 Docker socket 挂进平台容器。

## 备份、升级与恢复

1. 在维护窗口暂停写入/执行，记录当前镜像 digest 和版本。用 PostgreSQL `pg_dump -Fc` 备份数据库，同时备份 `artifacts-prod` 卷；仅备份数据库不能恢复受限证据。
2. 保持 compose project 名称和持久卷，构建新镜像。先执行单次 `run --rm migrate`，成功后再 `up -d --wait`。迁移使用追加式目录，不修改已应用迁移。
3. 恢复演练使用另一个 compose project/数据库和证据卷，导入旧备份后应用新迁移，核对旧报告内容、证据 SHA-256 和实际浏览器新运行。
4. 不使用 `down -v` 更新已有业务环境。数据库升级后的回滚须使用对应版本备份，不能假定替换旧镜像即可回滚 Schema。

本地可复现实验见 [发布验收工具](../tools/release-acceptance/README.md)。镜像构建和恢复均在 ARM64 本地 Docker 验证；未声称已推送镜像 registry 或验证全部生产架构。
