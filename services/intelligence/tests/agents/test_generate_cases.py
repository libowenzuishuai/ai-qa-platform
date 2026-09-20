"""用例生成管线测试（C 通道 T2）。

入口校验（只接受 APPROVED）必须在调用模型之前拒绝且零调用记录；
输出侧语义（引用范围/夹具/断言/覆盖完整性）复用公共 validate_cases。
"""

import asyncio

import pytest

from agent_fixtures import make_agent_context, ready_agent_pipelines, vector
from aiqa_intelligence.agents.prompts import build_case_generation_request
from aiqa_intelligence.contracts.generated import (
    CaseGenerationInput,
    CaseGenerationOutput,
)
from aiqa_intelligence.errors import ServiceError


def test_generate_cases_golden(case_vector, tmp_path):
    context, gateway = make_agent_context(tmp_path)
    input = CaseGenerationInput.model_validate(case_vector["input"])
    golden = CaseGenerationOutput.model_validate(case_vector["output"])

    request = build_case_generation_request(input)
    gateway.register_mock(request, case_vector["output"])

    output = asyncio.run(ready_agent_pipelines().generate_cases(input, context))

    assert output == golden
    assert request.outputSchema is not None
    assert '"approvedRuleVersions"' in request.user
    assert len(context.invocations) == 1
    assert context.invocations[0].purpose == "CASE_GENERATION"
    assert context.invocations[0].response.provider == "mock"


def test_generate_cases_rejects_unapproved_before_model(tmp_path):
    """评审修正 4：无效输入在调用模型之前拒绝，调用记录为零。"""
    bad = vector("case-unapproved-rule")
    context, _gateway = make_agent_context(tmp_path)
    input = CaseGenerationInput.model_validate(bad["input"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_agent_pipelines().generate_cases(input, context))

    assert exc_info.value.code == "MODEL_OUTPUT_INVALID"
    assert "APPROVED" in exc_info.value.message
    assert len(context.invocations) == 0


def test_generate_cases_rejects_foreign_rule(tmp_path):
    """输出引用输入之外的规则必须被拒（validate_cases 公共语义）。"""
    bad = vector("case-foreign-rule")
    context, gateway = make_agent_context(tmp_path)
    input = CaseGenerationInput.model_validate(bad["input"])

    request = build_case_generation_request(input)
    gateway.register_mock(request, bad["output"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_agent_pipelines().generate_cases(input, context))

    assert exc_info.value.code == "MODEL_OUTPUT_INVALID"
    assert "未批准" in exc_info.value.message


def test_generate_cases_rejects_missing_coverage(tmp_path):
    """覆盖表遗漏输入规则必须被拒——覆盖率不许把资料遗漏藏进去。"""
    bad = vector("case-missing-coverage")
    context, gateway = make_agent_context(tmp_path)
    input = CaseGenerationInput.model_validate(bad["input"])

    request = build_case_generation_request(input)
    gateway.register_mock(request, bad["output"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_agent_pipelines().generate_cases(input, context))

    assert exc_info.value.code == "MODEL_OUTPUT_INVALID"
    assert "覆盖" in exc_info.value.message
