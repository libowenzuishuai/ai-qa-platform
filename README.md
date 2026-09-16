# AI 测试人员平台

根据版本化产品资料（PRD、业务说明、原型）形成有依据的规则与用例，在多人
开发合并后的 Web 测试环境中独立执行验收测试，输出可追溯报告、缺陷与复测。

- 产品规格：[docs/ai-qa/02-产品需求文档-PRD.md](docs/ai-qa/02-产品需求文档-PRD.md)
- 项目评审：[docs/ai-qa/01-项目评审.md](docs/ai-qa/01-项目评审.md)
- 开发提示词：[docs/ai-qa/03-GLM开发提示词.md](docs/ai-qa/03-GLM开发提示词.md)
- 实施状态：[docs/implementation-status.md](docs/implementation-status.md)

> 当前处于**阶段 0.2（工程基线与两轮评审修复）**，适合研究、协作开发和运行演示。
> 浏览器测试执行器、管理台和 AI 自动生成测试尚未实现；执行器在阶段 1、
> 运行时模型接入在阶段 2 起。当前版本不应作为生产测试平台部署。

## 目录结构

```text
apps/api                 平台 API（Fastify + Prisma）：登录、项目权限、环境登记
apps/worker              执行 worker（阶段 0 骨架；容器只挂载 dist 与依赖，不含仓库源码）
apps/demo-app            独立待测审批系统（采购单申请/审批/付款待办，SQLite）
apps/web                 管理台前端（占位，后续阶段）
packages/contracts       领域契约：状态机、TestPlan v1、API 错误（Zod 运行时校验）
packages/model-adapters  模型适配器（占位，阶段 2）
packages/doc-ingestion   文档解析（占位，阶段 2）
packages/test-runtime    执行运行时（占位，阶段 1）
packages/evaluation      聚合与覆盖（占位，阶段 1）
docs/ai-qa               产品规格资料包
docs                     实施状态、决策记录、验证记录
```

## 快速开始

依赖：Node >= 22、pnpm（`corepack enable`）、Docker（数据库/队列/演示系统）。

```bash
# 1. 环境变量
cp .env.example .env          # 填入 SEED_ADMIN_PASSWORD 等

# 2. 依赖
corepack enable
pnpm install

# 3. 基础设施（Postgres 5435、Redis 6380）
docker compose up -d postgres redis

# 4. 数据库迁移与种子
pnpm db:migrate
SEED_ADMIN_PASSWORD='你的密码' pnpm db:seed

# 5. 启动服务
pnpm dev:api                  # http://127.0.0.1:7300
pnpm dev:demo                 # http://127.0.0.1:7400（待测系统）
pnpm --filter @ai-qa/worker start   # http://127.0.0.1:7200（骨架）
```

登录 API：

```bash
curl -c /tmp/c.txt -X POST localhost:7300/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<SEED_ADMIN_PASSWORD>"}'
curl -b /tmp/c.txt localhost:7300/api/projects
```

demo-app 演示账号：`applicant1 / Applicant#2026`（申请人）、
`supervisor1 / Supervisor#2026`（主管）。业务规则与缺陷模式见
[apps/demo-app/README.md](apps/demo-app/README.md)。

## 验证命令

```bash
pnpm test:contracts           # 契约 schema 校验测试（75 项）
pnpm --filter @ai-qa/api test # API URL 白名单策略等单测
pnpm test:golden              # demo-app 黄金验收（真实浏览器，健康 + B1–B4）
pnpm typecheck                # 全部包类型检查

# 数据库不变量（跨项目/悬空引用/已批准版本不可变；需先起 compose postgres）：
docker exec ai-qa-postgres-1 createdb -U aiqa aiqa_invariants
DATABASE_URL="postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_invariants?schema=public" \
  pnpm --filter @ai-qa/api exec prisma migrate deploy
DATABASE_URL="postgresql://aiqa:aiqa_dev_password@127.0.0.1:5435/aiqa_invariants?schema=public" \
  pnpm --filter @ai-qa/api exec tsx scripts/verify-db-invariants.ts
docker exec ai-qa-postgres-1 dropdb -U aiqa aiqa_invariants
```

黄金验收首次运行前需安装浏览器：
`pnpm --filter @ai-qa/demo-app exec playwright install chromium`。

## 停止与清理

```bash
# 停止本地进程后：
docker compose down           # 保留数据
docker compose down -v        # 连同数据库卷一起删除（谨慎）
```
