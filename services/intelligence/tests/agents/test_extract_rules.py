"""第一个纵向切片：fixture 01（明确阈值 PRD）→ extract_rules → golden。

mock 协议：测试与管线共用 build_rule_extraction_request 构造完全相同的
TextModelRequest，register_mock 按 mock_key 精确命中；未注册的输入必须失败
（Gateway「查表未命中即错」，禁止现编——handoff §4 C 验收第 6 条的 mock 侧）。
"""

import asyncio
from pathlib import Path

import pytest

from aiqa_intelligence.agents.prompts import build_rule_extraction_request
from aiqa_intelligence.agents.service import AgentPipelines
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import (
    RuleExtractionInput,
    RuleExtractionOutput,
)
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader


def make_context(tmp_path: Path) -> tuple[RequestContext, Gateway]:
    """mock 网关 + 空调用记录，不触网络、不碰数据库。"""
    records = []
    gateway = Gateway(
        mode="mock",
        artifacts=ArtifactReader(tmp_path),
        prompt_version="handoff-1",
        records=records,
        mock_entries={},
    )
    context = RequestContext(
        request_id="req-agents-test",
        mode="mock",
        artifacts=gateway.artifacts,
        models=gateway,
        invocations=records,
    )
    return context, gateway


def ready_pipelines() -> AgentPipelines:
    """实例级 ready=True：类默认 False 是对 HTTP 层的诚实 503，
    测试打开真实管线驱动验收（handoff §1：模块未完成不生成假成功）。"""
    pipelines = AgentPipelines()
    pipelines.ready = True
    return pipelines


def test_extract_rules_fixture01_matches_golden(rule_vector, tmp_path):
    context, gateway = make_context(tmp_path)
    input = RuleExtractionInput.model_validate(rule_vector["input"])
    golden = RuleExtractionOutput.model_validate(rule_vector["output"])

    request = build_rule_extraction_request(input)
    gateway.register_mock(request, rule_vector["output"])

    output = asyncio.run(ready_pipelines().extract_rules(input, context))

    assert output == golden
    # 提示词来源可见：正文与 span 都进了 user 内容（camelCase 契约字段名）
    assert '"sourceSpans"' in request.user
    assert '"blocks"' in request.user
    # 调用记录可审计：provider=mock、purpose 正确（验收第 6 条的基础）
    assert len(context.invocations) == 1
    assert context.invocations[0].purpose == "RULE_EXTRACTION"
    assert context.invocations[0].response.provider == "mock"
    assert context.invocations[0].response.outcome == "SUCCESS"


def test_extract_rules_mock_miss_fails(rule_vector, tmp_path):
    """未注册 mock 的输入必须失败，不许网关现编响应。"""
    context, _gateway = make_context(tmp_path)
    input = RuleExtractionInput.model_validate(rule_vector["input"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_pipelines().extract_rules(input, context))

    assert exc_info.value.code == "MODEL_OUTPUT_INVALID"


def test_extract_rules_rejects_invalid_model_output(rule_vector, tmp_path):
    """模型输出不合契约（缺 ruleDrafts）必须以 MODEL_OUTPUT_INVALID 拒绝，不放行。"""
    context, gateway = make_context(tmp_path)
    input = RuleExtractionInput.model_validate(rule_vector["input"])

    request = build_rule_extraction_request(input)
    gateway.register_mock(request, {"clarifications": [], "unparsedRanges": []})

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_pipelines().extract_rules(input, context))

    assert exc_info.value.code == "MODEL_OUTPUT_INVALID"
