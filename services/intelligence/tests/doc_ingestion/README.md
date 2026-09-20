# B 通道解析回归

从仓库根运行 `pnpm test:doc-ingestion`。测试生成真实 DOCX/PDF/PNG/JPEG，验证原始坐标、遗漏覆盖率、错误响应与进程取消；不使用开发数据库或付费模型。

DOCX：嵌套表按递增 `tableIndex` 递归解析；合并单元格只记录主网格坐标。页眉/页脚正文提取为 `docx-paragraph`，`paragraphIndex >= 正文段落数`，质量 LOW；脚注/尾注仍仅 warning。图片/修订等见 UNPARSED。`fixtures/b3-records/` 存 mock 评测快照（不含真实 Kimi 用量）。

`fixtures/b1-two-page.pdf` 使用原泽菲 `6ed386f` 回归中的 pdf-lib 默认压缩格式生成（Helvetica；FirstPage / SecondPage），用于重现旧 pdf-parse 双页测试失败；是本项目合成测试文件，无业务或个人数据。

`fixtures/b3-eval-manifest.json` 记录 B3 八份资料评测占位（mock / 真实 Kimi / 试点资料状态）。默认 pytest 只覆盖 manifest 中标记为 `mock-covered` 的路径；真实视觉用 `verify_kimi_vision.py` 或后续 B3 脚本单独跑。单次评测记录可复制 `fixtures/b3-eval-record-template.json`。

B2 来源对比：`aiqa_intelligence.source_changes`（见 `tests/source_changes` 与 `docs/delivery/b-source-changes-contract-proposal.md`）。

Python HTTP 的正式 TS 契约验收位于 `apps/worker/test/intelligence-client.test.ts`，该测试使用临时证据目录并在结束时清理。
