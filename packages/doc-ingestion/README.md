# 文档解析已迁入 Python

原泽菲的 `phase2/doc-ingestion`（`f07f928`、`6ed386f`）修正已迁入：

- `services/intelligence/src/aiqa_intelligence/doc_ingestion`
- `services/intelligence/tests/doc_ingestion`

主干不再维护第二套 TypeScript 解析库。原实现与提交历史保留在 Git 中。

从仓库根目录运行 `pnpm test:doc-ingestion`。接口、分工和部署方式见
`docs/stage2-python-handoff.md` 与 `services/intelligence/README.md`。
