> 2026-09-21：此提案已由 [A 合入裁决](../bc-integration-decision.md) 取代，最终字段以共享契约为准。

# 提案：C3 需求变更影响分析的最小接口（C → A/B，待评审）

日期：2026-09-20 · 提案人：李琦双（C）· 状态：草案，未实现共享契约变更

依据：`docs/delivery/next-sprint-three-person-plan.md` §5 C3 与 §6 共享接口纪律。
本提案只描述形状与口径，不动 `packages/contracts`、不手改生成文件；
B2 未交付前 C3 以本形状做纯模块与合成夹具开发。

## 1. 职责边界（重申，防止越界）

- **B2** 只回答「来源哪里变了」：同一路径两个文档版本的新增/删除/修改片段，
  保留新旧版本与片段引用；移动/合并等无法唯一对应时给「待确认」。
- **C3**（本模块）回答「影响哪些规则/用例」：消费 B2 输出 + 已批准资产，
  产出建议与理由；**不自行更新批准版本、不缩小正式基线**。
- **A** 按真实版本 ID 关联受影响资产、挂待复核入口、控制批准。

## 2. 输入（C3 模块入口）

```jsonc
{
  "sourceChanges": [ /* B2 输出，形状待 B/A 定稿，先按下列最小要求约束 */ ],
  "approvedRuleVersions": [ /* 现有 RuleVersion 实体，含 sources[].sourceSpanIds */ ],
  "approvedCaseVersions": [ /* 现有 TestCaseVersion 实体 */ ],
  "promptVersion": "impact-v1"
}
```

对 B2 输出的**最小要求**（差异形状本身由 B 定，C 只依赖这三点）：

1. 每条变化携带 `kind`（added / removed / modified / ambiguous）；
2. 每条变化携带新旧两侧的 `(documentVersionId, spanId)` 引用（缺失侧为空）；
3. `ambiguous` 表示 B 无法唯一对应（移动/拆分/合并），C3 必须按待复核处理，
   不得当作未变化。

## 3. 输出（C3 模块出口，暂为 agents 内部形状）

```jsonc
{
  "affectedRules": [
    {
      "ruleVersionId": "…",
      "reason": "SOURCE_REMOVED | SOURCE_MODIFIED | SOURCE_AMBIGUOUS",
      "evidenceRefs": [ { "documentVersionId": "…", "spanId": "…" } ],
      "suggestion": "复核该规则的出处是否仍然成立"
    }
  ],
  "affectedCases": [
    { "caseVersionId": "…", "viaRuleVersionIds": ["…"], "reason": "…", "suggestion": "…" }
  ],
  "unresolved": [ "跨块冲突/条件在变更后无法判定，列明待人工复核" ],
  "requiresHumanReview": true
}
```

口径：

- 规则受影响的判定 = 其 `sources[].sourceSpanIds` 与变化片段有交集；
  交集为空的规则**不得**出现在建议里（不许顺带扩大复核面）；
- 用例受影响只经规则传导（`ruleVersionIds`），不直接关联片段；
- `requiresHumanReview` 恒为 `true` 是语义约束：本模块只建议，不批准；
- 变更后跨块/跨段冲突与覆盖问题进入 `unresolved`，不静默。

## 4. 升级为共享契约时需要 A 做的事

若平台要经 HTTP 暴露影响分析（如 `POST /v1/impact/analyze`）：

1. 在 `intelligence.ts`/Zod 侧新增 `ImpactAnalysisInput/Output` 定义与
   正反例（反例至少含：规则无交集却出现在建议中、ambiguous 被当作
   modified、未引用真实 span）；
2. 走 `contracts:export` / `contracts:python` 再生成；
3. C3 模块换用生成类型（同现有管线纪律，不手写同名 DTO）。

## 5. 评测挂钩

C3 的重复运行评测复用 `agents/evaluation.py` 口径：每旅程 ≥3 次、
保留首次失败、语义错误与阻塞分列；变更影响建议的正确性以
「受影响集合恰好等于交集闭包」为可判定标准，不用模型自评。

## 6. 待 B/A 确认的三个问题

1. B2 差异输出的最终 JSON 形状（C3 按 §2 最小要求先行，形状落定后对齐）；
2. 变化条目是否携带片段 `extractionQuality`（C3 倾向携带：
   LOW/UNPARSED 的变化应直接进 unresolved 而非给确定性 reason）；
3. `ambiguous` 的表示法（枚举值 vs 单独字段），与 B2 的「待确认」对齐。
