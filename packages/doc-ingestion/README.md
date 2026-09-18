# @ai-qa/doc-ingestion

文档解析与来源定位（PRD FR-02 / 阶段 2 · 原泽菲 B 通道）。

## 能力

| 格式 | 行为 |
|---|---|
| MARKDOWN / TXT | 标题路径 + 行号 span，产出 `ParsedDocumentBundle` |
| DOCX | mammoth 提取文本，`docx-paragraph` 定位 |
| PDF（有文本层） | `pdf-parse` 提取，`pdf-page` 定位 |
| PDF（扫描/无文本） | `NEEDS_OCR`，禁止空文本 `PARSED` |
| PNG / JPEG | 注入 `VisionModelAdapter` 则描述后解析；否则 `NEEDS_OCR` |

## 存储约定

与 worker 一致：

```text
bundles/{documentVersionId}/bundle.json
```

使用 `writeBundle(artifactStore, bundle)` 写入。

## 脚本

```bash
pnpm --filter @ai-qa/doc-ingestion test
pnpm --filter @ai-qa/doc-ingestion typecheck
```
