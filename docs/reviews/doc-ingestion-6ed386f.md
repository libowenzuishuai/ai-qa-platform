# 文档解析修正版评审与合并

日期：2026-09-18。评审分支 `phase2/doc-ingestion`，提交 `6ed386f`，前版 `f07f928`；目标主干基线 `3a43b04`。

## 结论

修正方向合理，但原提交不能直接通过验收。已按既定“TypeScript 平台 + Python 智能服务”架构迁移、修复并验收首版；合并保留原分支提交历史，主干只维护 Python 解析器。没有更改原泽菲的远程分支，也没有放宽公共契约。

本次完成范围是可独立调用的解析模块及内部 HTTP 接口，不等于阶段二端到端完成。

## 原分支复测

从 `6ed386f` 导出独立工作目录，按锁文件安装后运行 `pnpm test:doc-ingestion`：**15 通过，1 失败（16 项）**。失败的是 `test/regressions.test.ts` 的双页 PDF，`result.ok` 实际为 false；日志出现 flate stream 解码错误。因此不能沿用“全部回归通过”的结论。

保留了同一 pdf-lib 默认压缩格式、相同内容的合成 PDF，Python 与 TS→Python HTTP 回归均确认第二页 `SecondPage` 定位为 page 2。测试保留提取的换行，不要求解析器删除正文空白来迎合断言。

## 问题与处理

| 问题 | 处理 |
|---|---|
| PDF 改逐页是正确方向，但原双页测试仍失败，且无 200 页上限 | 使用 pypdf 真实页对象；增加原格式压缩 PDF 回归和 201 页拒绝测试 |
| 图片正文仅保留前 500 字，span 却引用全文 | 块与引用保留同一份全文；超 10 万字符显式进入 NEEDS_OCR，不返回截断的有效正文 |
| DOCX 扁平文本丢失表格结构，并在滤掉空段落后改变编号 | 使用正文段落/表格结构；保留原始零起始坐标，合并单元格记录主格；未解析内容明确标注 |
| 完全扫描 PDF 的 unknown span 被清空 | 每个未提取到文字的页面保留 UNPARSED 记录，覆盖统计如实计算；无文字返回 NEEDS_OCR |
| “无 h1”测试实际仍含 h1，代码围栏可能被当成标题/列表 | 使用真正无 h1 的反例；代码与表格降级为 LOW，正文标点不被清洗 |
| 图片用几个文件头字节即可通过测试 | 使用完整真实 PNG/JPEG；检查格式、解码、像素和单帧限制，截断文件失败 |
| CPU 解析需要受控执行 | 每个服务进程最多两个解析子进程，请求取消/超时终止实际子进程；测试确认无遗留子进程 |
| 原分支仍在旧 TS 目录 | 迁入 `services/intelligence/src/aiqa_intelligence/doc_ingestion`；旧包只保留迁移说明；Python 依赖独立锁定 |

沿用主干只读 ArtifactReader 校验实际大小、SHA-256 和目录边界，未新增数据库/队列权限。无模型配置返回 MODEL_NOT_CONFIGURED，模型超时继续返回明确错误；结构错误或无文字不伪装为有效正文。

## 最终验证

- `pnpm test:intelligence`：**64/64**，含本次解析回归 **35 项**。
- `pnpm test:contracts`：**131/131**。
- `pnpm --filter @ai-qa/worker exec vitest run test/intelligence-client.test.ts`：**6/6**，真实临时 Python HTTP 服务和临时证据目录，包含 PDF 实际解析与正式 TS 响应契约校验。
- `pnpm typecheck`、`pnpm contracts:check`、Python 生成模型 `--check`、`pip check`、`git diff --check` 均通过。
- 本轮共 **201 项测试通过**。旧分支失败与新实现通过分别记录，不混算。
- 首次沙箱内 HTTP 测试服务启动失败；获准在沙箱外使用本机临时端口执行后通过。没有连接开发数据库，没有读取根 `.env` 或调用付费模型。
- FastAPI 测试依赖存在弃用提示，不影响测试结果；本次没有顺带升级公共框架。

## 尚未完成与下一步

- **B / 原泽菲**：从最新 main 开 Python 分支，继续扫描 PDF OCR、精细文字框定位、复杂/嵌套表格和遗漏覆盖率。PDF 当前只提文字层；空白页与扫描页不能可靠区分，会明确要求检查/OCR。DOCX 页眉页脚、文本框、修订等未完整解析。
- **A / 李博闻**：接文档上传、版本登记、DOCUMENT_PARSE 作业与解析资产落库，之后联调审阅流程。本次未实现这些平台功能。
- **C / 李琪双**：继续正式 Python 规则提取与用例生成；对应 ready 仍为 false，保持原责任边界。
- 真实 Kimi 图片质量、Docker 镜像运行、生产负载/资源隔离另行验收，本次不宣称通过。

接口与运行限制见 `services/intelligence/README.md`；协作边界见 `docs/stage2-python-handoff.md`。
