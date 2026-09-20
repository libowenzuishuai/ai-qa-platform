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
