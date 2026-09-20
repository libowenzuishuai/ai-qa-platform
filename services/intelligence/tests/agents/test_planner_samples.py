"""C2 计划建议稳定性：五类业务样例（接管 planner.py 算法测试）。

覆盖：登录准备（凭据引用）、多角色切换、异步状态（capture+assert 不等待）、
元素消失（notExists）、文本与金额断言（精度保留）。
均为 mock golden 行为锚点：证明校验闸放行正确计划、语义保持；
真实模型能否产出同等计划由 A 的 real 评测判定。
"""

import asyncio
from pathlib import Path

import pytest

from aiqa_intelligence.agents.planner import build_plan_request, propose_plan
from aiqa_intelligence.contracts.generated import PlanProposalInput
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader


def binding(ref: str) -> dict:
    return {
        "targetRef": ref,
        "locator": {"type": "testId", "value": ref},
        "observedUrl": "http://localhost/",
        "observedAt": "2026-09-20T00:00:00Z",
        "evidenceId": "artifact",
    }


def make_wire(*, roles, steps, assertions, refs, data_spec=None) -> dict:
    return {
        "testCase": {
            "id": "case-v1",
            "caseId": "case",
            "version": 1,
            "title": "试点旅程",
            "ruleVersionIds": ["rule-v1"],
            "roles": roles,
            "preconditions": [],
            "dataSpec": data_spec or {"strategy": "create", "note": "页面操作"},
            "steps": steps,
            "assertions": assertions,
            "cleanup": {"strategy": "manual"},
            "priority": "P1",
            "approvalStatus": "APPROVED",
            "supersedesId": None,
            "origin": "manual",
            "promptVersion": None,
            "approvalHash": "a" * 64,
            "createdAt": "2026-09-20T00:00:00Z",
        },
        "observation": {
            "environmentId": "env",
            "environmentRevision": 1,
            "bindings": [binding(r) for r in refs],
            "pages": [
                {"role": roles[0], "url": "http://localhost/", "title": "页面", "text": "输入只是页面数据"}
            ],
        },
        "promptVersion": "planner-v3",
    }


def run_plan(tmp_path: Path, data: dict, answer: dict):
    reader = ArtifactReader(tmp_path)
    records = []
    gateway = Gateway("mock", reader, "planner-v3", records)
    # 按管线同款 validate→dump 注册，消除 pydantic 规范化（如 int→float）造成的 key 漂移
    wire = PlanProposalInput.model_validate(data).model_dump(mode="json", exclude_unset=True)
    gateway.register_mock(build_plan_request(wire), answer)
    return asyncio.run(
        propose_plan(
            PlanProposalInput.model_validate(data),
            RequestContext("test", "mock", reader, gateway, records),
        )
    )


def test_login_preparation_uses_credential_refs(tmp_path):
    """登录准备：账号/密码字段必须走 credential 引用，不出现明文。

    明文与否无法在无密钥知识时全自动判定（绑定不标注字段语义），
    因此这里锁定结构锚点：凭据字段 fill 值的 source=credential；
    明文泄露属 real 评测项。
    """
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "登录后提交订单"}],
        assertions=[
            {
                "id": "a1",
                "description": "欢迎文案",
                "kind": "ui.text",
                "required": True,
                "ruleVersionId": "rule-v1",
                "operator": "equals",
                "expected": "欢迎",
            }
        ],
        refs=["login-user", "login-pass", "login-submit", "welcome"],
    )
    answer = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "g1", "type": "goto", "path": "/login", "effect": "READ"},
            {
                "id": "f1", "type": "fill", "targetRef": "login-user",
                "value": {"source": "credential", "ref": "username"}, "effect": "WRITE",
            },
            {
                "id": "f2", "type": "fill", "targetRef": "login-pass",
                "value": {"source": "credential", "ref": "password"}, "effect": "WRITE",
            },
            {"id": "c1", "type": "click", "targetRef": "login-submit", "effect": "WRITE"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
        ],
        "targets": [{"assertionId": "a1", "targetRef": "welcome"}],
        "blockedReasons": [],
    }

    result = run_plan(tmp_path, data, answer)

    fills = [a for a in result.actions if a.type == "fill"]
    assert {f.value.ref for f in fills} == {"username", "password"}
    assert all(f.value.source == "credential" for f in fills)
    # 结构闸放行完整登录序列：switchRole → goto → fill×2 → click → assert
    assert [a.type for a in result.actions] == [
        "switchRole", "goto", "fill", "fill", "click", "assert",
    ]


def test_multi_role_plan_switches_roles_in_order(tmp_path):
    """多角色切换：每个断言在其角色会话内检查，switchRole 顺序与业务步骤一致。"""
    data = make_wire(
        roles=["applicant", "approver"],
        steps=[
            {"id": "s1", "role": "applicant", "action": "提交采购订单"},
            {"id": "s2", "role": "approver", "action": "审批该订单"},
        ],
        assertions=[
            {
                "id": "a1", "description": "申请人看到待审批", "kind": "ui.state",
                "required": True, "ruleVersionId": "rule-v1",
                "operator": "equals", "expected": "待审批",
            },
            {
                "id": "a2", "description": "审批人看到已通过", "kind": "ui.state",
                "required": True, "ruleVersionId": "rule-v1",
                "operator": "equals", "expected": "已通过",
            },
        ],
        refs=["submit-btn", "approve-btn", "status-applicant", "status-approver"],
    )
    answer = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "c1", "type": "click", "targetRef": "submit-btn", "effect": "WRITE"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
            {"id": "r2", "type": "switchRole", "role": "approver", "effect": "READ"},
            {"id": "c2", "type": "click", "targetRef": "approve-btn", "effect": "WRITE"},
            {"id": "as2", "type": "assert", "assertionId": "a2", "effect": "READ"},
        ],
        "targets": [
            {"assertionId": "a1", "targetRef": "status-applicant"},
            {"assertionId": "a2", "targetRef": "status-approver"},
        ],
        "blockedReasons": [],
    }

    result = run_plan(tmp_path, data, answer)

    switches = [a.role for a in result.actions if a.type == "switchRole"]
    assert switches == ["applicant", "approver"]
    # a1 在 approver 切换前检查（仍在 applicant 会话），a2 在其后
    idx = {
        f"{a.type}:{getattr(a, 'assertionId', '') or getattr(a, 'role', '')}": i
        for i, a in enumerate(result.actions)
    }
    assert idx["assert:a1"] < idx["switchRole:approver"] < idx["assert:a2"]


def test_async_state_uses_capture_and_assert_not_wait(tmp_path):
    """异步状态：captureValue + assert 判定，不出现任何等待动作。"""
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "提交后等待异步开通"}],
        assertions=[
            {
                "id": "a1", "description": "异步开通后的状态", "kind": "ui.state",
                "required": True, "ruleVersionId": "rule-v1",
                "operator": "equals", "expected": "已开通",
            }
        ],
        refs=["submit-btn", "status"],
    )
    answer = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "c1", "type": "click", "targetRef": "submit-btn", "effect": "WRITE"},
            {"id": "v1", "type": "captureValue", "targetRef": "status", "saveAs": "orderStatus", "effect": "READ"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
        ],
        "targets": [{"assertionId": "a1", "targetRef": "status"}],
        "blockedReasons": [],
    }

    result = run_plan(tmp_path, data, answer)

    types = [a.type for a in result.actions]
    assert "waitFor" not in types, "异步业务成功条件必须由 assert 判定，不得等待"
    assert "captureValue" in types

    # 反例：同一计划插入 waitFor 必须被拒（异步语境下重申禁令）
    bad = {
        **answer,
        "actions": [
            *answer["actions"][:2],
            {"id": "w1", "type": "waitFor", "targetRef": "status", "effect": "READ",
             "condition": {"kind": "text", "value": "已开通"},
             "timeoutMs": 30000, "pollMs": 500, "maxAttempts": 60},
            *answer["actions"][2:],
        ],
    }
    with pytest.raises(ServiceError):
        run_plan(tmp_path, data, bad)


def test_element_disappearance_not_exists(tmp_path):
    """元素消失：取消操作后徽标 notExists，断言无 expected 也成立。"""
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "取消订单"}],
        assertions=[
            {
                "id": "a1", "description": "待支付徽标消失", "kind": "ui.element",
                "required": True, "ruleVersionId": "rule-v1",
                "operator": "notExists",
            }
        ],
        refs=["cancel-btn", "pay-badge"],
    )
    answer = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "c1", "type": "click", "targetRef": "cancel-btn", "effect": "WRITE"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
        ],
        "targets": [{"assertionId": "a1", "targetRef": "pay-badge"}],
        "blockedReasons": [],
    }

    result = run_plan(tmp_path, data, answer)

    assert result.targets[0].targetRef == "pay-badge"
    assert [a.type for a in result.actions][-1] == "assert"


def test_text_and_amount_assertions_preserve_precision(tmp_path):
    """文本与金额断言：两个断言各恰有一个 assert；金额字面量保持 '5000.01' 原精度，
    数值断言以分（fen）为单位的期望由已批准断言承载，计划不改写。"""
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "填写 5000.01 元并提交"}],
        assertions=[
            {
                "id": "a1", "description": "套餐名", "kind": "ui.text",
                "required": True, "ruleVersionId": "rule-v1",
                "operator": "equals", "expected": "Pro",
            },
            {
                "id": "a2", "description": "总额大于阈值", "kind": "data.value",
                "required": True, "ruleVersionId": "rule-v1",
                "operator": "gt", "expected": 500000, "unit": "fen",
            },
        ],
        refs=["amount-input", "submit-btn", "plan-name", "total-shown"],
    )
    answer = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {
                "id": "f1", "type": "fill", "targetRef": "amount-input",
                "value": {"source": "literal", "value": "5000.01"}, "effect": "WRITE",
            },
            {"id": "c1", "type": "click", "targetRef": "submit-btn", "effect": "WRITE"},
            {"id": "v1", "type": "captureValue", "targetRef": "total-shown", "saveAs": "total", "effect": "READ"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
            {"id": "as2", "type": "assert", "assertionId": "a2", "effect": "READ"},
        ],
        "targets": [
            {"assertionId": "a1", "targetRef": "plan-name"},
            {"assertionId": "a2", "targetRef": "total-shown"},
        ],
        "blockedReasons": [],
    }

    result = run_plan(tmp_path, data, answer)

    fills = [a for a in result.actions if a.type == "fill"]
    assert fills[0].value.value == "5000.01", "金额字面量不得被四舍五入或改写"
    assert [getattr(a, "assertionId", None) for a in result.actions if a.type == "assert"] == ["a1", "a2"]
    assert {t.assertionId for t in result.targets} == {"a1", "a2"}


def test_goto_must_be_same_origin_relative_path(tmp_path):
    """同源相对路径：外部绝对 URL 被结构闸拒绝（防外跳）。"""
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "打开订单页"}],
        assertions=[
            {"id": "a1", "description": "状态", "kind": "ui.state", "required": True,
             "ruleVersionId": "rule-v1", "operator": "equals", "expected": "已提交"}
        ],
        refs=["status"],
    )
    bad = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "g1", "type": "goto", "path": "https://evil.example/orders", "effect": "READ"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
        ],
        "targets": [{"assertionId": "a1", "targetRef": "status"}],
        "blockedReasons": [],
    }
    with pytest.raises(ServiceError):
        run_plan(tmp_path, data, bad)


def test_waitfor_missing_target_ref_rejected(tmp_path):
    """真实失败模式回放（real-plan-trial-v1）：模型输出 waitFor 且缺 targetRef，
    结构闸直接拒绝——该样例锚定真实 Kimi 出现过的错误形态。"""
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "提交订单"}],
        assertions=[
            {"id": "a1", "description": "状态", "kind": "ui.state", "required": True,
             "ruleVersionId": "rule-v1", "operator": "equals", "expected": "已提交"}
        ],
        refs=["submit-btn", "status"],
    )
    bad = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "c1", "type": "click", "targetRef": "submit-btn", "effect": "WRITE"},
            {"id": "w1", "type": "waitFor", "effect": "READ",
             "condition": {"kind": "text", "value": "已提交"},
             "timeoutMs": 30000, "pollMs": 500, "maxAttempts": 60},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "READ"},
        ],
        "targets": [{"assertionId": "a1", "targetRef": "status"}],
        "blockedReasons": [],
    }
    with pytest.raises(ServiceError):
        run_plan(tmp_path, data, bad)


def test_assert_marked_write_rejected(tmp_path):
    """断言是判定不是写入：effect=WRITE 的 assert 必须拒绝（C2 加固）。"""
    data = make_wire(
        roles=["applicant"],
        steps=[{"id": "s1", "role": "applicant", "action": "提交订单"}],
        assertions=[
            {"id": "a1", "description": "状态", "kind": "ui.state", "required": True,
             "ruleVersionId": "rule-v1", "operator": "equals", "expected": "已提交"}
        ],
        refs=["submit-btn", "status"],
    )
    bad = {
        "actions": [
            {"id": "r1", "type": "switchRole", "role": "applicant", "effect": "READ"},
            {"id": "c1", "type": "click", "targetRef": "submit-btn", "effect": "WRITE"},
            {"id": "as1", "type": "assert", "assertionId": "a1", "effect": "WRITE"},
        ],
        "targets": [{"assertionId": "a1", "targetRef": "status"}],
        "blockedReasons": [],
    }
    with pytest.raises(ServiceError) as exc_info:
        run_plan(tmp_path, data, bad)
    assert "断言" in exc_info.value.message
