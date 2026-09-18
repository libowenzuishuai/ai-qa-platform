# packages/model-adapters（阶段 2 · A 通道 · 李博闻）

模型适配器：moonshot（Kimi，OpenAI 兼容）真实适配器 + 显式 mock 确定性替身。
契约：`@ai-qa/contracts` 的 `model-adapter.ts`（已冻结）。

## 结构

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 双通道环境配置（AIQA_TEXT_* / AIQA_VISION_*）；real 缺配置 → `MODEL_NOT_CONFIGURED`，绝不降级 mock |
| `src/moonshot-adapter.ts` | OpenAI 兼容 chat/completions：schema 提示词内嵌（`jsonSchemaInput=false`）+ `response_format=json_object`；超时 AbortSignal；4xx→MODEL_NOT_CONFIGURED 语义、5xx→DEPENDENCY_UNAVAILABLE；usage/requestId 零转换落库 |
| `src/mock-adapter.ts` | 确定性协议：`purpose+sha256(system+user+extra)` 查 `mock-table/entries.json`；miss 即抛（禁止现编） |
| `src/repairs.ts` | 有限格式修复（闭集 4 种、≤2 次、可观察） |
| `src/schema.ts` | outputSchema 编译与校验（ajv） |
| `src/factory.ts` | 按通道配置构造适配器 |

## 用法

```ts
import { loadModelEnvConfig, createTextAdapter } from "@ai-qa/model-adapters";

const config = loadModelEnvConfig();          // real 缺配置在此抛错
const adapter = createTextAdapter(config.text);
const response = await adapter.completeText({
  purpose: "RULE_EXTRACTION",
  system: "你是独立测试分析员…",
  user: promptBody,
  outputSchema: ruleExtractionJsonSchema,
  timeoutMs: 60_000,
});
// response.parsedJson 已过 schema 校验；usage/requestId 直接写 ModelInvocation
```

## 测试与验收

- `pnpm --filter @ai-qa/model-adapters test`（23 项，fetch stub，零网络零密钥）
- `pnpm --filter @ai-qa/model-adapters smoke:real`（真实 moonshot 冒烟；未配置
  凭据时输出 SKIP，不冒充通过）
- mock 注册：`pnpm --filter @ai-qa/model-adapters mock:register <input.json>`
  （李琦双为 fixture 场景注册 golden 响应用）

## 纪律

- 凭据只在请求头注入；不进日志、异常、响应与 Git。
- mock 输出必须 `provider:"mock"`，消费方据此标记 simulated 并从 real 指标排除。
