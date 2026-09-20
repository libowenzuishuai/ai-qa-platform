"""共享契约样例全量遍历（C 通道 T5，评审修正 5）。

按 valid 字段自动遍历全部向量（不写死数量，新增样例自动纳入）：
正例必须走通完整管线（mock golden + 公共语义校验），
反例必须在某一层被拒（入口门/结构/语义）。
"""

import asyncio

import pytest

from agent_fixtures import VECTORS, make_agent_context, ready_agent_pipelines
from aiqa_intelligence.agents.prompts import (
    build_case_generation_request,
    build_rule_extraction_request,
)
from aiqa_intelligence.contracts.generated import (
    CaseGenerationInput,
    RuleExtractionInput,
)
from aiqa_intelligence.errors import ServiceError

RULES_VECTORS = [v for v in VECTORS if v["kind"] == "rules"]
CASES_VECTORS = [v for v in VECTORS if v["kind"] == "cases"]


@pytest.mark.parametrize("v", RULES_VECTORS, ids=lambda v: v["name"])
def test_rules_pipeline_sweep(v, tmp_path):
    context, gateway = make_agent_context(tmp_path)
    input = RuleExtractionInput.model_validate(v["input"])
    request = build_rule_extraction_request(input)
    gateway.register_mock(request, v["output"])

    if v["valid"]:
        output = asyncio.run(ready_agent_pipelines().extract_rules(input, context))
        assert len(output.ruleDrafts) == len(v["output"]["ruleDrafts"])
    else:
        with pytest.raises(ServiceError):
            asyncio.run(ready_agent_pipelines().extract_rules(input, context))


@pytest.mark.parametrize("v", CASES_VECTORS, ids=lambda v: v["name"])
def test_cases_pipeline_sweep(v, tmp_path):
    context, gateway = make_agent_context(tmp_path)
    input = CaseGenerationInput.model_validate(v["input"])
    request = build_case_generation_request(input)
    gateway.register_mock(request, v["output"])

    if v["valid"]:
        output = asyncio.run(ready_agent_pipelines().generate_cases(input, context))
        assert len(output.caseDrafts) == len(v["output"]["caseDrafts"])
    else:
        with pytest.raises(ServiceError):
            asyncio.run(ready_agent_pipelines().generate_cases(input, context))
