# demo-app：独立待测审批系统

与测试平台（apps/api、apps/worker 等）完全独立的演示业务系统，模拟
“Web 管理后台 + 跨角色审批流”，供平台在真实浏览器中验收。

## 业务规则（演示 PRD，PRD §12.1）

- 采购单金额单位为**分**；页面输入为元，最多两位小数。
- 金额 **> 500000 分（5000.00 元）需主管审批**，审批通过后进入付款待办。
- 金额 **<= 500000 分直接进入付款待办**。
- **禁止申请人审批**（服务端强制，非仅前端隐藏按钮）。
- 数据落 SQLite，刷新/重新登录后保持。

角色账号（演示环境专用）：

| 用户名 | 密码 | 角色 |
|---|---|---|
| applicant1 | Applicant#2026 | 申请人 |
| supervisor1 | Supervisor#2026 | 主管 |

## 启动

```bash
pnpm --filter @ai-qa/demo-app start
# 默认 http://127.0.0.1:7400
```

环境变量：`DEMO_PORT`、`DEMO_HOST`、`DEMO_DB_PATH`、`DEMO_FIXTURE_TOKEN`、
`DEMO_BUG_MODES`（见 `.env.example`）。

## 缺陷模式（仅评测器可见）

`DEMO_BUG_MODES=B1,B3` 启用缺陷；默认为空（健康版本）。缺陷开关不出现在
任何页面、API 响应或前端代码中。

| 模式 | 行为 |
|---|---|
| B1 | 阈值边界写错（`>` 误写为 `>=`）：恰好 500000 分被错误送入审批 |
| B2 | 越权审批：服务端放行申请人审批 |
| B3 | 审批后状态停在“已审批”，付款待办不更新 |
| B4 | 创建显示成功但不落库，刷新后数据丢失 |

## 评测夹具接口（令牌保护）

```bash
curl -X POST -H "x-fixture-token: $DEMO_FIXTURE_TOKEN" http://127.0.0.1:7400/api/fixtures/reset
curl -H "x-fixture-token: $DEMO_FIXTURE_TOKEN" http://127.0.0.1:7400/api/fixtures/orders
```

## 黄金验收（评测器专用）

`tests-golden/` 是评测器 ground truth：验证健康流程走通、B1–B4 缺陷确实
存在。**测试平台与运行时智能体不得读取本目录或缺陷开关。**

```bash
pnpm --filter @ai-qa/demo-app test:golden
```

首次运行前安装浏览器：`pnpm --filter @ai-qa/demo-app exec playwright install chromium`。
