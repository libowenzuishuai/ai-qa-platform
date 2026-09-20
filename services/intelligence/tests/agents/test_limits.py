"""长输入与解析状态门测试（C 通道 T4，评审修正 4/6）。

超限必须在调用模型之前拒绝（调用记录为零）、不静默截断；
NEEDS_OCR 是合法解析终态但下游提取明确拒绝；
PDF_SCANNED+PARSED（Kimi 整页识别产物）不因格式被拒。
"""

import asyncio
import copy

import pytest

from agent_fixtures import make_agent_context, ready_agent_pipelines, vector
from aiqa_intelligence.agents.prompts import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    build_case_generation_request,
    build_rule_extraction_request,
)
from aiqa_intelligence.contracts.generated import (
    CaseGenerationInput,
    RuleExtractionInput,
)
from aiqa_intelligence.errors import ServiceError


def test_over_limit_rejected_before_model(rule_vector, tmp_path):
    """规则提取：超长资料在调模型前拒绝，零调用记录。"""
    v = copy.deepcopy(rule_vector)
    v["input"]["documentVersions"][0]["blocks"].append(
        {"id": "blk-huge", "kind": "paragraph", "text": "长" * 200_000}
    )
    context, _gateway = make_agent_context(tmp_path)
    input = RuleExtractionInput.model_validate(v["input"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_agent_pipelines().extract_rules(input, context))

    assert exc_info.value.code == "VALIDATION_ERROR"
    assert "超限" in exc_info.value.message
    assert len(context.invocations) == 0


def test_over_limit_rejected_before_model_for_cases(case_vector, tmp_path):
    """用例生成：超长输入同样在调模型前拒绝。"""
    v = copy.deepcopy(case_vector)
    v["input"]["approvedRuleVersions"][0]["statement"] = "规则：" + "长" * 200_000
    context, _gateway = make_agent_context(tmp_path)
    input = CaseGenerationInput.model_validate(v["input"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_agent_pipelines().generate_cases(input, context))

    assert exc_info.value.code == "VALIDATION_ERROR"
    assert len(context.invocations) == 0


def test_needs_ocr_bundle_rejected(rule_vector, tmp_path):
    """NEEDS_OCR 是合法解析终态，但规则提取必须明确拒绝（NEEDS_OCR 错误码）。"""
    v = copy.deepcopy(rule_vector)
    bundle = v["input"]["documentVersions"][0]
    bundle["parseStatus"] = "NEEDS_OCR"
    bundle["format"] = "PDF_SCANNED"  # 满足 NEEDS_OCR 的格式约束
    context, _gateway = make_agent_context(tmp_path)
    input = RuleExtractionInput.model_validate(v["input"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_agent_pipelines().extract_rules(input, context))

    assert exc_info.value.code == "NEEDS_OCR"
    assert len(context.invocations) == 0


def test_pdf_scanned_parsed_is_accepted(rule_vector, tmp_path):
    """评审修正 6：Kimi 整页识别后的 PDF_SCANNED+PARSED 不因格式被拒。"""
    v = copy.deepcopy(rule_vector)
    v["input"]["documentVersions"][0]["format"] = "PDF_SCANNED"
    context, gateway = make_agent_context(tmp_path)
    input = RuleExtractionInput.model_validate(v["input"])

    request = build_rule_extraction_request(input)
    gateway.register_mock(request, v["output"])

    output = asyncio.run(ready_agent_pipelines().extract_rules(input, context))

    assert len(output.ruleDrafts) == len(v["output"]["ruleDrafts"])


def test_both_pipelines_set_max_output_tokens(rule_vector, case_vector):
    """评审修正 4：两条管线都显式设置 maxOutputTokens。"""
    r = build_rule_extraction_request(RuleExtractionInput.model_validate(rule_vector["input"]))
    c = build_case_generation_request(CaseGenerationInput.model_validate(case_vector["input"]))
    assert r.maxOutputTokens == DEFAULT_MAX_OUTPUT_TOKENS
    assert c.maxOutputTokens == DEFAULT_MAX_OUTPUT_TOKENS
