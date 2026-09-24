"""W08 /v2/decide：确定性基线（命中/无命中/平局回退）。"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aiqa_intelligence.app import create_app

TOKEN = "dec-test"


@pytest.fixture()
def client():
    return TestClient(create_app(token=TOKEN))


def decide(client, payload):
    return client.post(
        "/v2/decide",
        headers={"authorization": f"Bearer {TOKEN}"},
        json={"schemaVersion": "1.0", "requestId": "dec-1", "mode": "mock", "timeoutMs": 5000, "input": payload},
    )


def test_hit_selects_option(client):
    res = decide(client, {
        "question": "浏览器界面验证怎么选",
        "options": [
            {"id": "browser", "label": "浏览器界面验证", "context": ""},
            {"id": "api", "label": "HTTP 接口验证", "context": ""},
        ],
        "kind": "choose",
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["invocations"] == []  # 不调用模型
    assert body["output"]["selectedOptionId"] == "browser"
    assert body["output"]["fallbackUsed"] is False


def test_no_hit_falls_back(client):
    res = decide(client, {
        "question": "完全无关词",
        "options": [
            {"id": "a", "label": "甲选项", "context": ""},
            {"id": "b", "label": "乙选项", "context": ""},
        ],
        "kind": "choose",
    })
    out = res.json()["output"]
    assert out["fallbackUsed"] is True
    assert out["selectedOptionId"] is None


def test_score_normalizes(client):
    res = decide(client, {
        "question": "浏览器界面验证",
        "options": [
            {"id": "browser", "label": "浏览器界面验证", "context": ""},
            {"id": "api", "label": "HTTP 接口", "context": ""},
        ],
        "kind": "score",
    })
    out = res.json()["output"]
    assert out["fallbackUsed"] is False
    assert 0 < out["score"] <= 1


def test_single_option_rejected(client):
    res = decide(client, {
        "question": "x", "options": [{"id": "only", "label": "唯一", "context": ""}], "kind": "choose",
    })
    assert res.status_code == 422
