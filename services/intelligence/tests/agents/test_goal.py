"""R08 目标规划 agent：只建议目录内工具；无资料必须 blocker；环境缺失禁用需环境能力。"""
import asyncio
from pathlib import Path

import pytest

from aiqa_intelligence.agents.goal import build_goal_request, propose_goal
from aiqa_intelligence.contracts import generated as _generated
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

# 匿名 Input/Output 模型经 wire 注解取用（生成器为嵌套类型去重命名）。
GoalProposalAgentInput = _generated.GoalProposalAgentRequest.model_fields["input"].annotation


def capabilities():
    return [
        {'key': 'doc-parse', 'name': '文档解析', 'effects': ['READ'], 'requiresEnvironment': False, 'budgetCategory': 'none'},
        {'key': 'rule-extract', 'name': '规则提取', 'effects': ['READ'], 'requiresEnvironment': False, 'budgetCategory': 'model'},
        {'key': 'web-observe', 'name': '页面观察', 'effects': ['READ'], 'requiresEnvironment': True, 'budgetCategory': 'browser'},
        {'key': 'code-check', 'name': '工程体检', 'effects': ['READ'], 'requiresEnvironment': False, 'budgetCategory': 'compute'},
    ]


def wire(*, has_documents=True, environment=True):
    return {
        'goal': '验证采购系统 v1 的审批需求',
        'capabilities': capabilities(),
        'hasDocuments': has_documents,
        'environmentConfigured': environment,
        'promptVersion': 'goal-v1',
    }


def answer(**over):
    out = {
        'suggestedTools': [{'capabilityKey': 'rule-extract', 'reason': '从 PRD 提取审批规则'}],
        'suggestedBudget': {'maxModelCalls': 20},
        'blockers': [],
        'rationale': '已有解析文档，先提取规则再生成用例。',
    }
    out.update(over)
    return out


def run(tmp_path, data, reply):
    reader = ArtifactReader(tmp_path)
    records = []
    gateway = Gateway('mock', reader, 'goal-v1', records)
    gateway.register_mock(build_goal_request(data), reply)
    return asyncio.run(
        propose_goal(
            GoalProposalAgentInput.model_validate(data),
            RequestContext('test', 'mock', reader, gateway, records),
        )
    )


def test_proposal_from_catalog_and_budget():
    req = build_goal_request(wire())
    assert req.purpose == 'GOAL_PROPOSAL'
    assert '不得发明' in req.system
    result = run(Path('/tmp/aiqa-goal-test'), wire(), answer())
    assert result.suggestedTools[0].capabilityKey == 'rule-extract'
    assert result.suggestedBudget.maxModelCalls == 20


def test_unknown_tool_rejected(tmp_path):
    with pytest.raises(ServiceError, match='目录外工具'):
        run(tmp_path, wire(), answer(suggestedTools=[{'capabilityKey': 'ghost', 'reason': 'x'}]))


def test_environment_required_capability_rejected_without_environment(tmp_path):
    with pytest.raises(ServiceError, match='需要环境'):
        run(tmp_path, wire(environment=False), answer(suggestedTools=[{'capabilityKey': 'web-observe', 'reason': '观察页面'}]))


def test_no_documents_must_declare_missing_data(tmp_path):
    with pytest.raises(ServiceError, match='伪业务标准'):
        run(tmp_path, wire(has_documents=False), answer())
    ok = run(
        tmp_path,
        wire(has_documents=False),
        answer(
            suggestedTools=[{'capabilityKey': 'code-check', 'reason': '无资料时只能做工程体检'}],
            blockers=[{'kind': 'MISSING_DATA', 'description': '缺少业务 PRD'}],
        ),
    )
    assert ok.blockers[0].kind == 'MISSING_DATA'


def test_empty_catalog_rejected_before_model(tmp_path):
    data = wire()
    data['capabilities'] = []
    with pytest.raises(ServiceError, match='能力目录为空'):
        build_goal_request(data)


def test_prompt_version_pinned():
    data = wire()
    data['promptVersion'] = 'goal-v0'
    with pytest.raises(ServiceError, match='版本'):
        build_goal_request(data)
