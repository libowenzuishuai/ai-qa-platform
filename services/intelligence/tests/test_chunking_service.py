"""R03 /v1/documents/chunk：确定性分块端到端（wire 校验 + 无模型调用）。"""
import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient

from aiqa_intelligence.app import create_app

HEADERS = {"authorization": "Bearer service-test"}
VECTOR = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/chunking/shared-vector.json").read_text()
)


def chunk_request(mode="mock"):
    # 深拷贝：测试不得污染共享向量（bundle 可变更字段）。
    return {
        "schemaVersion": "1.0",
        "requestId": "request-chunk-1",
        "mode": mode,
        "timeoutMs": 30_000,
        "input": {
            "bundle": copy.deepcopy(VECTOR["bundle"]),
            "documentChecksum": VECTOR["documentChecksum"],
            "strategyParams": copy.deepcopy(VECTOR["strategyParams"]),
        },
    }


def without_created_at(manifest):
    return {k: v for k, v in manifest.items() if k != "createdAt"}


def test_chunk_endpoint_deterministic_and_zero_invocations():
    with TestClient(create_app(token="service-test")) as client:
        res = client.post(
            "/v1/documents/chunk", headers=HEADERS, json=chunk_request()
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["requestId"] == "request-chunk-1"
        # 分块不调用模型。
        assert body["invocations"] == []
        # 内容确定性：除服务端时间戳外与共享向量完全一致。
        assert without_created_at(body["output"]["manifest"]) == without_created_at(VECTOR["expectedManifest"])
        assert body["output"]["coverage"] == VECTOR["expectedCoverage"]

        # 同一输入再调一次：内容一致（确定性）。
        again = client.post(
            "/v1/documents/chunk", headers=HEADERS, json=chunk_request()
        ).json()
        assert without_created_at(again["output"]["manifest"]) == without_created_at(body["output"]["manifest"])


def test_chunk_rejects_unparsed_bundle_and_bad_params():
    with TestClient(create_app(token="service-test")) as client:
        bad_status = chunk_request()
        bad_status["input"]["bundle"]["parseStatus"] = "NEEDS_OCR"
        res = client.post(
            "/v1/documents/chunk", headers=HEADERS, json=bad_status
        )
        assert res.status_code == 422
        assert res.json()["code"] == "VALIDATION_ERROR"

        bad_budget = chunk_request()
        bad_budget["input"]["strategyParams"] = {
            "maxCharsPerChunk": 35_000,
            "contextOverlapChars": 100,
            "modelBudgetChars": 40_000,
        }
        res = client.post(
            "/v1/documents/chunk", headers=HEADERS, json=bad_budget
        )
        assert res.status_code == 422
        assert "输出预留" in res.json()["message"]

        assert (
            client.post("/v1/documents/chunk", json=chunk_request()).status_code == 401
        )
