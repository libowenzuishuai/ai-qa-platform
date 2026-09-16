# packages/test-runtime（占位）

TestPlan 执行运行时（PRD FR-05/FR-06/FR-07）：JSON/Schema 校验后执行；
Playwright 管理会话与程序化断言；每角色独立 BrowserContext；每 attempt 独立
namespace 与数据隔离；Midscene 视觉适配器复用当前 page。

计划校验契约已在本阶段交付：packages/contracts 的 TestPlanV1 与
validatePlanForExecutor。本目录阶段 1 实现执行器。
