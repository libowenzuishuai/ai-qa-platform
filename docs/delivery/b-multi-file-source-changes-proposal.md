# B 多文件来源 diff 提案（待 A 冻结共享契约）

日期：2026-09-22 · 分支：`v1/multi-file-source-diff` · 提交方：B  
单文件契约见 `packages/contracts/src/source-changes.ts`；**本提案不修改 generated.py**。

## 用途

对比同一逻辑仓库的**两份目录快照**（如 Git 两次 commit 内的资料清单），识别文件级新增/删除/修改/未变化/不确定（含重命名），并在同路径内容变更时**嵌套**现有 `compare_bundles` 的 span 级报告。

## 建议快照条目（SnapshotEntry）

| 字段 | 说明 |
|------|------|
| `path` | 仓库内逻辑路径 |
| `checksum` | 内容 SHA-256（hex） |
| `documentVersionId` | 解析版本 ID（未解析可为 null） |
| `format` | 资料格式（可选） |
| `fetchStatus` | `OK` \| `NOT_FETCHED` \| `FETCH_FAILED` |
| `parseStatus` | `PARSED` \| `NEEDS_OCR` \| `FAILED` \| `PENDING` \| null |

## 建议文件级变更（FileChange）

`kind`：`unchanged` \| `added` \| `removed` \| `modified` \| `uncertain`

| kind | 含义 |
|------|------|
| `unchanged` | 同 path、同 checksum |
| `added` | 新快照独有 path，且新侧可获取 |
| `removed` | 旧快照独有 path，且旧侧 **fetchStatus=OK** 且 **parseStatus∈{PARSED,NEEDS_OCR}** |
| `modified` | 同 path、不同 checksum；可附 `spanReport`（单文件 compare 输出） |
| `uncertain` | 重命名无法唯一对应、旧侧未成功获取/解析却「消失」、重复 checksum 等 |

**禁止**：旧侧 `NOT_FETCHED` / `FETCH_FAILED` / `FAILED` / `PENDING` 的文件，因新快照中无同 path **不得**报 `removed`（应 `uncertain` + reason）。

## 重命名规则（已实现，待 A 命名）

1. 同 checksum 在旧、新各**唯一**出现且 path 不同 → `uncertain`，reason 含「唯一内容匹配，可能为重命名」，`oldPath`/`newPath` 均填。
2. 同 checksum 多处出现 → `uncertain`，无法唯一配对。
3. 同 path 不同 checksum → `modified`（非重命名）。

## 实现位置

- `aiqa_intelligence.source_changes.compare_snapshots`
- 夹具：`tests/source_changes/fixtures/multi_file/`
- 测试：`tests/source_changes/test_snapshot_compare.py`

## A 侧待冻结

- 正式类型名、是否 `FileChangeReport` 独立 Job 输出
- `fetchStatus` / `parseStatus` 枚举与 TS 共享反例
- 与 Git 快照 API 的字段映射
