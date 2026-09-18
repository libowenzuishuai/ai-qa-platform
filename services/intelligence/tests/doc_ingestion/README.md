# B 通道解析回归

从仓库根运行 `pnpm test:doc-ingestion`。测试生成真实 DOCX/PDF/PNG/JPEG，验证原始坐标、遗漏覆盖率、错误响应与进程取消；不使用开发数据库或付费模型。

`fixtures/b1-two-page.pdf` 使用原泽菲 `6ed386f` 回归中的 pdf-lib 默认压缩格式生成（Helvetica；FirstPage / SecondPage），用于重现旧 pdf-parse 双页测试失败；是本项目合成测试文件，无业务或个人数据。

Python HTTP 的正式 TS 契约验收位于 `apps/worker/test/intelligence-client.test.ts`，该测试使用临时证据目录并在结束时清理。
