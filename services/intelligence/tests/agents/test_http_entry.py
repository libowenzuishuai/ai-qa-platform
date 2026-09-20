"""HTTP 正式入口测试（C 通道 T5，评审修正 5）。

- 功能层可用注入 ready 实例 + 预注册 mock 网关工厂走真实 HTTP；
- 超时用真实等待超过期限的测试确认请求被取消（app 层 asyncio.wait_for）；
- 最终验收门：默认实例 AgentPipelines() 必须经两个正式入口成功，
  不得依赖手动把实例设为 ready=True——该测试在类级 ready=True 前保持
  xfail(strict)，翻转后 XPASS 会红，强制移除标记（T6）。
"""

import asyncio
import copy

import pytest
from fastapi.testclient import TestClient

from agent_fixtures import ready_agent_pipelines, vector
from aiqa_intelligence.agents.prompts import (
    build_case_generation_request,
    build_rule_extraction_request,
)
from aiqa_intelligence.agents.service import AgentPipelines
from aiqa_intelligence.app import create_app
from aiqa_intelligence.contracts.generated import (
    CaseGenerationInput,
    RuleExtractionInput,
)
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

TOKEN = "agents-http-test"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def mock_gateway_factory(entries: dict):
    def factory(mode, artifacts, prompt_version, records):
        return Gateway(mode, artifacts, prompt_version, records, mock_entries=entries)

    return factory


def registered_entries(tmp_path, kind: str, v: dict) -> dict:
    """预注册 mock：与管线同一构造器构造请求，保证 mock_key 命中。"""
    gateway = Gateway(
        "mock", ArtifactReader(tmp_path), "handoff-1", [], mock_entries={}
    )
    if kind == "rules":
        request = build_rule_extraction_request(
            RuleExtractionInput.model_validate(v["input"])
        )
    else:
        request = build_case_generation_request(
            CaseGenerationInput.model_validate(v["input"])
        )
    gateway.register_mock(request, v["output"])
    return gateway.mock_entries


def post(client, path, v, **overrides):
    body = {
        "schemaVersion": "1.0",
        "requestId": "req-http-1",
        "mode": "mock",
        "timeoutMs": 120_000,
        "input": v["input"],
    }
    body.update(overrides)
    return client.post(f"/v1/{path}", headers=HEADERS, json=body)


def test_rules_entry_over_http(tmp_path):
    v = vector("01-explicit-prd")
    entries = registered_entries(tmp_path, "rules", v)
    app = create_app(
        token=TOKEN,
        agents=ready_agent_pipelines(),
        gateway_factory=mock_gateway_factory(entries),
    )
    with TestClient(app) as client:
        res = post(client, "rules/extract", v)

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["requestId"] == "req-http-1"
    assert body["mode"] == "mock"
    assert len(body["output"]["ruleDrafts"]) == len(v["output"]["ruleDrafts"])
    assert body["invocations"][0]["purpose"] == "RULE_EXTRACTION"
    assert body["invocations"][0]["response"]["provider"] == "mock"


def test_cases_entry_over_http(tmp_path):
    v = vector("case-valid")
    entries = registered_entries(tmp_path, "cases", v)
    app = create_app(
        token=TOKEN,
        agents=ready_agent_pipelines(),
        gateway_factory=mock_gateway_factory(entries),
    )
    with TestClient(app) as client:
        res = post(client, "cases/generate", v)

    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["output"]["caseDrafts"]) == len(v["output"]["caseDrafts"])
    assert body["invocations"][0]["purpose"] == "CASE_GENERATION"


def test_needs_ocr_rejected_over_http(tmp_path):
    v = copy.deepcopy(vector("01-explicit-prd"))
    bundle = v["input"]["documentVersions"][0]
    bundle["parseStatus"] = "NEEDS_OCR"
    bundle["format"] = "PDF_SCANNED"
    app = create_app(
        token=TOKEN,
        agents=ready_agent_pipelines(),
        gateway_factory=mock_gateway_factory({}),
    )
    with TestClient(app) as client:
        res = post(client, "rules/extract", v)

    assert res.status_code == 422
    assert res.json()["code"] == "NEEDS_OCR"


def test_over_limit_rejected_over_http(tmp_path):
    v = copy.deepcopy(vector("01-explicit-prd"))
    v["input"]["documentVersions"][0]["blocks"].append(
        {"id": "blk-huge", "kind": "paragraph", "text": "长" * 200_000}
    )
    app = create_app(
        token=TOKEN,
        agents=ready_agent_pipelines(),
        gateway_factory=mock_gateway_factory({}),
    )
    with TestClient(app) as client:
        res = post(client, "rules/extract", v)

    assert res.status_code == 422
    assert res.json()["code"] == "VALIDATION_ERROR"
    assert "超限" in res.json()["message"]


class SlowAgents(AgentPipelines):
    """真实超时：extract_rules 睡 1.5s，请求 timeoutMs=1000ms（请求层下限）。"""

    def __init__(self):
        super().__init__()
        self.cancelled = False

    async def extract_rules(self, input, context):
        try:
            await asyncio.sleep(1.5)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        raise AssertionError("不应执行到返回")


def test_timeout_actually_cancels_request(tmp_path):
    """评审修正 5：实际等待超过期限 → 504 MODEL_TIMEOUT，且任务被取消。"""
    slow = SlowAgents()
    v = vector("01-explicit-prd")
    app = create_app(token=TOKEN, agents=slow, gateway_factory=mock_gateway_factory({}))
    with TestClient(app) as client:
        res = post(client, "rules/extract", v, timeoutMs=1_000)

    assert res.status_code == 504
    assert res.json()["code"] == "MODEL_TIMEOUT"
    assert slow.cancelled is True, "wait_for 必须真正取消执行中的任务"


def test_default_instance_final_acceptance(tmp_path):
    """最终验收（评审修正 5）：默认实例 AgentPipelines() → 两个正式入口成功。

    T6 已翻类级 ready=True（验收门曾以 xfail(strict) 挂起），本测试是
    常驻验收：任何人把 ready 改回 False 或破坏默认路径都会在此变红。
    """
    rules_v = vector("01-explicit-prd")
    cases_v = vector("case-valid")
    rules_entries = registered_entries(tmp_path, "rules", rules_v)
    cases_entries = registered_entries(tmp_path, "cases", cases_v)
    entries = {**rules_entries, **cases_entries}
    app = create_app(
        token=TOKEN,
        agents=AgentPipelines(),
        gateway_factory=mock_gateway_factory(entries),
    )
    with TestClient(app) as client:
        rules_res = post(client, "rules/extract", rules_v)
        cases_res = post(client, "cases/generate", cases_v)

    assert rules_res.status_code == 200, rules_res.text
    assert cases_res.status_code == 200, cases_res.text
