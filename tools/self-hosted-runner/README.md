# 自有运行器

运行器仅领取所属项目的工程检查任务。业务验收依然使用批准规则与 TestPlan；代码测试通过不能证明业务需求正确。

## 启动

1. 管理员在项目注册运行器（`POST /api/projects/:id/runners`），保存仅返回一次的 token。可随时撤销。
2. 运行器主机安装 Python 3.11+ 与 Docker。平台 API、数据库与模型服务不需要 Docker socket。
3. 准备本地镜像：Node 22；Python 镜像应含 pytest（可用本目录 Dockerfile.python 构建）。任务不能指定任意镜像。
4. 设置 `AIQA_PLATFORM_URL`（HTTPS 或本地环回）、`AIQA_RUNNER_TOKEN`。可选 `AIQA_RUNNER_NODE_IMAGE`、`AIQA_RUNNER_PYTHON_IMAGE` 应使用管理员审核的镜像或 digest。
5. `python3 tools/self-hosted-runner/runner.py`。`--once` 仅轮询一次。

## 当前兼容范围

- 公共 GitHub 仓库，固定完整 commit SHA；有界下载并拒绝路径穿越、链接和设备文件。
- NODE_TEST：Node 内置 test runner → JUnit；PYTHON_TEST：pytest → JUnit。
- NODE_BUILD：`npm run build`。未配置 build 脚本即失败，不把退出 0 以外的结果改写成功。
- 可选依赖准备：Node 要求 package-lock.json，npm ci 禁用生命周期脚本；Python requirements.txt。依赖安装在独立受限容器中联网，实际测试与构建断网。私有依赖、安装脚本、复杂多服务项目需后续模板，不宣称支持。
- 每任务临时卷、只读根目录、无宿主挂载/平台凭据/socket、资源/时间限制；结束清理。服务端租约阻止重复执行结果、跨项目提交和终态覆盖。
- 运行器是管理员信任的执行主体；不是对恶意管理员或被攻陷主机的远程证明。

测试：`AIQA_TEST_DOCKER=1 AIQA_RUNNER_PYTHON_IMAGE=<本地含pytest镜像> services/intelligence/.venv/bin/python -m pytest tools/self-hosted-runner/tests`。

## 公共仓库整链复验

`apps/worker/test/runner-e2e.test.ts` 默认跳过；显式设置 `REAL_RUNNER_EVAL=1`、`AIQA_RUNNER_FIXTURE_SHA` 为已上传的完整夹具提交后，运行 `pnpm --filter @ai-qa/worker exec vitest run test/runner-e2e.test.ts`。还需本机测试 PostgreSQL、Docker 与上述已审核镜像。它启动临时 API，通过实际 runner CLI 从公共 Git 下载，然后检查平台终态与证据校验和；测试库与服务在结束时清理。

本轮夹具提交为 `5713c1deec65ae352b119f0aa1ba9f8d610b726b`，包括 Node/pytest 成功及失败样例，属于合成评测数据。证据输出到忽略提交的 `data/pilot-evidence/runner-e2e.json`。

若 Python 的 HTTPS 请求报可信证书缺失，为运行器配置正确的系统/组织 CA，例如本机 macOS 可用 `SSL_CERT_FILE=/etc/ssl/cert.pem`（先确认文件存在）。不得关闭证书校验。初次失败和后续复验分别记录，不把环境错误视为业务失败。

下载和执行期间持续续租；心跳拒绝或失败停止后续业务命令。结果提交失败不重新执行业务命令，平台按租约和预算对账。清理失败会产生 `platformError`，需要管理员检查本任务资源；不自动扩大删除范围。

## 1.0：框架适配与隔离部署

支持 Node 内置测试、Vitest、Jest、Playwright、ESLint、TypeScript、npm build 和 pytest。框架工具必须已在项目锁文件中固定；报告矛盾、零测试及格式错误均不会成为 PASS。

Node HTTP 部署检查新增 `NODE_HTTP`：选择固定 JavaScript 入口、是否执行已声明的 npm build、端口、健康路径及可选独立 PostgreSQL。它创建临时实例，记录提交版本、实际入口文件 SHA-256、HTTP 200 和资源清理台账。任务结束销毁实例；业务验收仍使用项目已登记的测试网址。本模板不宣称支持任意语言、多服务编排或持久托管。

运行器需 Docker 28+（隔离网关支持），本地准备 Node 镜像及可选 `postgres:16-alpine`。管理员可用 `AIQA_RUNNER_POSTGRES_IMAGE` 指定兼容镜像；数据库容器以 UID 70 运行，镜像应与之兼容。任务使用新建数据库、随机临时口令，无宿主端口、平台账号或既有业务库。

启用依赖安装前，管理员构建固定注册表代理：

```sh
docker build -t aiqa-registry-proxy:1 -f tools/self-hosted-runner/Dockerfile.registry-proxy tools/self-hosted-runner
```

生产使用审核过的镜像 digest，通过 `AIQA_RUNNER_REGISTRY_PROXY_IMAGE` 配置。安装容器只连接任务内部的 isolated 网络，经代理访问 npm/PyPI 官方 HTTPS 注册表；代理拒绝其他目的地址，npm 生命周期脚本禁用。实际测试、构建和 HTTP 服务不接公网。未准备镜像会明确报错，不自动退回不受限网络。支持范围依据 [Docker isolated 网关说明](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)。

实测命令同上：本轮 23 项通过，包含真实 Docker 的八类适配、Node HTTP、构建、独立数据库、健康超时、取消和清理。全部为合成工程夹具，不代替真实项目验收。
