import asyncio
import hashlib
import httpx
import pytest
from aiqa_intelligence.storage import ArtifactReader
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.contracts.generated import TextModelRequest, VisionModelRequest
from aiqa_intelligence.errors import ServiceError


def test_artifact_bounds_and_checksum(tmp_path):
    (tmp_path / "a").write_bytes(b"document")
    reader = ArtifactReader(tmp_path)
    assert (
        reader.read("a", size=8, checksum=hashlib.sha256(b"document").hexdigest())
        == b"document"
    )
    for key in ["../outside", "/etc/passwd"]:
        with pytest.raises(ServiceError):
            reader.read(key)
    with pytest.raises(ServiceError):
        reader.read("a", checksum="0" * 64)
    with pytest.raises(ServiceError):
        reader.read("a", size=9)
    (tmp_path / "escape").symlink_to("/etc/passwd")
    with pytest.raises(ServiceError):
        reader.read("escape")


def text_request():
    return TextModelRequest.model_validate(
        {
            "purpose": "RULE_EXTRACTION",
            "system": "s",
            "user": "u",
            "timeoutMs": 1000,
            "maxOutputTokens": 7,
            "outputSchema": {
                "type": "object",
                "required": ["text"],
                "properties": {"text": {"type": "string"}},
            },
        }
    )


def test_mock_lookup_schema_and_metadata(tmp_path):
    records = []
    gateway = Gateway("mock", ArtifactReader(tmp_path), "test-1", records)
    req = text_request()
    with pytest.raises(ServiceError):
        asyncio.run(gateway.complete_text(req))
    gateway.register_mock(req, {"text": 123})
    with pytest.raises(ServiceError):
        asyncio.run(gateway.complete_text(req))
    gateway.register_mock(req, {"text": "保留 ,} 原文"})
    result = asyncio.run(gateway.complete_text(req))
    assert result.parsedJson == {"text": "保留 ,} 原文"}
    assert len(records) == 1 and records[0].promptVersion == "test-1"
    vision = VisionModelRequest.model_validate(
        {
            "purpose": "VISION_DESCRIBE",
            "imageStorageKey": "x.png",
            "hint": "h",
            "timeoutMs": 1000,
            "outputSchema": {"type": "object", "required": ["text"]},
        }
    )
    gateway.register_mock(vision, {"wrong": True})
    with pytest.raises(ServiceError):
        asyncio.run(gateway.describe_image(vision))


def test_real_requires_configuration(tmp_path, monkeypatch):
    monkeypatch.setenv("AIQA_TEXT_PROVIDER", "")
    with pytest.raises(ServiceError) as exc:
        asyncio.run(
            Gateway("real", ArtifactReader(tmp_path), "test", []).complete_text(
                text_request()
            )
        )
    assert exc.value.code == "MODEL_NOT_CONFIGURED"


def test_real_http_protocol_without_external_network(tmp_path, monkeypatch):
    import json

    for name, value in {
        "PROVIDER": "moonshot",
        "BASE_URL": "https://model.invalid/v1",
        "MODEL": "model-test",
        "API_KEY": "fake-test-key",
    }.items():
        monkeypatch.setenv("AIQA_TEXT_" + name, value)
    original = httpx.AsyncClient

    def handle(request):
        body = json.loads(request.content)
        assert body["max_tokens"] == 7
        assert request.headers["authorization"] == "Bearer fake-test-key"
        return httpx.Response(
            200,
            json={
                "id": "r-1",
                "choices": [{"message": {"content": '{"text":"ok"}'}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            },
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    result = asyncio.run(
        Gateway("real", ArtifactReader(tmp_path), "test", []).complete_text(
            text_request()
        )
    )
    assert result.usage.inputTokens == 3 and result.requestId == "r-1"
