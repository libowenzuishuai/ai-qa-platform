# B 多文件 diff：评审、修复与正式契约

2026-09-22。评审对象：`v1/multi-file-source-diff@a908a49`，基于 main `dbc0a04` 隔离整合。**本轮仅合入纯模块、共享契约与测试；没有合入 GLM 的 release-completion 分支，也没有修改其未提交工作。**

## 1. 结论与发现

B 已实现可复用的同路径/校验和配对和片段比较，合成夹具声明准确；首版还不能直接接平台。原分支共有 17 个 source_changes 测试，其中单文件 13 个、多文件 4 个，并非 17 个都是多文件测试。

先新增 8 个独立反例，在原实现上得到 **8 失败**，修复后全部通过：

1. 重复路径被 dict 静默覆盖；现在直接拒绝。
2. 未核对仓库身份；现在跨仓库拒绝。
3. 未记录扫描完整性；新快照漏项会误报删除。现在 PARTIAL/FAILED 保留说明，缺失项为 uncertain，report.complete=false。
4. 同哈希但获取失败仍是 unchanged；现在获取状态先于内容判断。
5. 新侧未获取的文件被标 added；现在 uncertain。
6. 缺少 bundle 仍声称 unchanged；现在不能据文件哈希断言解析依据有效，缺 bundle 为 uncertain。
7. 相对路径可含 `..`；现在拒绝绝对路径、空段、点段、反斜杠、控制字符等。
8. 传入 bundle 与文件声明的 documentVersionId 不匹配仍被使用；现在核验版本、格式、解析状态和真实片段。

另补：来源 LOW/UNPARSED、格式/解析器变化、重复哈希、多文件输出顺序、全增/全删/两边为空、伪造报告和片段、范围变化、大小与计数矛盾、预算超限。

原首版将唯一字节哈希对应标为 uncertain。本轮按 PRD 定稿：可读取且可信的唯一字节对应为 **renamed**，仍 `requiresHumanReview=true`；解析不可用、质量不足、解析产物变化则保持 uncertain。不同字节不会因解析文字相同而成为 renamed。

## 2. 冻结的文件与公共入口

- Zod：`packages/contracts/src/snapshot-diff.ts`
- Schema/Pydantic：由 `export-intelligence.ts`、`generate_models.py` 生成，未手改生成文件。
- Python：`aiqa_intelligence.source_changes.compare_snapshots`
- Python 验证：`validate_snapshot_input`、`validate_snapshot_diff`
- TS 最终联合校验：`validateSnapshotDiff(input, report)`
- 双端共享反例：`packages/contracts/fixtures/snapshot-diff-conformance.json`（52 组，synthetic）

正式类型：`SnapshotFileEntry`、`RepositorySnapshotManifest`、`SnapshotDiffInput`、`SnapshotFileChange`、`SnapshotDiffReport`。

本轮未新增 JobKind、HTTP 端点或数据库表。这里是正式**模块 wire 契约**，不是授权浏览器提交任意快照的 API 契约。

### 输入

`SnapshotDiffInput = { oldSnapshot, newSnapshot, bundles }`。Python 沿用 B 公共函数参数：

```python
report = compare_snapshots(old_snapshot, new_snapshot, bundles=bundles_by_version)
validate_snapshot_diff(
    {"oldSnapshot": old_snapshot, "newSnapshot": new_snapshot, "bundles": bundles_by_version},
    report,
)
```

快照字段全部显式：

| 字段 | 含义 |
|---|---|
| snapshotId | 不同的、已固定快照 ID |
| repositoryId | 相同仓库身份，不能由调用方随意冒充 |
| commitSha | 40 位小写 SHA，允许同提交重新解析形成不同快照 |
| scope | `root/include/exclude/policyVersion`，比较需同一范围/策略；数组次序不改变范围 |
| enumerationStatus | COMPLETE / PARTIAL / FAILED，仅针对声明范围，不代表整个仓库 |
| enumerationReason | COMPLETE 时 null，其他状态非空原因 |
| entries | 最多 200 个文件；完整空清单合法，不再要求两边至少一个文件 |

文件字段全部显式：`path/checksum/sizeBytes/documentVersionId/format/fetchStatus/parseStatus`。checksum 是**原始文件字节 SHA-256**，不是解析文本哈希。fetchStatus 为 OK/NOT_FETCHED/FETCH_FAILED；获取成功必须有 checksum/sizeBytes/format；未取得文件不能声称已有解析版本与状态。可保留已知字节元数据，但不能用于绕过获取失败判定。

bundles 按实际 documentVersionId 映射。提供了就必须真实匹配并通过 ParsedDocumentBundle 校验；未提供保守地输出 PARSE_UNAVAILABLE，不能凭空补空 bundle。总计最多 400 bundles、40000 spans、200 万 Unicode 码点（blocks.text 与 spans.quotedText 一并计入）。超过预算明确拒绝。

### 输出

`SnapshotDiffReport = { oldSnapshotId, newSnapshotId, fileChanges, complete, requiresHumanReview, coverage }`。

fileChanges 每项包含：

- kind：unchanged / added / removed / modified / renamed / uncertain。
- old/new：原清单的完整文件条目或 null，因此旧/新路径分别读取 `old.path/new.path`。不再保留提案的顶层 path/oldPath/newPath 等重复字段。
- reasonCode/reason：uncertain 必填稳定码和可读原因；其他项为 null。
- spanReport：仅 modified 必须携带真实 `SourceChangeReport`，沿用原片段 ID；其他项 null。

不确定码：SNAPSHOT_INCOMPLETE、FETCH_UNAVAILABLE、PARSE_UNAVAILABLE、SOURCE_QUALITY_UNCERTAIN、FORMAT_CHANGED、PARSE_CHANGED、AMBIGUOUS_RENAME。

coverage 对账到冻结输入每侧文件数量，每个输入条目恰好消费一次。缺失、多余、重复、伪造路径/校验和/片段、错误快照、错误结论与排序均被联合校验拒绝。报告按 Unicode code point 路径顺序稳定输出，含中文/emoji 共享例。

complete 仅指两侧枚举完整且无不确定文件项；它不代表业务验收通过。requiresHumanReview 永远为 true，不能自动审批需求或关闭缺陷。部分扫描即使已知文件都没变、甚至没有条目，complete 仍为 false。

### 匹配与质量规则

1. 同路径先匹配。
2. 剩余文件仅对 fetchStatus=OK 的非空原始字节哈希建索引；旧/新各唯一才配对。
3. 重复哈希不猜配对，每个候选保留单侧 uncertain。
4. 缺失一侧只有在对侧完整枚举、现存侧内容可获取且来源可靠时才判 added/removed；否则 uncertain。
5. 判断 unchanged/renamed 前必须验证两侧 bundle 可读、span 非空且全 GOOD。相同字节下解析器或解析产物变化为 PARSE_CHANGED。
6. 重命名同时改字节不靠名称猜测：在完整范围内表现为独立删除/新增，保留“未证明重命名”的边界。
7. 范围/策略不同直接拒绝比较；不静默把排除变化解释为删除。

## 3. 平台接线责任（GLM 必须照此处理）

- 先合入这个 main，再处理 release-completion 的冲突；B 的 `compare_snapshots` 是正式实现。GLM 的 `compare_files` 不应作为另一套生产算法保留。兼容旧试验数据可写薄适配器，不能伪造缺失元数据。
- 使用服务器保存的仓库身份/固定提交/扫描范围和完整性装载 manifest，读取实际字节校验 checksum/size，再加载经校验的 bundle。**本纯模块不能证明调用方提供的 checksum 或 COMPLETE 是真实的。**
- 浏览器只选择已登记快照 ID；不接受浏览器自报 COMPLETE、清单完整性或原文。旧 `oldFiles/newFiles` 试验接口如果没有完整性证明，必须标记不完整，不能迁移成完整。
- Python 输出落库前必须调用 `validateSnapshotDiff(frozenInput, output)`。仅 `SnapshotDiffReport.parse(output)` 只有结构校验，不是来源/覆盖/配对校验。
- 接 API/worker 时补齐 JobKind/Envelope、查询、取消、对账、固定输入与 lease/CAS；本模块合入不意味着 R02 已完成。
- 复核门区分分析作业成功与人工复核完成；未决、不完整和缺计划不能被新基线掩盖。新增/删除资产的批准与旧标准复测继续按 PRD。
- 后续若需超过 200 文件，不得截断后伪装完整；扩展分页/预算契约与双方测试再提高上限。

## 4. 真实验证结果

| 项目 | 本轮结果 |
|---|---|
| 原实现评审反例 | 8/8 如预期暴露问题（修复前失败） |
| TS 契约全套 | 233 通过，含新增共享 52 组 |
| Python intelligence 全套 | 345 通过，5 条既有依赖/收集警告 |
| 契约类型检查 | 通过 |
| Schema / Python 生成一致性 | 通过 |
| 夹具校验和 | 核对 raw 目录实际字节与大小；不是解析正文哈希 |

Python 使用本机已有 Python 依赖环境，PYTHONPATH 指向隔离评审树；没有读取模型密钥或调用 Kimi，没有修改日常数据库。无需本轮重跑无改动的浏览器/数据库全链。合成夹具不是客户项目、真实 Git 扫描或业务验收。

本机日志：`/tmp/aiqa-b-review-red.log`、`/tmp/aiqa-b-review-contracts-final.log`、`/tmp/aiqa-b-review-full-python.log`。后续 CI 仍需看实际运行结果，本报告不提前宣称远端 CI 通过。
