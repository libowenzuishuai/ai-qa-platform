# v2.0 支持矩阵（W09）

更新：2026-09-28。最新修复与限制见 [接管评审](delivery/v2-takeover-20260928.md)。逐项声明支持面与验证状态；未通过兼容测试的组合标 experimental/unsupported，不用"支持 Web"概括。

## 执行面

| 面 | 支持 | 验证状态 | 备注 |
|---|---|---|---|
| 合成 HTTP 系统（Node http） | ✅ | VERIFIED（v2 会话循环/观察/交叉核验全链测试） | synthetic 显式标记 |
| 真实 Chromium 观察 | ✅ | VERIFIED（platform.web-observe@1.0.1：连接层代理/宿主证据目录/DOM testid+截图 sha256） | Playwright 固定版本 |
| 真实 Chromium 执行（写操作） | ⚠️ experimental | v2 已接批准操作目录、Python 规划、独立角色和读取判定；合成三构建通过 | W05 后续 |
| 远程 HTTP 能力 | ✅ | VERIFIED（example.data-reconcile 独立 Python 进程） | redirect 全拒+32MiB 上限 |
| Node 工程检查 | ✅（v1 继承） | VERIFIED（self-hosted-runner 19/19） | npm 锁文件；pnpm 项目 unsupported |
| Python 工程检查 | ✅（v1 继承） | VERIFIED | requirements.txt |
| 部署模板 | ✅（v1 继承） | VERIFIED（Node HTTP + 独立 PostgreSQL） | Python ASGI 模板未做 |

## 资料面

| 格式 | 支持 | 状态 |
|---|---|---|
| Markdown | ✅ | VERIFIED |
| DOCX | ✅ | VERIFIED（v1） |
| PDF（文字层） | ✅ | VERIFIED（v1，含跨页表） |
| PDF（扫描/内嵌图） | ✅（大模型视觉解析） | VERIFIED（v1 Kimi vision 小样本；语义质量未全面评测） |
| 图片 PNG/JPEG | ✅ | VERIFIED |
| OpenAPI（线索上下文） | ✅ | VERIFIED（本轮：命中选中/无关拒绝） |

## 模型面

| 角色 | 基线 | 状态 |
|---|---|---|
| Generator | moonshot（正式通道）/ mock 确定性 | 通道 VERIFIED；loop-planner 已接 |
| Vision | moonshot vision | v2 视觉动作管线与区域限制已接；本轮未调用付费视觉模型 |
| Decision | 确定性关键词基线 | VERIFIED（TS+Python 双端 8/8） |
| Jev | 未接 | 未验（缺官方协议资料/账号） |

## 部署面

| 项 | 状态 |
|---|---|
| 自托管 compose（6 服务） | VERIFIED（R04 记录：空库安装→备份→恢复→升级） |
| ARM64 Docker | VERIFIED |
| amd64 / Windows | 未验（历史 ARM64 通过不能证明当前部署已验——R3 第 6 点如实声明） |
| GitHub App CI | 代码在（v1 outbox/幂等/撤销）；**真实回传未验（EXTERNAL_BLOCKED）** |

## 未知栈快速失败

- runner：锁文件缺失/未知包管理器 → 安装阶段显式拒绝（v1 已验）。
- 能力安装：协议/Schema 自检失败 → 422（R0.7 已验）。
- 规划器：python-real 无配置 → CONFIG_MISSING（已验）；python 通道断连 → DEPENDENCY_UNAVAILABLE 受控失败（已验）。

## 2026-09-28 集成增量

- 通用确定性工具图：已从页面接入 Profile/定义发布和持久会话，支持版本固定、受限子流程、未知写入暂停、构建漂移拦截。
- MCP：Streamable HTTP 2025-06-18，JSON/SSE 输出、固定单工具 Schema 与显式授权；无 OAuth/stdio/旧 SSE。
- 候选代码测试：Node/Python 基础函数模板；批准规则 + 人工审核样例；真实 Docker 健康/缺陷/修复对照，下载新增补丁。
- 通用自主浏览器写循环、模型/记忆策略自由组装、自动根因最小化仍未完成。
- 本轮镜像/安装/升级验收按 [最新机器记录](delivery/evidence/v2-integrated-verification.json) 判定，历史 1.0 通过不自动覆盖新版本。

详细入口、版本和限制：[集成交付记录](delivery/v2-integrated-delivery-20260928.md)。

## 网站自主增量（2026-09-28）

当前能力、实测边界、UI 入口和未完成项以 [本轮交付](delivery/v2-browser-autonomy-20260928.md) 为准。通用上传/下载、MFA 实时接管、最小化复现、完整模型版本路由和真实项目效果仍未验收，不标支持。

- 浏览器原生弹窗：精确类型/文案/处理方式逐操作授权，真实 confirm 正反例通过；上传下载与 MFA 现场接管仍未完成。
- 组合演练：页面已接入零外部调用图演练，依赖工具实际输出的分支保持无法解析；不代表业务已验收。
- 效果评测：管理员页面、冻结样本、运行创建时原子登记、首次结果统计已接；真实三项目试点及费用计量仍未完成。
