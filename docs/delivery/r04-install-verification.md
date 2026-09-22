# 当前最终安装验收

2026-09-22：最终代码已完成四类镜像、空库初始化、旧版真实 Run 与证据升级恢复、六服务健康和新 worker 实际 Chromium 运行。详见 [1.0 完成评审](v1-code-completion-20260922.md) 与 [镜像/备份/日志哈希](evidence/v1-local-release-20260922.json)。早期“空 Run 升级”与“未执行容器浏览器”限制已由最终复验覆盖。registry 分发和其他架构仍未验证。

以下为历史初版过程，不能替代最终记录。

# R04 可安装交付验收记录

日期：2026-09-22 · 分支：`v1/release-completion`

## 环境

- OS：macOS (Darwin 25.0.0, Apple Silicon aarch64)
- Docker：colima VM (aarch64, 4 CPU / 8 GiB) · Server 29.5.2
- 网络：Docker Hub 直连被阻断；经 daocloud 镜像（`docker.m.daocloud.io`）拉取基础镜像
- 故障与修复：colima VM 内 `systemd-resolved` 失效导致 `/etc/resolv.conf` 悬空、全部 DNS 失败；
  写入静态 resolv.conf（宿主 DNS 10.1.6.192 / 223.5.5.5）修复，未重启 VM、未影响运行中容器

## 交付物

| 文件 | 内容 |
|---|---|
| `apps/api/Dockerfile` | 生产镜像：frozen lockfile 安装、构建期 prisma generate + tsc 构建、运行时零安装 |
| `apps/worker/Dockerfile` | 同上 + Playwright 官方运行时基镜像（浏览器依赖/字体内置）；**不含 tests-golden** |
| `apps/web/Dockerfile` | 最小 SSR 镜像，新增 `/healthz` |
| `apps/demo-app/Dockerfile.prod` | demo 独立镜像（仅 profile 启用） |
| `deploy/compose.production.yaml` | 独立 compose project；migrate/seed 单次容器；全服务健康检查；持久卷；无默认凭据（缺变量即报错） |
| `deploy/.env.production.example` | 只含名字与说明 |

配套修复（构建过程发现的真实缺陷）：
- `pnpm --filter @ai-qa/worker build` 因跨引用 `../../api/src` 破坏 rootDir 而损坏 →
  worker tsconfig.build 移除 rootDir 并纳入 api/src（产物 `dist/worker/src/server.js`）
- api 新增 tsc 构建（`tsconfig.build.json` + `build`/`start:dist` 脚本）
- workspace 包 exports 指向 src（tsx 语义）：生产镜像 `node --import tsx` 启动；tsx 移入四端 dependencies；
  运行时镜像补拷贝各 app `package.json`（`"type":"module"`）与 api `src`（seed 依赖）
- prisma CLI 移入 api dependencies（迁移容器使用）
- compose 插值会对非激活 profile 的必需变量报错 → demo 令牌改为默认空

## 实际执行的验收（命令与结果）

compose project：`aiqa-prod-r04`（动态端口 17100/17200/17300，独立卷 pgdata-prod/artifacts-prod）

1. **空库安装 + 迁移单次容器**
   `docker compose -p aiqa-prod-r04 -f deploy/compose.production.yaml --env-file … up migrate`
   → `All migrations have been successfully applied`（13 个迁移），容器 exit 0
2. **全栈健康**
   `up -d postgres redis intelligence api web` → 5 容器全部 `(healthy)`
   （api `/api/health` 返回 `{"ok":true,"service":"api","db":"up"}`；intelligence `/health`；web `/healthz`）
3. **种子单次容器**：`up seed` → `已创建管理员 admin (cmuc1f9ch…)`，幂等（重复跑跳过）
4. **登录**：`POST /api/auth/login`（admin + 环境变量强密码）→ 200，会话 Cookie 有效（`/api/auth/me` 200）
5. **业务闭环**：创建项目 `R04 验收项目`（含审计事件）→ 创建环境 `验收环境`（origin 白名单校验通过）→ 均 200
6. **备份**：容器内 `pg_dump -Fc` → 127,947 字节
7. **恢复到新隔离库**：`createdb aiqa_restored` + `pg_restore --no-owner` →
   Project=1、Environment=1、ADMIN 用户=admin、`_prisma_migrations`=13
8. **升级路径（模拟 pre-R02 库）**：恢复库中 `DROP TABLE "SnapshotChange"` + 删除 R02 迁移记录 →
   同镜像 `prisma migrate deploy` 重新应用 R02 → 业务对象（项目/环境）仍可读，Run 表结构完好（0 行）

镜像：`aiqa-api:r04-test`（e84456c06d83 → 修复后 efef511baf11）、`aiqa-web:r04-test`（b3fe8c196314）、
`aiqa-demo:r04-test`（12ffb795c6e9）均为真实构建成功并通过健康检查的产物。

## 待跑门（如实记录）

1. ~~worker 生产镜像~~ **已关闭（2026-09-22）**：playwright 基础镜像（`mcr.microsoft.com/playwright:v1.63.0-noble`，3.48 GB）拉取完成后，
   `docker compose … up -d --build worker` 构建并启动成功，worker 容器 `Up (healthy)`（`/api/health` 通过）。
   过程中修复两个真实缺陷：worker 构建需包含 api 依赖与 prisma schema（`--filter @ai-qa/api` + COPY prisma）；
   Prisma Query Engine 的 openssl 目标在 bookworm 构建与 noble 运行镜像间不一致 → schema 显式固定
   `binaryTargets = ["native","linux-arm64-openssl-3.0.x","linux-arm64-openssl-1.1.x","debian-openssl-3.0.x"]`。
   至此生产栈 6 服务（postgres/redis/intelligence/api/web/worker）全部 healthy。
   生产 worker 内真实浏览器执行用例的端到端冒烟列入 R12 最终回归（需 demo profile 联动）。
2. **registry 推送**：本环境仅能经 daocloud 镜像源拉取；`docker push` 到自有 registry 未配置，
   镜像以本地构建产物交付。
3. 升级验证中 Run 表为空（隔离库未造 Run 数据）："升级后可读旧 Run"以结构完好 + 迁移日志一致
   佐证；带真实 Run 数据的升级复核列入 R12 最终回归。
4. demo profile（`--profile demo`）未启动验收：按设计默认不进入生产拓扑。
