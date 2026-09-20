"""三类业务样例的语义验收（C 通道 T3，评审第 2 条）。

mock 只证明请求构造、校验与调用记录接通（评审修正 3）；
这里的断言锁定 golden 本身的业务语义，作为后续真实模型评测的对照锚点。
"""

import asyncio

from agent_fixtures import make_agent_context, ready_agent_pipelines, vector
from aiqa_intelligence.contracts.generated import RuleExtractionInput


def run_extract(name: str, tmp_path):
    v = vector(name)
    context, gateway = make_agent_context(tmp_path)
    input = RuleExtractionInput.model_validate(v["input"])
    from aiqa_intelligence.agents.prompts import build_rule_extraction_request

    request = build_rule_extraction_request(input)
    gateway.register_mock(request, v["output"])
    output = asyncio.run(ready_agent_pipelines().extract_rules(input, context))
    return v, output


def test_conflict_prd_keeps_both_sides(tmp_path):
    """02：冲突双方各自保留、互指，澄清关联双方；没有第三条「调和版」。"""
    v, output = run_extract("02-conflict-prd", tmp_path)

    drafts = {d.key: d for d in output.ruleDrafts}
    assert len(drafts) == 2, "不得出现消解矛盾的第三条「调和版」规则"
    assert drafts["rule-draft-01"].conflictsWith == ["rule-draft-02"]
    assert drafts["rule-draft-02"].conflictsWith == ["rule-draft-01"]
    # 双方都是 EXPLICIT 且各带各的来源（互指不等于合并来源）
    for d in drafts.values():
        assert d.classification == "EXPLICIT"
        assert len(d.sources) == 1

    (clar,) = output.clarifications
    assert clar.kind == "CONFLICT"
    assert sorted(clar.ruleDraftKeys) == ["rule-draft-01", "rule-draft-02"]


def test_missing_boundary_stays_unknown_without_fabricated_value(tmp_path):
    """03：缺失的边界保持 UNKNOWN，那个边界值不得编造；资料里的其他数字不受影响。

    评审修正 3：负向断言只针对「资料缺失的那个边界值」（amountCents 的
    value），不禁止输出中存在其他合法数字。
    """
    v, output = run_extract("03-missing-boundary", tmp_path)

    drafts = {d.key: d for d in output.ruleDrafts}
    boundary = drafts["rule-draft-01"]
    assert boundary.classification == "UNKNOWN"
    # 缺失边界的 businessField 只能有 key/unit，不得出现编造的数值
    (field,) = boundary.businessFields
    assert field.key == "amountCents" and field.unit == "fen"
    assert field.value is None, "资料未给出的金额边界不得编造"

    # 资料中明确写出的规则照常 EXPLICIT（不因「缺边界」误伤其他数字）
    explicit = drafts["rule-draft-02"]
    assert explicit.classification == "EXPLICIT"

    (clar,) = output.clarifications
    assert clar.kind == "MISSING_INFO"
    assert clar.ruleDraftKeys == ["rule-draft-01"]
    assert "边界" in clar.question
