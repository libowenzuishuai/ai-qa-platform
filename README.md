<div align="center">
  <a href="docs/product/v2.0/PRD.md"><img src="docs/brand/hero.svg" width="100%" alt="AI QA — Ship with proof. 需求、执行与证据驱动的软件验收平台" /></a>

  <h3>让每次交付，都有可核对的证据。</h3>
  <p>从 PRD 到规则、用例、真实执行与缺陷复测。<br/>为多人协作、频繁合并和 AI 编码团队建立独立的业务验收。</p>

  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
  <p>
    <a href="deploy/README.md"><img src="https://img.shields.io/badge/Deploy-Self--hosted-172b35?style=flat-square&amp;labelColor=0d2028&amp;color=157a6e" alt="支持自托管部署" /></a>
    <a href="docs/delivery/v1-code-completion-20260922.md"><img src="https://img.shields.io/badge/Status-1.0_code_candidate-172b35?style=flat-square&amp;labelColor=0d2028&amp;color=7db59e" alt="1.0 代码候选版" /></a>
    <a href="docs/product/v2.0/PRD.md"><img src="https://img.shields.io/badge/Roadmap-2.0_PRD-172b35?style=flat-square&amp;labelColor=0d2028&amp;color=6d77d0" alt="2.0 产品设计，尚未实现" /></a>
    <a href="https://github.com/libowenzuishuai/ai-qa-platform/actions/workflows/intelligence.yml"><img src="https://github.com/libowenzuishuai/ai-qa-platform/actions/workflows/intelligence.yml/badge.svg" alt="共享契约和 Python CI 状态，不代表完整产品验收" /></a>
  </p>
  <p><a href="#快速开始"><strong>开始使用</strong></a> · <a href="#产品一瞥">产品一瞥</a> · <a href="docs/delivery/v1-code-completion-20260922.md">验收证据</a> · <a href="docs/product/v2.0/PRD.md">PRD 2.0</a> · <a href="CONTRIBUTING.md">参与共建</a></p>
</div>

---

## 为什么做 AI QA？

**代码可以更快写完，业务仍然需要被独立验证。**

开发者的单元测试、AI 写出来的测试、漂亮的页面，都不能单独回答：“合并之后，产品是否仍按业务要求工作？”

AI QA 把验收依据和实际执行连接起来：**这条用例从哪里来、在哪个版本运行、实际发生了什么、修复后是否仍满足原来的标准。**

<table>
<tr>
<td width="33%"><h3>01 · 有依据</h3><p>从版本化资料形成规则和用例。冲突、缺失和模型推断保持可见，批准后再作为标准。</p></td>
<td width="33%"><h3>02 · 有执行</h3><p>通过真实浏览器、API 和隔离运行器执行检查。账号、数据、预算和失败恢复进入流程。</p></td>
<td width="33%"><h3>03 · 有证据</h3><p>断言关联截图与轨迹，缺陷按原标准复测。发布决定与测试结论分别留档。</p></td>
</tr>
</table>

<img src="docs/brand/workflow.svg" width="100%" alt="资料 → 批准规则 → 用例 → 真实执行 → 证据 → 原标准复测" />

> **当前定位：可用于有人指导的试点。** 1.0 是代码候选版，尚未证明可以通用地替代测试人员。2.0 的自主测试循环、开放 Harness 和动态操作适应属于规划。功能代码、真实组件验证、真实业务效果分开记录。

## 产品一瞥

以下为真实应用页面截图，来自隔离验收环境，展示空状态及表单；不代表客户数据、已完成任务或未来 2.0 界面。

<a href="docs/delivery/evidence/v1-release-desktop.png"><img src="docs/delivery/evidence/v1-release-desktop.png" width="100%" alt="发布评审实际页面：运行证据、发布决定与历史记录" /></a>

<p align="center"><a href="docs/delivery/evidence/v1-release-mobile.png">查看手机页面</a> · <a href="docs/delivery/evidence/change-review-desktop.png">查看需求变更复核</a> · <a href="docs/delivery/evidence/p0-workflows.png">查看持久化工作流</a></p>

## 今天可以用什么？

| 能力 | 当前支持 | 边界 |
|---|---|---|
| 资料与版本 | Markdown / DOCX / PDF / 图片、多文件差异、长文档分块与恢复 | 解析质量和未覆盖范围显式标记 |
| 规则与用例 | 基于来源生成建议，审阅批准，固定版本 | 完整性与业务正确性仍需审阅 |
| 业务验收 | 浏览器七类动作、角色隔离、HTTP API、截图与轨迹 | 执行批准计划，尚非通用自主探索 |
| 准备与编排 | 登录检查、HTTP 数据插件、11 类内置能力组合、人工门与恢复 | 开放插件、MCP 和动态循环属于 2.0 |
| 工程检查 | Node test / pytest / Vitest / Jest / Playwright / lint / typecheck / build，LCOV | 运行已有测试；业务验收与工程健康分列 |
| 临时部署 | Node HTTP + 可选独立 PostgreSQL，健康与清理记录 | 不自动部署任意技术栈 |
| 缺陷与发布 | 负责人、分级依据、原标准复测、JSON/Markdown、证据保留 | 接受风险不会把 FAIL 改成 PASS |
| GitHub | 公共仓库固定提交；App、Webhook、Checks 实现 | 真实 App 安装与回传仍待验收 |

### 我们如何证明“能用”

**2026-09-22 的固定代码验收记录：**561 项 TypeScript、374 项 Python、34 项运行器检查及 6 项公开 GitHub 整链检查通过。默认跳过与真实模型未验项目单独披露。最终镜像完成空库初始化、升级、数据库与证据恢复、真实 Chromium 新运行。

这些数字是平台测试记录，**不是缺陷检出率，也不是客户成功率**。查看 [可复核报告](docs/delivery/v1-code-completion-20260922.md) · [镜像与日志哈希](docs/delivery/evidence/v1-local-release-20260922.json)。本轮执行源码为 `214b89c`，日期与范围固定，不把历史测试数字当作当前 CI 状态。

## 快速开始

需要 Docker Engine / Docker Desktop 或 Colima，以及 Docker Compose。首次构建需要联网。

```bash
git clone https://github.com/libowenzuishuai/ai-qa-platform.git
cd ai-qa-platform
cp -n deploy/.env.production.example deploy/.env.production
```

在 `deploy/.env.production` 填写数据库用户名/名称/随机密码、`SESSION_SECRET`、`AIQA_INTELLIGENCE_TOKEN` 和初始管理员账号。需要模型能力时填写 `AIQA_TEXT_*` / `AIQA_VISION_*`。然后：

```bash
docker compose -p aiqa-prod \
  -f deploy/compose.production.yaml \
  --env-file deploy/.env.production \
  up -d --build --wait --wait-timeout 180
```

打开 **http://127.0.0.1:7100**，使用配置的初始管理员登录。迁移与初始化自动执行。模型未配置时仍可浏览平台和使用已批准资产，需要模型的操作会明确提示缺配置。

**第一次体验：**创建项目 → 接入测试网址/仓库与资料 → 准备角色账号 → 审阅规则和用例 → 批准计划 → 执行并看证据。首次接入需要配置，当前不承诺“一键测任意项目”。

[完整部署说明](deploy/README.md) · [本地开发](docs/DEVELOPMENT.md) · [独立工程运行器](tools/self-hosted-runner/README.md) · [试点资料与三构建评测](tools/pilot-acceptance/README.md)

## 2.0：从受控验收到自主测试

我们下一步要解决的是：**面对陌生项目，能理解依据、持续观察、调整操作、发现缺陷，并证明没有为了通过而改掉标准。**

| 2.0 方向 · 尚未实现 | 可验证的交付 |
|---|---|
| 开放 Harness | 安装新适配器无需修改核心调度；重复节点、子流程、有限循环可组合 |
| 自主测试循环 | 观察 → 规划 → 行动 → 校验 → 调整；每一步有预算和可恢复状态 |
| DOM + 视觉执行 | 应对动态页面、弹窗、上传下载、iframe 与视觉控件 |
| 代码与缺陷调查 | 从依据生成候选测试，隔离运行，关联日志/网络/代码变化和复现 |
| 多模型决策 | 生成、视觉、分类分工；Jev 作为可选决策组件，先测再接 |
| 效果基准 | 发布缺陷检出率、误报率、人工介入和成本；保留首败与未完成任务 |

**[阅读完整 PRD 2.0 →](docs/product/v2.0/PRD.md)** · [Harness 设计](docs/product/v2.0/HARNESS-SPEC.md) · [评测与发布门](docs/product/v2.0/EVALUATION.md) · [实施路线](docs/product/v2.0/ROADMAP.md)

## 参与共建

欢迎带着一个可授权测试的 Web 项目、一份明确的业务资料，或一个能复现的失败场景来共建。我们尤其需要：

- 真实业务与隐蔽缺陷样例，用于衡量是否真的省下测试时间。
- 浏览器/视觉/接口执行适配器，以及跨项目的可靠性反例。
- 对“为什么这条结论可信”的产品反馈和文档改进。

[提交可复现问题](https://github.com/libowenzuishuai/ai-qa-platform/issues/new?template=bug_report.yml) · [提出功能建议](https://github.com/libowenzuishuai/ai-qa-platform/issues/new?template=feature_request.yml) · [贡献指南](CONTRIBUTING.md)

如果这个方向对你有价值，欢迎 Star / Watch，持续关注真实能力与评测结果。

<details>
<summary><strong>架构与阅读入口</strong></summary>

```text
TypeScript 平台     API / Web / Worker / 审批 / 执行 / 证据 / 生命周期
Python 智能服务     文档解析 / 规则与用例建议 / 计划建议 / 模型调用
隔离运行器          固定提交 / 已有测试 / 受支持部署 / 资源清理
基础设施            PostgreSQL / Redis / 文件证据存储 / Chromium
```

[实现状态](docs/implementation-status.md) · [1.0 PRD](docs/product/v1.0/PRD.md) · [2.0 产品与架构](docs/product/v2.0/PRD.md) · [模型服务](services/intelligence/README.md)

</details>

### 许可证

当前仓库尚未声明项目级开源许可证。源码公开不等于已授予完整开源授权；许可证由项目权利人确认后补充。依赖保留各自许可证。
