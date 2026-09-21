# B2 → C3 来源对比形状定稿（三个待确认）

日期：2026-09-21 · 提交方：B / 原泽菲 · 分支：`v1/document-fidelity`  
受众：C / 影响分析（`adapt_source_changes`）、A / 共享契约评审  
实现：`aiqa_intelligence.source_changes.compare_bundles` · 提案总览见 [b-source-changes-contract-proposal.md](./b-source-changes-contract-proposal.md)

## 背景

C3 影响分析依赖 B2 输出的「同一路径两版资料」片段差异 JSON。在 A 将形状写入 `packages/contracts` / `generated.py` 之前，**以本仓库 Python 实现为准**；字段名若被 A 微调，B 只改 `compare.py` 映射与测试，C 只改 `adapt_source_changes` 一处。

§六：B 未改共享生成文件；HTTP/Job/持久化由 A 决定。

---

## 待确认（1）差异 JSON 形状

### 入口

```python
from aiqa_intelligence.source_changes import compare_bundles

report = compare_bundles(path: str, old_bundle: dict, new_bundle: dict) -> dict
```

- `old_bundle` / `new_bundle`：`ParsedDocumentBundle` 同形 dict（parse 的 `model_dump(mode="json")` 即可）。
- **前置**：`old_bundle["format"] == new_bundle["format"]`，否则 `ValueError("format mismatch between document versions")`。
- **输入 span 字段**：至少使用 `id`、`documentVersionId`、`locator`、`quotedText`（可 null）、`extractionQuality`。

### 返回值顶层

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | string | 逻辑文档路径，与入参一致 |
| `oldDocumentVersionId` | string | 来自 `old_bundle["documentVersionId"]` |
| `newDocumentVersionId` | string | 来自 `new_bundle["documentVersionId"]` |
| `format` | string | 如 `MARKDOWN`、`DOCX`、`PDF_TEXT` |
| `changes` | array | 变更项列表，见下 |

### `changes[]` 每条

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | enum | `added` \| `removed` \| `modified` \| `uncertain` |
| `path` | string | 与顶层 `path` 相同 |
| `old` | span 视图 \| null | 见下 |
| `new` | span 视图 \| null | 见下 |
| `reason` | string \| null | `uncertain` 时**必填**；其余 kind 为 `null` |

### span 视图（compare 输出的稳定子集）

bundle 内 span 的 `id` 在输出中命名为 **`spanId`**：

```json
{
  "spanId": "<span.id>",
  "documentVersionId": "<span.documentVersionId>",
  "locator": {},
  "quotedText": "string or null",
  "extractionQuality": "GOOD | LOW | ..."
}
```

### 示例（`modified`）

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
      "old": {
        "spanId": "span-old-1",
        "documentVersionId": "dv-old",
        "locator": { "kind": "markdown-line", "line": 2 },
        "quotedText": "Line two",
        "extractionQuality": "GOOD"
      },
      "new": {
        "spanId": "span-new-1",
        "documentVersionId": "dv-new",
        "locator": { "kind": "markdown-line", "line": 2 },
        "quotedText": "Line two changed",
        "extractionQuality": "GOOD"
      },
      "reason": null
    }
  ]
}
```

### C3 适配建议

- 消费 **`report` 顶层 + `changes[]`**，无需再包一层 diff 信封（除非 A 的 Job 外层另有 wrapper）。
- 引用交集：优先 **`old.spanId` / `new.spanId`**，并携带 **`documentVersionId`**、**`locator`**、**`quotedText`**。
- **不假设** `spanId` 跨版本稳定；对齐语义由 B2 规则决定，见下文「对齐规则」。

### 对齐规则（已实现，与测试一致）

1. 相同 `locator` + 相同 `quotedText` → **不进入** `changes`。
2. 相同 `locator`、不同 `quotedText` → `modified`。
3. 旧版 `quotedText` 在新版中**唯一**出现、但 `locator` 不同 → `uncertain`（可能移动）。
4. 旧版 `quotedText` 在新版中**多处**出现 → `uncertain`（无法唯一对应）。
5. 仍未匹配的旧 span → `removed`；仍未匹配的新 span → `added`。
6. Markdown 中间插行导致行号漂移 → 通常 **`removed` + `added`**，不伪造同 line 的 `modified`。
7. DOCX 同 cell、改单元格文字 → 单条 `modified`（`locator.kind == "docx-cell"`）。

测试：`services/intelligence/tests/source_changes/test_compare.py`。

---

## 待确认（2）质量字段（extractionQuality）

### B2 行为（定稿）

- `extractionQuality` **原样**出现在 `changes[].old` / `changes[].new` 的 span 视图中。
- compare **不**因 `LOW` / UNPARSED 改变 kind 判定；对齐仍按 `locator` + `quotedText` 规则执行。
- B2 **不**输出「是否影响规则/用例」结论；**不**读取 bundle 顶层 `warnings` / `coverageSummary`（C3 若需要请直接读 parse bundle）。

### C3 建议策略（B 不强制，供产品对齐）

| 场景 | C3 建议 |
|------|---------|
| `modified` 且任一侧 `extractionQuality != GOOD` | 影响建议标注「来源质量低，需复核」 |
| `uncertain` | **一律待复核**，不得当作未变更 |
| `added` / `removed` 且 `quotedText` 为空或来源为 UNPARSED | 沿用现有 NEEDS_OCR / UNPARSED 门，不依赖 B2 捏造文本 |
| 规则/用例 citation 绑 `spanId` + `documentVersionId` | `removed` / `modified` / 涉及 old 的 `uncertain` → 候选受影响；仅 `added` 不自动推断旧规则失效 |

---

## 待确认（3）ambiguous 表示法

### 定稿：无 `ambiguous`，统一为 `uncertain` + `reason`

若 C3 文档或代码中使用 `ambiguous`，请映射为 **`kind: "uncertain"`**。

| `kind` | `old` / `new` | `reason` |
|--------|---------------|----------|
| `added` | `old=null`, `new=span` | `null` |
| `removed` | `old=span`, `new=null` | `null` |
| `modified` | 均有；**同 locator**；不同 `quotedText` | `null` |
| `uncertain` | 见下 | **非空 string** |

### `uncertain` 的 `reason` 固定文案（当前实现）

1. **可能移动 / 坐标变化**（通常 `old`、`new` 均有）：  
   `相同原文出现在不同来源坐标，可能为移动或重复，需人工确认`

2. **新版多处重复**（通常 `new=null`）：  
   `旧版原文在新版中多处重复，无法唯一对应`

**契约化（供 A）**：`kind === "uncertain"` 时，`changes[].new` **允许为 `null`**（例如上条「多处重复」仅保留 `old` span 视图）；消费方不得假定 `uncertain` 时两侧都有 span。

后续若 A 要求 reason 改为机器码 + 可选 `reasonCode`，B 会在契约合并时追加字段并保持上述语义；C3 适配层应同时支持「读 `reason` 字符串」与将来的 `reasonCode`（若有）。

---

## B2 明确不在范围内

- 规则/用例/计划影响推断、批准版本变更（C3 + A）。
- 跨 path 批量、Git、DB、HTTP。
- 模糊匹配或段落级智能合并；无法唯一对齐即 `uncertain`。
- 重跑视觉或修正 parse；compare 仅对比两版已有 `spans`。

---

## A 侧仍待决（B/C 共同依赖）

- 是否将本 JSON 写入共享 Schema / `generated.py`。
- Job 或 API：何时触发 diff、是否持久化 `changes`。
- `changes` 与 `RuleVersion` / `TestCaseVersion` 待复核 UI 的关联方式。

B 在 A 定稿前不改 `generated.py`；定稿后 B/C 各改一层适配并补 golden。

---

## 验证命令

```bash
pytest services/intelligence/tests/source_changes
pnpm test:doc-ingestion
```

Windows 若 import 因 schema 编码失败：临时 `PYTHONUTF8=1`，或等 A 合入 [b-to-a-shared-files-proposal.md](./b-to-a-shared-files-proposal.md) 中的 UTF-8 读 schema 改动。

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-09-21 | 初版：回应 C3 提案三个待确认，与 `compare_bundles` 实现对齐 |
