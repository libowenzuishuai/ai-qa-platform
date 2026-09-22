# 多文件来源 diff 合成夹具

**synthetic，非客户 Git 导出。** 沿用 B 的原始业务场景并补齐正式契约字段。

- `snapshot-v1.json` / `snapshot-v2.json`：同仓库固定提交、同扫描范围、完整性、文件字节校验和与大小。
- `raw/old` / `raw/new`：实际夹具字节；包括故意损坏的合成 PDF（不是有效客户 PDF）。
- `bundles.json`：Markdown 夹具的真实解析结果，按版本 ID 映射。损坏 PDF 未提供成功 bundle。
- 默认测试读取夹具并校验原始字节 SHA-256、大小与差异结论。
- 重新生成：仓库根目录 `PYTHONPATH=services/intelligence/src services/intelligence/.venv/bin/python services/intelligence/tests/source_changes/build_snapshot_vectors.py`。
- 共享 TS/Python 52 组向量在 `packages/contracts/fixtures/snapshot-diff-conformance.json`。

生成器会核对各正例预先指定的结局类别，反例独立篡改输入或输出；不要为了让测试通过而修改预期来接受错误行为。正式合同见 `docs/delivery/b-multi-file-review-and-contract.md`。
