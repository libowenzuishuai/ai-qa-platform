# B → A 共享文件变更提案（§六）

日期：2026-09-20 · 提交方：B / 原泽菲 · **未在 B 分支直接改以下文件**

## 1. `contracts/validation.py` — Windows 读 schema 编码

**现象**：在 Windows 默认 GBK 下，`Path.read_text()` 读 `schema.v1.json` 会 `UnicodeDecodeError`，导致 `import aiqa_intelligence.doc_ingestion` 或 `verify_kimi_vision.py` 失败。

**建议改动**（一行）：

```python
SCHEMA = json.loads(
    Path(__file__).with_name("schema.v1.json").read_text(encoding="utf-8")
)
```

**归属**：§六 A 维护 `validation.py`。B 仅跑真实视觉验收时发现，请 A 合入 `main`。

## 2. `services/intelligence/README.md` — DOCX 嵌套表说明

**内容**：B1 已实现嵌套表格递归与递增 `tableIndex`（见 `doc_ingestion/binary.py` 与 `tests/doc_ingestion/test_parsers.py`）。

**建议**：在「文档解析首版范围 → DOCX」 bullet 中补充「嵌套表内层递增 tableIndex；单元格图片/修订仍 UNPARSED」，与当前代码一致。

**归属**：服务级 README 由 A 汇总；B 在 `tests/doc_ingestion/README.md` 已写测试与 manifest 说明。
