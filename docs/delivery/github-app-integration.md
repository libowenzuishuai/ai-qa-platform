# GitHub App 与 CI（1.0）

## 支持范围

项目管理员连接一个自己具有管理权限、且已安装本平台 GitHub App 的仓库。授权经浏览器 OAuth state + 当前平台用户 + GitHub 用户仓库权限 + 安装身份联合核验。每次读取使用只限定该 repository ID 的短期 installation token；数据库保存安装与仓库身份，不保存 OAuth 或 installation token。

仓库资料发现使用项目内安装授权；Python 自有运行器通过平台的有效任务租约领取固定 SHA 的源码包，验证提交与 SHA256。GitHub token 不传入运行器或仓库代码。

CI 首版支持已发布的单节点工程检查模板、指定分支 push 和同仓库 PR。fork PR 留为忽略事件，不执行。不自动发布应用或把工程测试通过称为业务验收通过。

## 操作员配置

需要 `AIQA_GITHUB_APP_ID`、`AIQA_GITHUB_CLIENT_ID`、`AIQA_GITHUB_CLIENT_SECRET`、`AIQA_GITHUB_WEBHOOK_SECRET`、`AIQA_GITHUB_CALLBACK_URL`、`AIQA_GITHUB_PRIVATE_KEY_FILE`。私钥通过只读文件加载。未配置时 UI 明确显示尚未配置，其他能力继续可用。

- App callback 指向 Web 的 `/github/callback`；线上使用 HTTPS。
- Webhook 指向 API `/api/github/webhook`。
- App repository permissions：Contents read、Metadata read、Checks write。
- Subscribe：push、pull_request、installation、installation_repositories，及用户授权撤销事件。
- 先安装 App 到目标仓库，再从“GitHub 集成”页面发起连接；重新连接不会自动恢复原 CI 范围，须重新确认。
- 生产 Compose 可叠加 `deploy/compose.github.yaml`；另设 `AIQA_GITHUB_KEY_HOST_PATH` 指向宿主只读私钥文件，覆盖文件只给 API/worker 挂载，不给运行任务挂载。
- 模板使用的 runner 必须预先注册对应检查能力。勾选依赖安装前，按运行器文档配置安装网络与预置镜像。

## 故障与撤销

普通事件和控制事件都以 delivery ID + 原正文哈希去重，重放旧撤销事件不会再次撤销重新授权的连接。不同正文复用 ID 拒绝。配置变更取消旧 CI；撤销安装同时停止相关排队/在途 CI 与手动私库工程任务；执行器在心跳时停止。

Checks 写入前持久化 WRITE_UNCERTAIN。连接断开后不能断言“没有写入”；管理员显式重试时先按 external_id 对账已有 check，避免重复创建。后台失联租约变成明确失败，页面可重试。签名正文、回调 code、token 不进入常规日志。

## 已验证与外部待验

`apps/worker/test/github-integration.test.ts` 使用真实 PostgreSQL、HTTP GitHub 协议对端、签名/JWT 和平台执行链路，覆盖 state 一次性、安装范围、签名、并发重复、乱序、fork、限流、未知写入、撤销、重新授权与控制事件重放。runner 回传为协议夹具；完整容器工程执行在独立 runner 验收中记录。

尚未进行本项目真实 GitHub App 安装和真实 GitHub Checks 回传：需要操作员配置。这项不能用上述模拟对端代替，也不代表整版已经通过发布验收。

官方协议依据：[App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)、[installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、[CI checks](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-ci-checks-with-a-github-app)。
