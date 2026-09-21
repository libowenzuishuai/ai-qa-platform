# B 通道解析回归

从仓库根运行 `pnpm test:doc-ingestion`。测试生成真实 DOCX/PDF/PNG/JPEG，验证原始坐标、遗漏覆盖率、错误响应与进程取消；不使用开发数据库或付费模型。

DOCX：嵌套表按递增 `tableIndex` 递归解析；合并单元格只记录主网格坐标。页眉/页脚正文提取为 `docx-paragraph`，`paragraphIndex >= 正文段落数`，质量 LOW；脚注/尾注仍仅 warning。图片/修订等见 UNPARSED。`fixtures/b3-records/` 存 mock 评测快照（不含真实 Kimi 用量）。更新命令：`fixtures/refresh_b3_mock_records.py`。**B3-09 混排 PDF：** `b3-records/b3-mixed-prd-sample.pdf` + `b3-mixed-prd-sample.expected.json`（`fixtures/build_b3_mixed_fixture.py`）。默认 pytest 覆盖 P1 文字层（无 vision）。真实 Kimi（opt-in）：`fixtures/verify_b3_09_mixed_kimi_real.py --env-file .env.local` → `b3-mixed-prd-sample.real.json`（对照 expected 的 humanCheck；失败也保留记录需手动改脚本或放宽断言后再跑）。

B3-05 真实 Kimi（合成表格 PDF，opt-in）：`fixtures/verify_b3_05_kimi_real.py --env-file .env.local` → 写入 `b3-records/b3-05-pdf-scanned-table.real.json`。栅格表用 `fixtures/drawing.py` 加载系统中文字体（Windows msyh/simhei）；无 CJK 字体时生成会失败。样例 PDF：`b3-records/b3-05-table-source.pdf`。

`fixtures/b1-two-page.pdf` 使用原泽菲 `6ed386f` 回归中的 pdf-lib 默认压缩格式生成（Helvetica；FirstPage / SecondPage），用于重现旧 pdf-parse 双页测试失败；是本项目合成测试文件，无业务或个人数据。

**B3-08 试点观察：** `packages/contracts/fixtures/pilot-dify-v1/`（manifest 标明 SANITIZED_OBSERVATION_RECORD 与 BLOCKED 维度）；mock 快照 `b3-records/b3-08-real-pilot-sample.mock.json`，由 `refresh_b3_mock_records.py` 生成。

`fixtures/b3-eval-manifest.json` 记录 B3 资料评测清单（mock / 真实 Kimi / 试点观察）。默认 pytest 只覆盖 manifest 中标记为 `mock-covered` 的路径；真实视觉用 `verify_kimi_vision.py` 或后续 B3 脚本单独跑。单次评测记录可复制 `fixtures/b3-eval-record-template.json`。

B2 来源对比：`aiqa_intelligence.source_changes`（见 `tests/source_changes` 与 `docs/delivery/b-source-changes-contract-proposal.md`）。

Python HTTP 的正式 TS 契约验收位于 `apps/worker/test/intelligence-client.test.ts`，该测试使用临时证据目录并在结束时清理。
