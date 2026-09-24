"""W04 loop-planner（loop-planner-v1）：版本固定、缺断言拒绝、done 护栏。"""
import asyncio
from pathlib import Path

import pytest

from aiqa_intelligence.agents.loop_planner import build_request, plan_next
from aiqa_intelligence.contracts import generated as m
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

Output = m.LoopPlannerResponse.model_fields["output"].annotation
Input = m.LoopPlannerRequest.model_fields["input"].annotation


def base_input():
    return {
        "goal": "创建草稿→改名→刷新仍保留名称",
        "oracleAssertions": [{
            "observationType": "api_field", "observationRef": "draft.title",
            "operator": "equals", "expected": "验收目标名称",
        }],
        "observation": {"renamePath": "/api/drafts/:id/rename", "draft": None},
        "contextManifestId": None,
        "contextExcerpt": [],
        "promptVersion": "loop-planner-v1",
    }


def run(tmp_path, data, answer):
    reader = ArtifactReader(tmp_path)
    records = []
    gateway = Gateway("mock", reader, "loop-planner-v1", records)
    gateway.register_mock(build_request(data), answer)
    return asyncio.run(plan_next(Input.model_validate(data), RequestContext("t", "mock", reader, gateway, records)))


def test_version_pinned_and_missing_oracle_rejected():
    bad = base_input()
    bad["promptVersion"] = "loop-planner-v0"
    with pytest.raises(ServiceError, match="版本"):
        build_request(bad)
    no_oracle = base_input()
    no_oracle["oracleAssertions"] = []
    with pytest.raises(ServiceError, match="断言"):
        build_request(no_oracle)


def test_no_draft_proposes_create(tmp_path):
    result = run(tmp_path, base_input(), {"action": "create_draft", "rationale": "无草稿", "params": {}})
    assert result.action == "create_draft"


def test_done_with_mismatched_observation_rejected(tmp_path):
    data = base_input()
    data["observation"] = {"renamePath": "/api/drafts/:id/rename", "draft": {"id": "draft-1", "title": "初始草稿"}}
    with pytest.raises(ServiceError, match="不得提议 done"):
        run(tmp_path, data, {"action": "done", "rationale": "看起来好了", "params": {}})


def test_rename_title_must_equal_oracle_expected(tmp_path):
    data = base_input()
    data["observation"] = {"renamePath": "/api/drafts/:id/rename", "draft": {"id": "draft-1", "title": "初始草稿"}}
    # 服务端护栏在 TS 循环侧（title≠expected 拒绝）；Python 侧验证合法 rename 通过。
    result = run(tmp_path, data, {"action": "rename_draft", "rationale": "标题不符，按标准改名", "params": {"title": "验收目标名称"}})
    assert result.action == "rename_draft"
    assert result.params.title == "验收目标名称"
