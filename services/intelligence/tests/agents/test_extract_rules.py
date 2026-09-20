"""第一个纵向切片：fixture 01（明确阈值 PRD）→ extract_rules → golden。

mock 协议：测试与管线共用 build_rule_extraction_request 构造完全相同的
TextModelRequest，register_mock 按 mock_key 精确命中；未注册的输入必须失败
（Gateway「查表未命中即错」，禁止现编——handoff §4 C 验收第 6 条的 mock 侧）。
"""

import asyncio
import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from aiqa_intelligence.agents.prompts import (
    build_rule_extraction_request,
    rule_extraction_output_schema,
)
from aiqa_intelligence.agents.service import AgentPipelines
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import (
    RuleExtractionInput,
    RuleExtractionOutput,
)
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

_VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "packages"
        / "contracts"
        / "fixtures"
        / "intelligence-conformance.json"
    ).read_text()
)


def vector(name: str) -> dict:
    return next(v for v in _VECTORS if v["name"] == name)


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
    # T1：输出 Schema 随请求传入（网关追加进 system 并做 Draft7 结构校验）
    assert request.outputSchema is not None
    # 提示词来源可见：正文与 span 都进了 user 内容（camelCase 契约字段名）
    assert '"sourceSpans"' in request.user
    assert '"blocks"' in request.user
    # 调用记录可审计：provider=mock、purpose 正确（验收第 6 条的基础）
    assert len(context.invocations) == 1
    assert context.invocations[0].purpose == "RULE_EXTRACTION"
    assert context.invocations[0].response.provider == "mock"
    assert context.invocations[0].response.outcome == "SUCCESS"


def test_output_schema_is_self_contained_and_selective():
    """评审修正 1：携带本地 definitions 即可解析 $ref；只带闭包子集；不硬编码数量。"""
    schema = rule_extraction_output_schema()

    # 引用闭合：schema 内出现的每个 "#/definitions/X" 都在携带的 definitions 里
    # （$ref 可能指向定义内部路径，取第一段才是定义名）
    refs = json.dumps(schema).split('"#/definitions/')[1:]
    targets = {r.split('"')[0].split("/")[0] for r in refs}
    assert targets <= set(schema["definitions"])

    # 选择性：不带无关定义（控制提示词长度），也不硬编码总数
    assert "CaseGenerationInput" not in schema["definitions"]
    assert "DocumentParseRequest" not in schema["definitions"]

    # 能独立校验正例：golden 通过
    golden = vector("01-explicit-prd")["output"]
    Draft7Validator(schema).validate(golden)
    # 能独立拒绝结构反例：缺必填 ruleDrafts
    with pytest.raises(Exception):
        Draft7Validator(schema).validate(
            {"clarifications": [], "unparsedRanges": []}
        )


def test_extract_rules_rejects_semantic_negative(tmp_path):
    """评审修正 2：管线直调公共 validate_rules——编造 span 引用必须被拒。"""
    bad = vector("invented-span")
    context, gateway = make_context(tmp_path)
    input = RuleExtractionInput.model_validate(bad["input"])

    request = build_rule_extraction_request(input)
    gateway.register_mock(request, bad["output"])

    with pytest.raises(ServiceError) as exc_info:
        asyncio.run(ready_pipelines().extract_rules(input, context))

    assert exc_info.value.code == "MODEL_OUTPUT_INVALID"
    assert "片段" in exc_info.value.message


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
