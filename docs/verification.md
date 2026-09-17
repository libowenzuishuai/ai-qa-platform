# 验证记录

日期：2026-09-16 · 环境：macOS (Darwin 25.0.0, arm64) · Node v23.11.0 ·
pnpm 10.34.5 · Docker 29.5.2（colima VM）· Playwright Chromium 153

只记录实际执行过的命令与结果；未执行的验证不在本文件出现。

## 1. 契约测试（packages/contracts）

```
$ pnpm test:contracts
Test Files  2 passed (2)
     Tests  34 passed (34)
```

覆盖点（对应阶段 0 验收“contracts 拒绝空断言、非法动作和断裂引用”）：

- 空断言集合 / 空动作集合 / expected 缺失 / 数值断言缺单位 → 拒绝
- 非法动作类型（eval 等） / 非法 effect / 绝对 URL goto / 无界轮询 /
  计划外 switchRole → 拒绝
- 未登记观察绑定的 targetRef / 引用不存在断言 / 无检查动作引用的断言 /
  计划外规则 / 先用后定义捕获变量 / stepId 与检查动作不一致 → 拒绝
- Run 生命周期：正常路径合法、终态不可回退、不可跳阶段、取消语义
- EXPLICIT 无来源拒绝；用例引用未声明规则拒绝
- acceptanceHash：键序无关、数组顺序语义保持、改 expected/required/operator
  均改变哈希
- 执行器能力校验：阶段 1 子集拒绝 visualAction

## 2. 数据库迁移（apps/api）

```
$ pnpm --filter @ai-qa/api exec prisma migrate dev --name init
# Your database is now in sync with your schema（26 表：25 领域表 + _prisma_migrations）

# 全新空库复验：
$ docker exec aiqa-postgres createdb -U aiqa aiqa_clean_test
$ DATABASE_URL=...aiqa_clean_test pnpm --filter @ai-qa/api exec prisma migrate deploy
All migrations have been successfully applied.   # information_schema 计 26 表
$ docker exec aiqa-postgres dropdb -U aiqa aiqa_clean_test
```

关键约束随迁移落库：`(runId, caseVersionId, attemptNo)` 唯一、
`(projectId, idempotencyKey)` 唯一、`(projectId, eventId)` 唯一、
版本表 `(ruleId, version)` / `(caseId, version)` / `(caseVersionId, version)` 唯一。

## 3. 平台 API 鉴权与权限（apps/api，本地进程 + compose Postgres）

| 检查 | 结果 |
|---|---|
| GET /api/health | `{"ok":true,"service":"api","db":"up"}` |
| 未登录访问 /api/projects | 401，错误体含 code/message/requestId |
| 错误密码登录 | 401 UNAUTHENTICATED |
| admin 登录 / me / 建项目 | 200，Cookie 会话落库 |
| viewer 建项目 | 403「查看者不能创建项目」 |
| viewer 访问未加入项目 | 403；列表返回空 |
| viewer 登记环境 | 403「需要 LEAD 及以上项目权限」 |
| baseUrl 不在 allowedOrigins | 422 VALIDATION_ERROR（details 指向字段） |
| isProduction 环境 | 422 UNSUPPORTED（首版禁止） |
| 合法环境登记 | 200 |

种子：`SEED_ADMIN_PASSWORD=… pnpm db:seed` 创建 admin/lead1/viewer1
（密码全部来自环境变量，未入库代码）。

## 4. demo-app 冒烟（curl，健康版本）

| 步骤 | 预期 | 实际 |
|---|---|---|
| 登录 applicant1 | 302 | 302 ✓ |
| 错误密码 | 401 | 401 ✓ |
| 创建 5000.01 元（500001 分）并提交 | 待审批 | 待审批 ✓ |
| 申请人审批 | 403 申请人不可审批 | 403 ✓ |
| 主管审批 | 付款待办 + 待办列表含该单 | ✓ |
| 恰好 5000.00 元（500000 分）提交 | 直接付款待办 | 付款待办 ✓ |
| POST /api/fixtures/reset 无令牌 | 403 | 403 ✓ |
| 带令牌 reset / orders | 清空成功 / 返回内部状态 | ✓ |

## 5. 黄金验收（Playwright 真实浏览器 × 5 模式）

```
$ pnpm --filter @ai-qa/demo-app exec playwright install chromium
$ pnpm test:golden
PASS  healthy   # 5 tests：双角色全流程、边界直入待办、小额免审、
               # 越权 403、非法金额校验
PASS  B1        # 恰好 500000 分被错误送审批（存在性断言）
PASS  B2        # 申请人审批被放行（302，健康版应 403）
PASS  B3        # 审批后付款待办缺失该单
PASS  B4        # 创建成功提示后刷新数据丢失
```

运行器（scripts/run-golden.mjs）为每个模式独立端口（7410–7414）、独立
临时 SQLite 启动服务，任何模式失败整体退出码非 0。

## 6. 类型检查与构建

> 更正（阶段 0.1 评审）：提交 46e7e3f 时 worker 依赖未进 lockfile，
> `pnpm typecheck` 实际在 worker 报 `tsc: command not found`，当时记录
> “全部 0 错误”不成立。修复后的真实结果见 §11。

```
$ pnpm --filter @ai-qa/demo-app build   # tsc 产出 dist/（纯 JS）
```

## 7. Docker Compose

```
$ docker compose up -d postgres redis demo-app
ai-qa-postgres-1  Up (healthy)      # 127.0.0.1:5435
ai-qa-redis-1     Up (healthy)      # 127.0.0.1:6380
ai-qa-demo-app-1  Up                # 127.0.0.1:7400
$ curl 127.0.0.1:7400/health        # {"ok":true}
# 容器内业务流：登录/创建 8000.50 元/提交 → 待审批 ✓
```

注：compose 内 api/worker 服务已定义但未在本环境验证（容器无 npm
registry 访问且 Prisma 原生引擎需按平台构建）；本地运行路径已验证。

## 8. 未执行的验证（明确列出）

- 真实 GLM 文本/视觉模型连通性与效果（无 API 凭据，阶段 2）
- 客户真实环境接入（无目标系统，试点期）
- compose 中 api/worker 容器启动（见 §7 注）

---

# 阶段 0.1 验证记录（评审修复）

日期：2026-09-16 · 评审依据：阶段0代码评审-46e7e3f.md

## 8. 修复后回归

### 8.1 契约测试（34 → 55）

```
$ pnpm test:contracts
Test Files  2 passed (2)
     Tests  55 passed (55)
```

新增覆盖：R1（lte/gt 保留、缺 operator/expected/unit 拒绝、APPROVED 缺
approvalHash 拒绝）、R4（换 fixture/参数/步骤角色/expected/operator/required/
值引用类型/字面量值 → 哈希变化；定位调整 → 哈希不变）、R5（//host 与反斜杠
拒绝，附 new URL 语义确认）、计划-用例一致性（改 operator/expected/增删
断言拒绝）、三.1/三.2/三.3（UI 目标必需、kind-动作一致、waitFor 目标、
条件捕获拒绝）。原 34 项断言全部保留。

### 8.2 API URL 策略（R2）

```
$ pnpm --filter @ai-qa/api test
Test Files  1 passed (1)
     Tests  13 passed (13)
```

评审四个攻击行全部改为拒绝：前缀拼接域名、userinfo 欺骗（附
`new URL(...).origin === attacker.invalid` 语义确认）、非默认端口、
协议相对路径；另覆盖默认端口归一化、http≠https、白名单条目自检。

### 8.3 worker 容器隔离（三.5）

```
$ pnpm --filter @ai-qa/worker build && docker compose up -d worker
$ curl 127.0.0.1:7200/api/health
{"ok":true,"service":"worker","status":"stub","capabilities":{"executor":false,"queue":false}}
$ docker compose exec worker ls /app/apps/worker/        # 仅 dist node_modules
$ docker compose exec worker ls /app/apps/worker/tests-golden
ls: /app/apps/worker/tests-golden: No such file or directory   # 评测答案不可达
```

## 9. 数据库不变量（R6，临时库执行后删除）

```
$ docker exec ai-qa-postgres-1 createdb -U aiqa aiqa_invariants
$ DATABASE_URL=…/aiqa_invariants pnpm --filter @ai-qa/api exec prisma migrate deploy
$ DATABASE_URL=…/aiqa_invariants pnpm --filter @ai-qa/api exec tsx scripts/verify-db-invariants.ts
PASS  R6-1 跨项目：项目 A 的 Run 引用项目 B 的环境 — 已拒绝
PASS  R6-2 悬空引用：Run 引用不存在的 baseline — 已拒绝
PASS  R6-3 悬空引用：CaseAttempt 引用不存在的用例版本 — 已拒绝
PASS  R6-4 跨项目：项目 A 的 attempt 引用项目 B 的用例版本 — 已拒绝
PASS  R6-5 已批准 RuleVersion 语义字段原地 UPDATE — 已拒绝
PASS  R6-6 工作流字段更新（reviewStatus → SUPERSEDED）被允许
PASS  R6-7 已批准 TestCaseVersion 语义字段原地 UPDATE — 已拒绝
$ docker exec ai-qa-postgres-1 dropdb -U aiqa aiqa_invariants
```

迁移 `20260916090000_fk_and_version_immutability`：复合外键 + 两个
IMMUTABLE_SEMANTIC_FIELDS 触发器。开发库已用全部迁移重建并重播种。

## 10. 干净提交快照冻结安装（R3，提交 f85a071）

```
$ git archive HEAD | tar -x -C /tmp/aiqa-snap && cd /tmp/aiqa-snap
$ pnpm install --frozen-lockfile --ignore-scripts --offline
Progress: resolved 148, reused 148, downloaded 0, added 148, done   # 不再报 ERR_PNPM_OUTDATED_LOCKFILE
```

`--ignore-scripts` 会跳过 Prisma 的 postinstall client 生成，直接 typecheck
出现 6 个 `PrismaClient` 导出错误（构建步骤缺失，非 manifest/lockfile 不一致）。
执行标准生成步骤后：

```
$ pnpm --filter @ai-qa/api db:generate
$ pnpm typecheck        # 0 错误（含 worker）
$ pnpm test:contracts   # 55/55
$ pnpm test:golden      # healthy/B1/B2/B3/B4 全 PASS（真实浏览器）
```

快照验证后已删除。

## 11. 全量套件

```
$ pnpm test:contracts   # 55/55
$ pnpm --filter @ai-qa/api test   # 13/13
$ pnpm test:golden      # healthy/B1/B2/B3/B4 全 PASS（10 项）
$ pnpm typecheck        # 0 错误（contracts/api/demo-app/worker）
```

---

# 阶段 0.2 验证记录（复核修复 F1–F5）

日期：2026-09-16 · 依据：《阶段0.1复核与Kimi配置-f48c3b4.md》

## 12.1 全量回归

```
$ pnpm test:contracts   # 75/75（0.1 时 55，全部保留）
$ pnpm --filter @ai-qa/api test   # 13/13
$ pnpm test:golden      # healthy/B1/B2/B3/B4 全 PASS
$ pnpm typecheck        # 0 错误
```

新增契约覆盖：F5 控制字符路径 5 例 + new URL 语义确认 + 合法路径对照；
F2 导航路径/断言 targetRef/kind/stepId/waitFor 业务值变哈希、超时参数与
定位方式不变；F3 DRAFT 用例/错版本/kind/越界角色/越界规则拒绝，
verifyStoredPlan 通过、篡改哈希拒绝、schema 非法拒绝。

## 12.2 数据库不变量与升级探针（临时库，测后删除）

不变量（含 0.1 的 R6/F 系列共 16 项全部 PASS）：

```
F1-0 INSERT 即 APPROVED 自动冻结
F1-1 同次 UPDATE 改状态为 SUPERSEDED 并改语义 — 已拒绝
F1-2 状态已变（SUPERSEDED）后再改语义 — 已拒绝
F1-3 退回 DRAFT 后再改语义 — 已拒绝
F1-4 显式解除冻结标志 — 已拒绝
F1-5 用例：同次 UPDATE 改状态并改 title — 已拒绝
F1-6 用例工作流字段单独更新仍被允许
F4-1 TestCaseVersion.projectId 与父 TestCase 不一致 — 已拒绝
F4-2 同项目 case→version→attempt 合法链路成功
```

非空旧库升级探针（迁移 1+2 的库 + 存量数据 + F4 越界脏数据）：

```
M3 单事务对脏数据：exit=3，violates foreign key constraint
  "TestCaseVersion_caseId_projectId_fkey"；semanticFrozen 列未出现（整体回滚）
回填 UPDATE projectId 对齐父用例后 M3：成功
旧 APPROVED 规则 rv1：semanticFrozen=true（回填生效）
升级后 UPDATE expectation：IMMUTABLE_SEMANTIC_FIELDS 拒绝
```

## 12.3 未执行项

- Kimi/Moonshot 模型业务接入（阶段 2）：本轮只确认 .env 配置形态，
  未由本会话发起任何模型调用，未验证工具调用往返。
- 迁移 3 未在真正含生产规模数据的库上演练（仅探针库演示回填路径）。


---

# 阶段 1 验证记录（真实浏览器执行闭环）

日期：2026-09-17 · harness：tools/phase1-acceptance/run.mjs（16 轮迭代后全绿）

## 13. 回归与单元

```
$ pnpm test:contracts           # 81/81（新增 goto.pathTemplate 6 项）
$ pnpm --filter @ai-qa/api test # 13/13
$ pnpm test:runtime             # 10/10（真实 Chromium：七动作/越界拦截/AUTH/
                                 #   取消/预算/写不确定/登录页启发式）
$ pnpm --filter @ai-qa/evaluation --filter @ai-qa/artifact-store test  # 14/14、4/4
$ pnpm test:golden              # healthy/B1/B2/B3/B4 全 PASS（10 项，demo 扩展兼容）
$ pnpm typecheck                # 0 错误
```

## 14. 集成验收（53/53，经平台 API/队列/worker/真实页面）

运行方式：`pnpm test:phase1`（自动起 6 个 demo 实例与 api/worker/web，
场景覆盖验收矩阵全表；结果存 tools/phase1-acceptance/last-run.json）。

| 场景组 | 结果 |
|---|---|
| 健康（5000.01 全流程 / 边界 5000.00 / 持久化） | 3 用例 PASS、运行 FINISHED、严格验收 PASS、执行率/通过率 100.0%、expected/actual 真实值、PNG 证据 200、trace RESTRICTED_RAW、buildVerified=true |
| 版本未验证 | 无 buildId 运行：用例 PASS 但严格验收 INCOMPLETE、buildVerified=false |
| B1 / B3 / B4 | 对应断言 FAIL/BUSINESS_MISMATCH；B1 actual=待审批、B3 actual=已审批/待办 0、B4 orders-count=0；运行严格验收 FAIL/INCOMPLETE |
| 错误账号 | BLOCKED/AUTH；4/4 断言 NOT_EVALUATED；INCOMPLETE |
| 幂等/重复投递 | 同键同请求返回原 run（200 existed）；同键异体 409；命名空间订单峰值 1（一次因窗口错过以平台断言 a-orders-count=1 佐证，见 harness 注记） |
| 篡改计划 | DB 直改计划 expected → 创建运行 422（哈希不符）；恢复后 202 |
| URL 越界 | 前缀拼接域名登记 422（userinfo/端口在既有 13 项单测覆盖） |
| 证据异常 | 删除证据文件 → PASS 用例降级 REVIEW + evidenceDowngraded；下载 404；跨项目用户 403/404；VIEWER 对 trace 403、管理员 200 |
| 权限/空集合 | VIEWER 启动 403；caseVersionIds=[] → 422 |
| 取消 | 两次取消均 200（幂等）；终态 CANCELLED；取消中用例不 PASS；严格验收 INCOMPLETE |
| WRITE 中断 | 提交落库后响应挂起 → BLOCKED/UNCERTAIN_SIDE_EFFECT；命名空间峰值 1（无重复订单）；INCOMPLETE |
| 隔离 | 三个 attempt 命名空间互不相同；两运行数据互不影响（各自 ns 计数断言=1） |
| SSE | 单连接 seq 有序无重复且从 1 连续；Last-Event-ID 续传不回吐旧事件 |
| 真实页面 | 登录 → 选环境/用例启动 → SSE 终态 → 刷新恢复 → 报告截图 naturalWidth>0（截图见 docs/evidence/phase1-ui-report.png） |

过程修复（全部有 harness 复现记录）：观察时机依赖页面状态（submit-button 仅
DRAFT 渲染）；APPROVED 冻结行不可回填哈希（改为先算后建）；固定资产 ID 跨项目
冲突（项目前缀）；终态 FINALIZING 覆盖 CANCEL_REQUESTED（先读库再迁移）；
环境下拉按 createdAt 倒序导致 harness 选错环境（按值选择）；WRITE 点击超时
分类为 UNCERTAIN（前置可见性检查后超时=导航挂起）。

## 15. 阶段 1 未执行项

- compose 容器化 api/web 未在本环境验证（无 registry；本地三进程路径已验证，
  compose 定义已同步 worker 凭据注入与共享 artifacts 卷）。
- worker 租约超时 → ERROR 的对账路径为代码审查 + 单元语义验证，未在集成中
  杀进程注入（注入成本高；取消/幂等路径已覆盖并发写入安全）。
- 断言失败后的自动重试（attemptNo>1）未实现（阶段 4：unstable 语义）。
