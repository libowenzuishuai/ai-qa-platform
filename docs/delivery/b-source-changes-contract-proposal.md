# B2 `source_changes` 契约提案（供 A 合入前评审）

日期：2026-09-20 · 实现：`aiqa_intelligence.source_changes.compare_bundles`（纯 Python，未改 `generated.py`）  
C3 适配定稿（三个待确认）：见 [b2-c3-source-changes-adaptation.md](./b2-c3-source-changes-adaptation.md)。

## 用途

同一逻辑路径 `path` 下，对比两个 `ParsedDocumentBundle`（不同 `documentVersionId`），只回答**来源片段**增删改与无法唯一对齐项，不推断业务规则影响。

## 建议 HTTP/作业形状（可选，后续）

```json
{
  "path": "requirements/prd.md",
  "oldDocumentVersionId": "dv-old",
  "newDocumentVersionId": "dv-new",
  "format": "MARKDOWN",
  "changes": [
    {
      "kind": "modified",
      "path": "requirements/prd.md",
      "old": { "spanId": "...", "documentVersionId": "...", "locator": {}, "quotedText": "...", "extractionQuality": "GOOD" },
      "new": { "spanId": "...", "documentVersionId": "...", "locator": {}, "quotedText": "...", "extractionQuality": "GOOD" },
      "reason": null
    }
  ]
}
```

`kind`：`added` | `removed` | `modified` | `uncertain`。`uncertain` 时必须带 `reason`（例如重复原文、坐标变化）。

## 对齐规则（已实现）

1. 相同 `locator` + 相同 `quotedText` → 无变更项。
2. 相同 `locator`、不同 `quotedText` → `modified`。
3. 旧版原文在新版中唯一出现但 `locator` 不同 → `uncertain`（可能移动）。
4. 旧版原文在新版多处相同 → `uncertain`（无法唯一对应）。
5. 其余未匹配旧 span → `removed`；未匹配新 span → `added`。

Markdown 插入行导致行号漂移时，通常表现为 removed/added 组合，不假装行号仍稳定。

## A 侧待决

- 是否新增独立 Job 类型或挂在资料更新快照 API 上。
- `changes` 是否持久化及如何关联 RuleVersion / TestCaseVersion（C3 / A 接线）。
- 是否需要 TS 与 Python 共享 JSON Schema（可自本提案导出）。
