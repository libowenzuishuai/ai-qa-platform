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


@pytest.mark.parametrize("model", ["model-test", "kimi-k2.6"])
def test_real_http_protocol_without_external_network(tmp_path, monkeypatch, model):
    import json

    for name, value in {
        "PROVIDER": "moonshot",
        "BASE_URL": "https://model.invalid/v1",
        "MODEL": model,
        "API_KEY": "fake-test-key",
    }.items():
        monkeypatch.setenv("AIQA_TEXT_" + name, value)
    original = httpx.AsyncClient

    def handle(request):
        body = json.loads(request.content)
        assert body["max_tokens"] == 7
        if model == "kimi-k2.6":
            assert body["thinking"] == {"type": "disabled"}
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


@pytest.mark.parametrize("finish_reason", ["stop", "length", "content_filter"])
def test_kimi_vision_budget_and_truncated_json_rejected(
    tmp_path, monkeypatch, finish_reason
):
    import json
    import base64
    from io import BytesIO
    from PIL import Image

    for name, value in {
        "PROVIDER": "moonshot",
        "BASE_URL": "https://model.invalid/v1",
        "MODEL": "kimi-k2.6",
        "API_KEY": "test-only",
    }.items():
        monkeypatch.setenv("AIQA_VISION_" + name, value)
    image = BytesIO()
    Image.new("RGB", (10, 10), "red").save(image, format="PNG")
    original = httpx.AsyncClient

    def handle(request):
        body = json.loads(request.content)
        assert body["model"] == "kimi-k2.6"
        assert body["max_tokens"] == 4096
        assert body["thinking"] == {"type": "disabled"}
        url = body["messages"][0]["content"][1]["image_url"]["url"]
        assert base64.b64decode(url.split(",", 1)[1]) == image.getvalue()
        return httpx.Response(
            200,
            json={
                "id": "vision-r",
                "choices": [
                    {
                        "finish_reason": finish_reason,
                        "message": {"content": '{"text":"ok"}'},
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4},
            },
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    gateway = Gateway("real", ArtifactReader(tmp_path), "test", [])
    request = VisionModelRequest(
        purpose="VISION_DESCRIBE",
        imageStorageKey="source#page=1",
        hint="read",
        timeoutMs=1000,
    )
    if finish_reason == "stop":
        result = asyncio.run(gateway.describe_image_bytes(request, image.getvalue()))
        assert result.requestId == "vision-r" and result.usage.inputTokens == 10
    else:
        with pytest.raises(ServiceError) as error:
            asyncio.run(gateway.describe_image_bytes(request, image.getvalue()))
        assert error.value.code == "MODEL_OUTPUT_INVALID"


def test_workflow_budget_rejects_before_network(tmp_path):
    gateway = Gateway("real", ArtifactReader(tmp_path), "budget", [])
    gateway.set_budget(0, 100000)
    with pytest.raises(ServiceError) as exc:
        asyncio.run(gateway.complete_text(text_request()))
    assert exc.value.code == "BUDGET_EXCEEDED"
    gateway.set_budget(2, 10)
    with pytest.raises(ServiceError) as exc:
        asyncio.run(gateway.complete_text(text_request()))
    assert exc.value.code == "BUDGET_EXCEEDED"


def test_workflow_budget_caps_output_and_prevents_second_call(tmp_path, monkeypatch):
    import json
    for name, value in {"PROVIDER": "moonshot", "BASE_URL": "https://model.invalid/v1", "MODEL": "test", "API_KEY": "test-only"}.items():
        monkeypatch.setenv("AIQA_TEXT_" + name, value)
    calls = []
    original = httpx.AsyncClient
    def handle(request):
        body = json.loads(request.content)
        calls.append(body)
        assert 0 < body["max_tokens"] < 4096
        return httpx.Response(200, json={"id":"test", "choices":[{"finish_reason":"stop", "message":{"content":"{\"text\":\"ok\"}"}}],"usage":{"prompt_tokens":10,"completion_tokens":10}})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handle), **kw))
    gateway = Gateway("real", ArtifactReader(tmp_path), "budget", [])
    gateway.set_budget(1, 2500)
    req=text_request().model_copy(update={"maxOutputTokens":4096})
    asyncio.run(gateway.complete_text(req))
    with pytest.raises(ServiceError) as exc:
        asyncio.run(gateway.complete_text(req))
    assert exc.value.code == "BUDGET_EXCEEDED"
    assert len(calls)==1


def test_chunk_budget_includes_schema_system_output_and_stops_before_mock_lookup(tmp_path):
    gateway = Gateway("mock", ArtifactReader(tmp_path), "test-1", [])
    request = text_request()
    gateway.register_mock(request, {"text": "valid"})
    gateway.input_char_limit = 1000
    with pytest.raises(ServiceError) as error:
        asyncio.run(gateway.complete_text(request))
    assert error.value.code == "BUDGET_EXCEEDED"
    gateway.input_char_limit = 40000
    gateway.set_budget(1, 100000)
    assert asyncio.run(gateway.complete_text(request)).parsedJson == {"text": "valid"}
    with pytest.raises(ServiceError) as error:
        asyncio.run(gateway.complete_text(request))
    assert error.value.code == "BUDGET_EXCEEDED"
