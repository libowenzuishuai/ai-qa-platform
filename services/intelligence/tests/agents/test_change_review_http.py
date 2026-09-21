import json
from pathlib import Path
from fastapi.testclient import TestClient
from aiqa_intelligence.app import create_app

ROOT = Path(__file__).resolve().parents[4]
VECTORS = json.loads(
    (ROOT / "packages/contracts/fixtures/source-impact-conformance.json").read_text()
)


def request():
    comparison = json.loads(
        json.dumps(
            next(v for v in VECTORS if v["name"] == "modified-real-source")["input"]
        )
    )
    assets = json.loads(
        json.dumps(
            next(v for v in VECTORS if v["name"] == "exact-intersection")["input"]
        )
    )
    return dict(
        schemaVersion="1.0",
        requestId="http-change",
        mode="real",
        timeoutMs=30000,
        input=dict(
            comparison=comparison,
            approvedRuleVersions=assets["approvedRuleVersions"],
            approvedCaseVersions=assets["approvedCaseVersions"],
        ),
    )


def test_real_http_requires_auth_and_never_calls_model(tmp_path):
    class NoModels:
        def __init__(self, *args):
            pass

        async def complete_text(self, *args):
            raise AssertionError("must not call")

    with TestClient(
        create_app(token="test", artifact_root=tmp_path, gateway_factory=NoModels)
    ) as client:
        assert client.post("/v1/changes/analyze", json=request()).status_code == 401
        response = client.post(
            "/v1/changes/analyze",
            json=request(),
            headers={"authorization": "Bearer test"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["invocations"] == []
        assert len(response.json()["output"]["impact"]["affectedRules"]) == 1


def test_http_rejects_unapproved_assets_and_foreign_source(tmp_path):
    with TestClient(create_app(token="test", artifact_root=tmp_path)) as client:
        for mutate in (
            lambda r: r["input"]["approvedRuleVersions"][0].update(
                reviewStatus="DRAFT"
            ),
            lambda r: r["input"]["comparison"]["oldBundle"]["spans"][0].update(
                documentVersionId="foreign"
            ),
        ):
            value = request()
            mutate(value)
            response = client.post(
                "/v1/changes/analyze",
                json=value,
                headers={"authorization": "Bearer test"},
            )
            assert response.status_code == 422, response.text
