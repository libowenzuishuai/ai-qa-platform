"""R0.6（V2-R06）：检索复合键与结构关联反例。"""
from aiqa_intelligence.agents.context_retrieval import retrieve


def bundle(dv, spans_spec):
    """spans_spec: [(spanId, text, quality)]；blocks 同序生成。"""
    blocks = [{"id": f"b-{dv}-{i}", "kind": "heading" if i == 0 else "paragraph", "text": t}
              for i, (sid, t, q) in enumerate(spans_spec)]
    spans = [{"id": sid, "documentVersionId": dv,
              "locator": {"kind": "markdown-line", "startLine": i + 1, "endLine": i + 1},
              "quotedText": None if q == "UNPARSED" else t, "extractionQuality": q}
             for i, (sid, t, q) in enumerate(spans_spec)]
    return {"documentVersionId": dv, "format": "MARKDOWN", "parseStatus": "PARSED",
            "parserVersion": "t", "blocks": blocks, "spans": spans, "warnings": [],
            "coverageSummary": {"totalBlocks": len(blocks), "goodSpans": 0, "lowSpans": 0, "unparsedSpans": 0}}


def test_same_span_id_different_docs_authority_not_crossed():
    """评审复现项：A/B 两文档同名 span-1，仅 A 属于批准来源 → 只有 A 的被权威选中。"""
    a = bundle("dv-A", [("span-1", "采购金额超过 5000 元必须主管审批", "GOOD")])
    b = bundle("dv-B", [("span-1", "无关文本内容而已", "GOOD")])
    result = retrieve({
        "query": "采购金额 审批",
        "documentVersions": [a, b],
        "ruleRefs": [{"ruleVersionId": "rv-1", "documentVersionId": "dv-A", "sourceSpanIds": ["span-1"]}],
        "maxSelected": 50,
    })
    auth = [s for s in result["selections"] if s["decision"] == "selected" and "权威" in s["reason"]]
    assert len(auth) == 1
    assert auth[0]["documentVersionId"] == "dv-A"
    # B 的同名 span 只能靠关键词，且其文本不命中 → rejected。
    b_entries = [s for s in result["selections"] if s["documentVersionId"] == "dv-B"]
    assert all(s["decision"] == "rejected" for s in b_entries)


def test_blocks_spans_length_mismatch_rejected():
    a = bundle("dv-A", [("span-1", "x", "GOOD")])
    a["blocks"].append({"id": "extra", "kind": "paragraph", "text": "extra"})
    try:
        retrieve({"query": "x", "documentVersions": [a], "ruleRefs": [], "maxSelected": 5})
        raise AssertionError("应当拒绝数量不一致的 bundle")
    except ValueError as exc:
        assert "不一致" in str(exc)


def test_unparsed_never_selected():
    a = bundle("dv-A", [("span-1", "表格图片", "UNPARSED")])
    result = retrieve({"query": "表格", "documentVersions": [a], "ruleRefs": [], "maxSelected": 5})
    unparsed = [s for s in result["selections"] if s["kind"] == "unparsed_range"]
    assert len(unparsed) == 1
    assert unparsed[0]["decision"] == "rejected"
