# v2.0 支持矩阵（W09）

更新：2026-09-24。逐项声明支持面与验证状态；未通过兼容测试的组合标 experimental/unsupported，不用"支持 Web"概括。

## 执行面

| 面 | 支持 | 验证状态 | 备注 |
|---|---|---|---|
| 合成 HTTP 系统（Node http） | ✅ | VERIFIED（v2 会话循环/观察/交叉核验全链测试） | synthetic 显式标记 |
| 真实 Chromium 观察 | ✅ | VERIFIED（platform.web-observe：DOM testid+截图 sha256） | Playwright 固定版本 |
| 真实 Chromium 执行（写操作） | ⚠️ experimental | 复用 v1 executor（test-runtime）；v2 循环尚未接写型浏览器动作 | W05 后续 |
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
| PDF（扫描/内嵌图） | ✅（OCR 通道） | VERIFIED（v1 Kimi vision 小样本；语义质量未全面评测） |
| 图片 PNG/JPEG | ✅ | VERIFIED |
| OpenAPI（线索上下文） | ✅ | VERIFIED（本轮：命中选中/无关拒绝） |

## 模型面

| 角色 | 基线 | 状态 |
|---|---|---|
| Generator | moonshot（正式通道）/ mock 确定性 | 通道 VERIFIED；loop-planner 已接 |
| Vision | moonshot vision | v1 验证；v2 未接视觉动作 |
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
