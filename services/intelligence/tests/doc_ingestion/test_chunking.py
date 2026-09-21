"""R03 长文档分块：确定性、码点偏移、覆盖对账。"""
import json
from pathlib import Path

import pytest

from aiqa_intelligence.doc_ingestion.chunking import (
    CHUNK_STRATEGY_VERSION,
    ChunkLimit,
    chunk_bundle,
    coverage_report,
)

FIXTURE_DIR = Path(__file__).resolve().parents[4] / "packages/contracts/fixtures"
SHARED_VECTOR = FIXTURE_DIR / "chunking" / "shared-vector.json"

PARAMS = {"maxCharsPerChunk": 1200, "contextOverlapChars": 100, "modelBudgetChars": 40_000}


def make_bundle(blocks: list[tuple[str, str, str]], document_id="doc-v1"):
    """blocks: (kind, text, quality)。span 与 block 一一对应（同 bundle.add 语义）。"""
    prefix = "abc123def456abc123def456"
    spans, out_blocks = [], []
    for i, (kind, text, quality) in enumerate(blocks):
        out_blocks.append({"id": f"b-{prefix}-{i}", "kind": kind, "text": text})
        spans.append(
            {
                "id": f"s-{prefix}-{i}",
                "documentVersionId": document_id,
                "locator": {"line": i + 1},
                "quotedText": text if quality != "UNPARSED" else None,
                "extractionQuality": quality,
            }
        )
    return {
        "documentVersionId": document_id,
        "format": "MARKDOWN",
        "parseStatus": "PARSED",
        "parserVersion": "test",
        "blocks": out_blocks,
        "spans": spans,
        "warnings": [],
        "coverageSummary": {},
    }


def test_deterministic_same_input_same_manifest():
    bundle = make_bundle(
        [
            ("heading", "第一章 登录", "GOOD"),
            ("paragraph", "用户必须先登录。", "GOOD"),
            ("heading", "第二章 下单", "GOOD"),
            ("paragraph", "下单后 30 分钟内必须支付。", "GOOD"),
        ]
    )
    a = chunk_bundle(bundle, "sha256:x", PARAMS, created_at="2026-09-21T00:00:00Z")
    b = chunk_bundle(bundle, "sha256:x", PARAMS, created_at="2026-09-21T00:00:00Z")
    assert a == b
    assert a["strategyVersion"] == CHUNK_STRATEGY_VERSION
    assert [c["seq"] for c in a["chunks"]] == list(range(len(a["chunks"])))


def test_heading_forces_new_chunk_and_tail_never_cut():
    long_tail = "尾" * 1100  # 尾部正文：与第二章合并后仍在预算内
    bundle = make_bundle(
        [
            ("heading", "第一章", "GOOD"),
            ("paragraph", "内容甲" * 100, "GOOD"),  # 400 码点
            ("heading", "第二章", "GOOD"),
            ("paragraph", long_tail, "GOOD"),
        ]
    )
    manifest = chunk_bundle(bundle, "sha256:x", PARAMS)
    headings = [c for c in manifest["chunks"] if c["boundary"] == "heading"]
    assert len(headings) == 2
    # 尾部正文完整保留（不截断）：第二章 + 尾部同块。
    assert any(c["text"] == f"第二章\n{long_tail}" for c in manifest["chunks"])
    total = sum(c["estimatedChars"] for c in manifest["chunks"])
    # 第一章(3) + \n + 内容甲*100(300) + 第二章(3) + \n + 尾部(1100)
    assert total == 3 + 1 + 300 + 3 + 1 + len(long_tail)


def test_long_paragraph_code_point_slices_no_gap():
    # 中文 + emoji：码点计数与字节无关（😀 在 Python str 中是 1 个码点）。
    text = "订单😀" * 400  # 1200 码点（非字节长度）
    bundle = make_bundle([("paragraph", text, "GOOD")])
    manifest = chunk_bundle(bundle, "sha256:x", {**PARAMS, "maxCharsPerChunk": 600})
    slices = [c for c in manifest["chunks"] if c["boundary"] == "fixed-size"]
    assert len(slices) == 2  # ceil(1200/600)
    # 切片拼接还原原文：无空洞、无重叠。
    rebuilt = "".join(c["text"] for c in slices)
    assert rebuilt == text
    # SpanSlice 码点偏移连续。
    ranges = sorted(
        (r["slice"]["startOffset"], r["slice"]["endOffset"]) for r in (ref for c in slices for ref in c["spanRefs"])
    )
    cursor = 0
    for start, end in ranges:
        assert start == cursor
        cursor = end
    assert cursor == len(text)


def test_context_overlap_recorded_separately():
    bundle = make_bundle(
        [
            ("paragraph", "甲" * 700, "GOOD"),
            ("paragraph", "乙" * 700, "GOOD"),  # 触发新块
        ]
    )
    manifest = chunk_bundle(bundle, "sha256:x", PARAMS)
    assert len(manifest["chunks"]) == 2
    first, second = manifest["chunks"]
    assert second["contextOverlap"] == first["text"][-100:]
    # 重叠不计入正文预算。
    assert second["estimatedChars"] == len(second["text"]) == 700


def test_table_continuation_flag():
    rows = [("table", f"行{i}" + "列" * 20, "GOOD") for i in range(100)]  # ~2300 码点，必然跨块
    bundle = make_bundle([("heading", "价格表", "GOOD")] + rows)
    manifest = chunk_bundle(bundle, "sha256:x", PARAMS)
    table_chunks = [c for c in manifest["chunks"] if c["boundary"] == "table"]
    assert table_chunks, "表格内容必须入块"
    assert any(c["isTableContinuation"] for c in manifest["chunks"]), "跨块表格延续必须显式标记"
    # 首块（标题开头）不是延续。
    assert manifest["chunks"][0]["isTableContinuation"] is False
    # 延续块的表头经 contextOverlap 带入。
    cont = next(c for c in manifest["chunks"] if c["isTableContinuation"])
    assert cont["contextOverlap"], "跨块表格延续必须携带上下文（含表头）"


def test_unparsed_span_referenced_but_blocked_in_coverage():
    bundle = make_bundle(
        [
            ("paragraph", "正常内容。", "GOOD"),
            ("table", "", "UNPARSED"),  # 单元格内嵌图片等不可解析
        ]
    )
    manifest = chunk_bundle(bundle, "sha256:x", PARAMS)
    # 空文本片段保留引用（不默默丢弃）。
    all_refs = [r for c in manifest["chunks"] for r in c["spanRefs"]]
    assert any(r.get("spanId") == "s-abc123def456abc123def456-1" for r in all_refs)
    report = coverage_report(manifest, bundle["spans"])
    assert report["processedFragments"] + report["contextFragments"] + report["blockedFragments"] == report["totalFragments"]
    blocked = [a for a in report["assignments"] if a["assignment"] == "blocked"]
    assert any("UNPARSED" in (a.get("reason") or "") for a in blocked)


def test_coverage_detects_duplicate_assignment_and_slice_gap():
    bundle = make_bundle([("paragraph", "内容", "GOOD")])
    manifest = chunk_bundle(bundle, "sha256:x", PARAMS)
    # 人为制造重复引用：两个块引用同一 span。
    manifest["chunks"].append({**manifest["chunks"][0], "seq": 1, "chunkId": "c-x-1"})
    report = coverage_report(manifest)
    assert any(a["assignment"] == "blocked" and "多个块" in (a.get("reason") or "") for a in report["assignments"])

    # 人为制造切片空洞。
    bundle2 = make_bundle([("paragraph", "x" * 1200, "GOOD")])
    manifest2 = chunk_bundle(bundle2, "sha256:x", {**PARAMS, "maxCharsPerChunk": 500})
    for chunk in manifest2["chunks"]:
        for ref in chunk["spanRefs"]:
            if ref["type"] == "slice" and ref["slice"]["startOffset"] == 500:
                ref["slice"]["startOffset"] = 560  # 挖掉 [500,560)
    report2 = coverage_report(manifest2)
    assert any("空洞" in (a.get("reason") or "") for a in report2["assignments"])


def test_budget_param_validation():
    bundle = make_bundle([("paragraph", "内容", "GOOD")])
    # maxCharsPerChunk 超过 modelBudgetChars - 输出预留 → 拒绝。
    with pytest.raises(ChunkLimit, match="输出预留"):
        chunk_bundle(bundle, "sha256:x", {"maxCharsPerChunk": 30_000, "contextOverlapChars": 100, "modelBudgetChars": 40_000})
    with pytest.raises(ChunkLimit):
        chunk_bundle(bundle, "sha256:x", {"maxCharsPerChunk": 400, "contextOverlapChars": 0, "modelBudgetChars": 40_000})
    with pytest.raises(ChunkLimit):
        chunk_bundle(bundle, "sha256:x", {"maxCharsPerChunk": 1200, "contextOverlapChars": 1200, "modelBudgetChars": 40_000})


def test_shared_vector_fixture_roundtrip():
    """跨语言测试向量：TS 端校验同一 manifest 符合 Zod 契约。"""
    vector = json.loads(SHARED_VECTOR.read_text())
    manifest = chunk_bundle(
        vector["bundle"], vector["documentChecksum"], vector["strategyParams"], created_at=vector["expectedManifest"]["createdAt"]
    )
    assert manifest == vector["expectedManifest"]
    report = coverage_report(manifest, vector["bundle"]["spans"])
    assert report["processedFragments"] + report["blockedFragments"] == report["totalFragments"]
