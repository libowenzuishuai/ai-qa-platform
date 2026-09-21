"""评测夹具口径测试（C3）：统计正确性、失败保留、阻塞分类、用量聚合。"""

import asyncio
import json
from pathlib import Path

from agent_fixtures import make_agent_context, vector
from aiqa_intelligence.agents.evaluation import evaluate_repeatability, pipeline_attempt
from aiqa_intelligence.agents.prompts import build_rule_extraction_request
from aiqa_intelligence.agents.service import AgentPipelines
from aiqa_intelligence.contracts.generated import RuleExtractionInput
from aiqa_intelligence.errors import ServiceError


def extract_journey_factory(tmp_path: Path, v: dict):
    """标准旅程：fixture 01 规则提取（mock golden，确定性通过）。"""

    async def factory():
        context, gateway = make_agent_context(tmp_path)
        input = RuleExtractionInput.model_validate(v["input"])
        gateway.register_mock(build_rule_extraction_request(input), v["output"])
        pipelines = AgentPipelines()
        pipelines.ready = True
        return await pipeline_attempt(pipelines.extract_rules, context, input, context)

    return factory


def test_repeatability_all_pass_and_report_shape(tmp_path):
    v = vector("01-explicit-prd")
    report = asyncio.run(
        evaluate_repeatability({"规则提取-明确阈值": extract_journey_factory(tmp_path, v)}, rounds=3)
    )

    assert report["rounds"] == 3
    (journey,) = report["journeys"]
    assert journey["passRate"] == 1.0
    assert len(journey["attempts"]) == 3
    assert journey["semanticErrors"] == 0
    assert journey["blockedReasons"] == []
    assert journey["firstFailureKept"] is True
    assert all(a["ok"] for a in journey["attempts"])
    # JSON 可直出（进 docs/delivery/evidence）
    json.dumps(report, ensure_ascii=False)


def test_first_failure_kept_with_flaky_journey(tmp_path):
    """首次失败必须保留，重试通过不得覆盖；语义错误单列。"""
    state = {"calls": 0}

    async def flaky():
        state["calls"] += 1
        if state["calls"] == 1:
            return {
                "ok": False,
                "errorCode": "MODEL_OUTPUT_INVALID",
                "errorMessage": "首次失败",
                "durationMs": 5,
                "usage": [{"provider": "mock", "inputTokens": 10, "outputTokens": 5}],
            }
        return {
            "ok": True,
            "errorCode": None,
            "errorMessage": None,
            "durationMs": 4,
            "usage": [{"provider": "mock", "inputTokens": 10, "outputTokens": 5}],
        }

    report = asyncio.run(evaluate_repeatability({"不稳定旅程": flaky}, rounds=3))

    (journey,) = report["journeys"]
    assert journey["passRate"] == 2 / 3
    assert journey["attempts"][0]["ok"] is False, "首次失败不得被重试成功覆盖"
    assert journey["semanticErrors"] == 1
    assert journey["totalUsage"] == {"inputTokens": 30, "outputTokens": 15}


def test_blocked_reasons_classified(tmp_path):
    async def blocked():
        return {
            "ok": False,
            "errorCode": "NEEDS_OCR",
            "errorMessage": "文档需要 OCR",
            "durationMs": 3,
            "usage": [],
            "manualIntervention": "人工补扫清晰版",
        }

    report = asyncio.run(evaluate_repeatability({"阻塞旅程": blocked}, rounds=2))

    (journey,) = report["journeys"]
    assert journey["passRate"] == 0.0
    assert journey["blockedReasons"] == ["NEEDS_OCR"]
    assert journey["semanticErrors"] == 0, "阻塞不是语义错误，不混入模型质量口径"
    assert journey["manualInterventions"] == 2


def test_pipeline_attempt_records_service_error(tmp_path):
    """pipeline_attempt 包装：ServiceError 转记录不抛出，失败用量保留。"""
    v = vector("01-explicit-prd")

    async def failing(input, context):
        # 先成功调用一次（记录用量），再在校验层抛语义错误——失败也保留已烧用量
        await context.models.complete_text(build_rule_extraction_request(input))
        raise ServiceError("MODEL_OUTPUT_INVALID", "校验拒绝")

    context, gateway = make_agent_context(tmp_path)
    input = RuleExtractionInput.model_validate(v["input"])
    gateway.register_mock(build_rule_extraction_request(input), v["output"])
    record = asyncio.run(pipeline_attempt(failing, context, input, context))

    assert record["ok"] is False
    assert record["errorCode"] == "MODEL_OUTPUT_INVALID"
    assert record["usage"] and record["usage"][0]["provider"] == "mock"


def test_reused_context_does_not_double_count_previous_invocations(tmp_path):
    v=vector('01-explicit-prd')
    context,gateway=make_agent_context(tmp_path)
    input=RuleExtractionInput.model_validate(v['input'])
    gateway.register_mock(build_rule_extraction_request(input),v['output'])
    async def call():
        await context.models.complete_text(build_rule_extraction_request(input))
    async def run():
        a=await pipeline_attempt(call,context)
        b=await pipeline_attempt(call,context)
        assert len(a['usage'])==len(b['usage'])==1
    asyncio.run(run())


def test_invalid_rounds_rejected_before_calls():
    import pytest
    async def no_call():
        raise AssertionError('must not call')
    for rounds in (0,-1,True,1.5,101):
        with pytest.raises(ValueError):
            asyncio.run(evaluate_repeatability({'x':no_call},rounds))
