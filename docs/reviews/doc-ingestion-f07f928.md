# doc-ingestion 第一版评审

日期：2026-09-18；分支：`phase2/doc-ingestion`；提交：`f07f928`。

## 结论：暂不合入 main，修正来源定位和图片结果校验后复审

第一版的包结构、统一入口和 bundle 存储约定可以继续沿用。未接 DOCUMENT_PARSE API/worker 是已声明的范围边界，本次不将其计为解析库缺陷。

已在隔离目录安装锁定依赖，原有 **9/9 测试通过**，包类型检查通过。但这些测试主要覆盖 Markdown；它们没有验证真实 PDF 分页、成功的图片解析和 DOCX 表格定位。

补充五个反例，全部重现了以下错误行为。反例测试中的“通过”表示成功复现缺陷，不表示功能验收通过。

## 必修项

### B1 / P1：PDF 页码不能按行数估算

- 位置：`packages/doc-ingestion/src/parse.ts` PDF 分支，`Math.floor(i / 40) + 1`。
- 复现：生成真实两页 PDF，每页仅一行，第二页文字 `SecondPage` 的 locator 被写为 `page: 1`。
- 影响：规则证据跳转到错误页面，系统却将提取质量标为 GOOD。
- 修改：在 PDF 提取时保留各页实际边界及原始页号；不要先拼成整体文本再猜页码。混合文字/扫描页应保留无法解析页的提示或片段，不能因其它页有文字就静默忽略。
- 验收：不同页不同行数、空页、混合扫描页的真实 PDF；逐项核对引用页号。

### B2 / P1：列表和部分标题缺少可引用片段，且没有告警

- 位置：`packages/doc-ingestion/src/markdown.ts` 的 h1、h3–h6、listItem 分支；无一级标题时的 h2 分支也没有 span。
- 复现：`# 需求\n- 金额超过 5000 元必须审批\n### 审批后禁止修改金额` 被标为 PARSED，正文存在，但 spans 长度为 0，unparsedSpans 仍为 0。
- 影响：需求明明可见，后续提取却无法引用证据；当前覆盖统计也不能揭示这一遗漏。
- 修改：给包含业务信息的标题、列表、表格等内容保留真实行号/标题路径的 span；暂不支持的结构显式标记 LOW/UNPARSED 或告警。
- 验收：无 h1 的文档、嵌套列表、深层标题、表格、代码围栏等独立用例。列表中的业务句必须能被规则提取引用并通过联合校验。

### B3 / P1：图片产物出现重复块 ID，来源定位指向不存在的 Markdown

- 位置：`packages/doc-ingestion/src/parse.ts` 图片分支的 `textToBlocks` 与手工添加 image block。
- 复现：注入返回 `{text:"金额超过 5000 元必须审批"}` 的视觉适配器；image block 与第一段文字都使用 `doc-img-blk-01`，span locator 则是 `markdown-line`。
- 影响：内容块不能唯一识别；用户无法从引用回到原图对应位置。
- 修改：块 ID 使用统一分配器；图片引用使用真实图片区域。无法得到区域时，应明确约定整图定位和质量，不能伪造 Markdown 行号。
- 验收：同一 bundle 内所有块/片段 ID 唯一；图片引用可定位回原图；模型描述与逐字 OCR 文本的证据质量需区分。

### B4 / P1：视觉响应没有结构校验，错误对象会成为需求正文

- 位置：`packages/doc-ingestion/src/parse.ts` 图片分支的 `typeof parsedJson` 检查与 `response.rawText` 回退。
- 复现一：parsedJson 为 null 时抛 TypeError（`typeof null === "object"`）。
- 复现二：返回 `{error:"无法识别"}` 时，没有 text 却仍返回 PARSED，错误 JSON 被当作正文。
- 修改：传入明确 outputSchema，并在解析入口验证非 null、非数组对象及非空 text；删除原始 JSON 充当业务正文的回退。适配器抛错、超时或无文字时，统一返回约定的失败/待 OCR 结果。
- 验收：null、数组、空对象、text 类型错误、空白 text、适配器抛错，以及合法文字响应。

## 合入前还需补齐的验证

- DOCX：目前直接抽为纯文本后重新按段落计数。应验证表格单元格、空段落、列表等内容是否保留可回到原文件的定位；损坏 DOCX 的异常是否按 ParseDocumentResult 收敛。
- NEEDS_OCR：当前返回 `ok:false` 且无 bundle；与阶段二“解析作业成功完成、产物状态为 NEEDS_OCR”的约定需要明确衔接，并保证状态、warnings、覆盖信息能落库。可以由接线层适配，但必须写明，不要把正常待 OCR 误报为内部失败。
- 20 MB 大小限制：明确由哪个入口执行，并补超限反例；当前独立解析入口没有此限制。

## 本次验证边界

没有调用真实模型；图片使用注入式视觉适配器。PDF 反例使用实际生成的两页 PDF，经真实 pdf-parse 提取。未修改该分支、未合并、未推送，也没有代替作者实现 DOCUMENT_PARSE 接线。

建议原泽菲在原分支修复 B1–B4，增加对应真实文件和错误响应测试后再提交复审；不必重写整个包。
