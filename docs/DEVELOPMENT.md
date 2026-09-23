# 本地开发

面向修改平台源码的开发者。只想运行产品，请用 [容器部署](../deploy/README.md)。

## 依赖与初始化

Node 22+、pnpm 10.34.5、Python 3.11+（已有验证为 3.13）、Docker。

```sh
corepack enable
pnpm install --frozen-lockfile
cp -n .env.example .env
# 编辑本地 .env，填写当前机器的数据库连接、内部服务令牌和管理员配置。
docker compose up -d postgres redis
pnpm --filter @ai-qa/api exec prisma generate
pnpm db:migrate
pnpm db:seed
python3 -m venv services/intelligence/.venv
services/intelligence/.venv/bin/python -m pip install -r services/intelligence/requirements-dev.lock
```

数据库和队列的开发默认发布端口见根 compose（PostgreSQL 5435 / Redis 6380），生产模板与开发模板为不同配置，不要混用已有数据卷。

## 启动进程

分别在终端运行：

```sh
pnpm dev:api           # 7300
pnpm dev:worker        # 7200
pnpm dev:web           # 7100
pnpm dev:intelligence  # 7500
```

Python 不自动读取根 `.env`。启动前向它的进程环境注入 `AIQA_INTELLIGENCE_TOKEN`、`AIQA_ARTIFACT_DIR`；worker 配置相同内部令牌和 `AIQA_INTELLIGENCE_URL=http://127.0.0.1:7500`。路径和模型设置见 [智能服务说明](../services/intelligence/README.md)。真实模型评测是显式 opt-in。

需要采购审批演示系统时另起 `pnpm dev:demo`（7400）；测试账号见 [demo 说明](../apps/demo-app/README.md)。实际项目账号通过凭据引用配置，勿放在 PRD、用例正文或公开 Issue。

## 验证入口

```sh
pnpm typecheck
pnpm contracts:check
services/intelligence/.venv/bin/python services/intelligence/scripts/generate_models.py --check
pnpm test:contracts
pnpm test:intelligence
pnpm -r --workspace-concurrency=1 test
```

真实数据库/浏览器测试需要 Docker 和 Chromium。安装浏览器可用 `pnpm --filter @ai-qa/worker exec playwright install chromium`。数据库测试创建临时库，不用手动重置开发库。资源有限时串行执行，不与大型镜像构建同时跑全仓测试。

更多： [运行器验收](../tools/self-hosted-runner/README.md)、[隔离安装/升级验收](../tools/release-acceptance/README.md)、[1.0 完成记录](delivery/v1-code-completion-20260922.md)。

## 目录

| 目录 | 职责 |
|---|---|
| apps/api / apps/web / apps/worker | 平台、页面、持久化执行 |
| services/intelligence | Python 文档/规则/用例/计划与模型网关 |
| packages/contracts | 共享契约与双端生成来源 |
| packages/test-runtime / evaluation / reporting | 浏览器动作、程序化聚合与证据报告 |
| tools/self-hosted-runner | 隔离工程任务 |
| tools/pilot-acceptance / release-acceptance | 试点和发布验证 |

停止开发容器使用 `docker compose stop`，保留数据。不要用删除持久卷的命令替代升级。
