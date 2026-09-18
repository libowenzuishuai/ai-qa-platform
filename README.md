# AI 测试人员平台

> 阶段二采用 **TypeScript 平台 + Python 智能服务**。三人开工请先读 [分工与接口清单](docs/stage2-python-handoff.md)，Python 启动见 [服务说明](services/intelligence/README.md)。当前完成基建，正式解析/生成算法待 B/C 实现。
根据版本化产品资料（PRD、业务说明、原型）形成有依据的规则与用例，在多人
开发合并后的 Web 测试环境中独立执行验收测试，输出可追溯报告、缺陷与复测。

- 产品规格：[docs/ai-qa/02-产品需求文档-PRD.md](docs/ai-qa/02-产品需求文档-PRD.md)
- 项目评审：[docs/ai-qa/01-项目评审.md](docs/ai-qa/01-项目评审.md)
- 开发提示词：[docs/ai-qa/03-GLM开发提示词.md](docs/ai-qa/03-GLM开发提示词.md)
- 实施状态：[docs/implementation-status.md](docs/implementation-status.md)

> 当前处于**阶段 1.1（固定用例真实浏览器执行闭环 + 独立评审修复）**：登录
> 平台 → 选择环境与固定用例 → 真实浏览器执行（连接层网络策略、CAS 生命
> 周期、固定计划版本、证据完整性复核）→ 持久化进度/断言/截图/trace →
> 报告与复验。AI 自动生成测试（资料解析、模型规划）在阶段 2 起；本阶段
> 用例为人工种子（origin=manual），执行 mode=real。不应作为生产测试平台部署。

## 目录结构

```text
apps/api                 平台 API：登录/项目权限/环境登记/运行/SSE/报告/证据下载/种子
apps/worker              执行 worker：BullMQ 消费、七动作浏览器执行器、证据、对账租约
apps/demo-app            独立待测审批系统（采购单申请/审批/付款待办，SQLite）
apps/web                 最小运行页面：登录、启动、实时进度、取消、报告与证据（SSR + SSE 代理）
packages/contracts       领域契约：状态机、TestPlan v1、断言语义、acceptanceHash（Zod）
packages/artifact-store  证据存储：受控目录、checksum、防目录穿越
packages/test-runtime    Playwright 执行器：七动作、导航策略、程序化断言、证据采集
packages/evaluation      确定性聚合：case verdict、运行指标、严格验收（FR-10）
packages/model-adapters  模型适配器（占位，阶段 2）
packages/doc-ingestion   文档解析（占位，阶段 2）
tools/phase1-acceptance  阶段 1 集成验收 harness（评测器专用，53 项场景）
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

# 5. 启动服务（各开一个终端）
pnpm dev:api                  # http://127.0.0.1:7300
pnpm dev:worker               # http://127.0.0.1:7200（需 DEMO_* 账号环境变量）
pnpm dev:web                  # http://127.0.0.1:7100（平台页面）
pnpm dev:demo                 # http://127.0.0.1:7400（待测系统）
```

worker 需要待测系统测试账号（经环境变量注入，不入库）：

```bash
DEMO_APPLICANT_USERNAME=applicant1 DEMO_APPLICANT_PASSWORD='...' \
DEMO_SUPERVISOR_USERNAME=supervisor1 DEMO_SUPERVISOR_PASSWORD='...' pnpm dev:worker
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
pnpm test:contracts           # 契约 schema 校验测试（81 项）
pnpm --filter @ai-qa/api test # API 策略 + 数据库层边界反例（30 项，临时库）
pnpm test:runtime             # 执行器单测（真实 Chromium，20 项，含网络/语义）
pnpm test:golden              # demo-app 黄金验收（真实浏览器，健康 + B1–B4）
pnpm test:phase1              # 阶段 1 隔离集成验收（62 项；独立库/Redis/端口）
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
