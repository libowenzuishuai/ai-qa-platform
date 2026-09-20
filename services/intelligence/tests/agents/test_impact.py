"""C3 影响分析骨架测试：交集闭包判定、规则传导、不扩大复核面、质量降级。

提案的可判定标准：受影响集合恰好等于「规则来源 ∩ 变更片段」的闭包
（再经 ruleVersionIds 传导到用例）——多一个少一个都算错。
"""

import json

import pytest

from aiqa_intelligence.agents.impact import (
    ImpactReport,
    SourceChange,
    adapt_source_changes,
    analyze_impact,
)
from aiqa_intelligence.contracts.generated import ApprovedRuleVersion, TestCase


def rule(rid: str, span_ids: list[str], doc: str = "doc-v1") -> ApprovedRuleVersion:
    return ApprovedRuleVersion.model_validate(
        {
            "id": rid, "ruleId": f"{rid}-root", "version": 1,
            "statement": "陈述", "classification": "EXPLICIT",
            "action": "操作", "expectation": "预期", "origin": "manual",
            "createdAt": "2026-09-20T00:00:00Z",
            "sources": [{"documentVersionId": doc, "sourceSpanIds": span_ids}],
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


RULES = [rule("rule-v1", ["span-1"]), rule("rule-v2", ["span-2"])]
CASES = [case("case-v1", ["rule-v1"]), case("case-v2", ["rule-v2"])]


def test_removed_span_affects_rule_and_case_by_closure():
    report = analyze_impact(
        [SourceChange(kind="removed", old=("doc-v1", "span-1"))], RULES, CASES
    )
    assert [r["ruleVersionId"] for r in report.affected_rules] == ["rule-v1"]
    assert report.affected_rules[0]["reason"] == "SOURCE_REMOVED"
    assert report.affected_rules[0]["evidenceRefs"] == [
        {"documentVersionId": "doc-v1", "spanId": "span-1"}
    ]
    # 用例经规则传导受影响；无交集的 rule-v2/case-v2 不得出现（不扩大复核面）
    assert [c["caseVersionId"] for c in report.affected_cases] == ["case-v1"]
    assert report.affected_cases[0]["viaRuleVersionIds"] == ["rule-v1"]


def test_modified_and_ambiguous_reasons():
    report = analyze_impact(
        [
            SourceChange(kind="modified", old=("doc-v1", "span-1"), new=("doc-v2", "span-1")),
        ],
        RULES,
        CASES,
    )
    assert report.affected_rules[0]["reason"] == "SOURCE_MODIFIED"
    assert len(report.affected_rules[0]["evidenceRefs"]) == 2  # 新旧两侧都给

    report = analyze_impact(
        [
            SourceChange(kind="ambiguous", old=("doc-v1", "span-1"), new=("doc-v2", "span-1"), note="段落疑似移动"),
        ],
        RULES,
        CASES,
    )
    assert report.affected_rules[0]["reason"] == "SOURCE_AMBIGUOUS"
    assert any("不得视为未变化" in u for u in report.unresolved)


def test_added_span_does_not_touch_existing_rules():
    """新增片段不与既有来源相交：不产生受影响资产，只提示重新提取。"""
    report = analyze_impact(
        [SourceChange(kind="added", new=("doc-v2", "span-new"))], RULES, CASES
    )
    assert report.affected_rules == []
    assert report.affected_cases == []
    assert any("重新执行规则提取" in u for u in report.unresolved)


def test_low_quality_change_goes_unresolved_not_deterministic():
    report = analyze_impact(
        [SourceChange(kind="modified", old=("doc-v1", "span-1"), new=("doc-v2", "span-1"), quality="LOW")],
        RULES,
        CASES,
    )
    assert report.affected_rules == [], "LOW 质量变化不给确定性 reason"
    assert any("LOW/UNPARSED" in u for u in report.unresolved)
    # 规则确有交集：虽无确定性结论，用例仍按待复核传导
    assert [c["caseVersionId"] for c in report.affected_cases] == ["case-v1"]


def test_shared_span_closes_over_both_rules():
    rules = [rule("rule-a", ["shared"]), rule("rule-b", ["shared"])]
    report = analyze_impact(
        [SourceChange(kind="removed", old=("doc-v1", "shared"))], rules, []
    )
    assert {r["ruleVersionId"] for r in report.affected_rules} == {"rule-a", "rule-b"}


def test_wire_shape_and_human_review_guarantee():
    report = analyze_impact(
        [SourceChange(kind="removed", old=("doc-v1", "span-1"))], RULES, CASES
    )
    wire = report.to_wire()
    assert set(wire) == {"affectedRules", "affectedCases", "unresolved", "requiresHumanReview"}
    assert wire["requiresHumanReview"] is True, "本模块只建议不批准，恒需人工复核"
    json.dumps(wire, ensure_ascii=False)  # 可直出


def test_adapt_layer_and_shape_guards():
    raw = [
        {"kind": "modified",
         "old": {"documentVersionId": "doc-v1", "spanId": "s1"},
         "new": {"documentVersionId": "doc-v2", "spanId": "s1"},
         "quality": "GOOD", "note": None},
    ]
    (change,) = adapt_source_changes(raw)
    assert change.old == ("doc-v1", "s1") and change.kind == "modified"

    with pytest.raises(ValueError):
        SourceChange(kind="added", old=("doc-v1", "s1"), new=("doc-v2", "s1"))
    with pytest.raises(ValueError):
        SourceChange(kind="modified", old=("doc-v1", "s1"))  # 缺新侧
    with pytest.raises(ValueError):
        SourceChange(kind="renamed")  # 未知类型
