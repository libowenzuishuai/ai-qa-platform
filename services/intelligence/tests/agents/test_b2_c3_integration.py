"""B2→C3 端到端集成：compare_bundles 输出直接喂影响分析。

以 importorskip 守卫：B 的 source_changes 模块合入本分支/main 前跳过，
合入后自动激活——形状漂移会在联调前而不是联调中暴露。
对齐依据：b-source-changes-contract-proposal.md（v1/document-fidelity）。
"""

import pytest

pytest.importorskip("aiqa_intelligence.source_changes")

from aiqa_intelligence.agents.impact import adapt_source_changes, analyze_impact  # noqa: E402
from aiqa_intelligence.contracts.generated import ApprovedRuleVersion, TestCase  # noqa: E402
from aiqa_intelligence.source_changes import compare_bundles  # noqa: E402


def bundle(doc_id: str, spans: list[dict]) -> dict:
    return {
        "documentVersionId": doc_id, "format": "MARKDOWN", "parseStatus": "PARSED",
        "parserVersion": "md-1",
        "blocks": [{"id": "b-0", "kind": "paragraph", "text": "正文"}],
        "spans": [
            {
                "id": s["id"], "documentVersionId": doc_id,
                "locator": {"kind": "markdown-line", "startLine": s["line"], "endLine": s["line"]},
                "quotedText": s["text"], "extractionQuality": s.get("quality", "GOOD"),
            }
            for s in spans
        ],
        "coverageSummary": {"totalBlocks": 1, "goodSpans": len(spans), "lowSpans": 0, "unparsedSpans": 0},
        "warnings": [],
    }


def rule(rid: str, span: str) -> ApprovedRuleVersion:
    return ApprovedRuleVersion.model_validate(
        {
            "id": rid, "ruleId": f"{rid}-root", "version": 1,
            "statement": "陈述", "classification": "EXPLICIT",
            "action": "操作", "expectation": "预期", "origin": "manual",
            "createdAt": "2026-09-20T00:00:00Z",
            "sources": [{"documentVersionId": "dv-old", "sourceSpanIds": [span]}],
        }
    )


def case(cid: str, rule_ids: list[str]) -> TestCase:
    return TestCase.model_validate(
        {
            "id": cid, "caseId": f"{cid}-root", "version": 1, "title": "用例",
            "ruleVersionIds": rule_ids, "roles": ["applicant"],
            "dataSpec": {"strategy": "create", "note": "页面操作"},
            "steps": [{"id": "s1", "role": "applicant", "action": "提交"}],
            "assertions": [
                {"id": "a1", "description": "状态", "kind": "ui.text",
                 "ruleVersionId": rule_ids[0], "operator": "equals", "expected": "已提交"}
            ],
            "cleanup": {"strategy": "manual"}, "origin": "manual",
            "createdAt": "2026-09-20T00:00:00Z",
        }
    )


def test_modified_removed_added_flow_through_impact():
    """同行改文→modified 命中规则；未变 span 的规则不受影响；added 进 unresolved。"""
    old = bundle("dv-old", [
        {"id": "span-1", "line": 1, "text": "金额超过 5000 元需主管审批"},
        {"id": "span-2", "line": 2, "text": "报销三个工作日内复核"},
        {"id": "span-3", "line": 3, "text": "采购员不得自审"},
    ])
    new = bundle("dv-new", [
        {"id": "span-9", "line": 1, "text": "金额超过 8000 元需主管审批"},
        {"id": "span-2", "line": 2, "text": "报销三个工作日内复核"},
        {"id": "span-4", "line": 4, "text": "新增条款"},
    ])
    changes = adapt_source_changes(compare_bundles("requirements/prd.md", old, new)["changes"])
    kinds = sorted(c.kind for c in changes)
    assert kinds == ["added", "modified", "removed"]

    rules = [rule("rule-v1", "span-1"), rule("rule-v2", "span-2")]
    cases = [case("case-v1", ["rule-v1"]), case("case-v2", ["rule-v2"])]
    report = analyze_impact(changes, rules, cases)

    assert [r["ruleVersionId"] for r in report.affected_rules] == ["rule-v1"]
    assert report.affected_rules[0]["reason"] == "SOURCE_MODIFIED"
    assert [c["caseVersionId"] for c in report.affected_cases] == ["case-v1"]
    assert any("重新执行规则提取" in u for u in report.unresolved)


def test_uncertain_move_maps_to_ambiguous():
    """B 的 uncertain（原文移动/重复）→ C 的 ambiguous：不视为未变化。"""
    old = bundle("dv-old", [{"id": "s1", "line": 1, "text": "唯一条款文本"}])
    new = bundle("dv-new", [{"id": "s9", "line": 5, "text": "唯一条款文本"}])
    changes = adapt_source_changes(compare_bundles("d.md", old, new)["changes"])

    assert [c.kind for c in changes] == ["ambiguous"]
    report = analyze_impact(changes, [rule("rule-v1", "s1")], [case("case-v1", ["rule-v1"])])
    assert report.affected_rules[0]["reason"] == "SOURCE_AMBIGUOUS"
    assert any("不得视为未变化" in u for u in report.unresolved)


def test_quality_in_span_view_downgrades_to_unresolved():
    """质量在 B 的 span 视图内（非顶层）：LOW 修改不给确定性 reason。"""
    old = bundle("dv-old", [{"id": "s1", "line": 1, "text": "旧文"}])
    new = bundle("dv-new", [{"id": "s9", "line": 1, "text": "新文", "quality": "LOW"}])
    changes = adapt_source_changes(compare_bundles("d.md", old, new)["changes"])

    assert changes[0].kind == "modified"
    assert changes[0].quality == "LOW", "质量必须从 span 视图取到，否则降级逻辑失效"
    report = analyze_impact(changes, [rule("rule-v1", "s1")], [])
    assert report.affected_rules == []
    assert any("LOW/UNPARSED" in u for u in report.unresolved)


def test_duplicate_uncertain_without_new_side_is_accepted():
    """B 的「多处重复」uncertain 只有旧侧：ambiguous 允许缺 new。"""
    old = bundle("dv-old", [{"id": "s1", "line": 5, "text": "重复文本"}])
    new = bundle("dv-new", [
        {"id": "n1", "line": 2, "text": "重复文本"},
        {"id": "n2", "line": 9, "text": "重复文本"},
    ])
    changes = adapt_source_changes(compare_bundles("d.md", old, new)["changes"])

    ambiguous = [c for c in changes if c.kind == "ambiguous"]
    assert ambiguous and all(c.new is None for c in ambiguous)
    report = analyze_impact(changes, [rule("rule-v1", "s1")], [])
    assert report.affected_rules[0]["reason"] == "SOURCE_AMBIGUOUS"
