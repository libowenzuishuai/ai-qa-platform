"""A-owned model gateway. Explicit real/mock, no network fallback and no JSON text rewriting."""

import hashlib
import json
import os
import time
import httpx
from .contracts.generated import (
    TextModelRequest,
    VisionModelRequest,
    ModelResponse,
    InvocationRecord,
)
from .contracts.validation import validate_shape
from .errors import ServiceError
from .storage import ArtifactReader
from jsonschema import Draft7Validator
from jsonschema.exceptions import ValidationError as SchemaValidationError


def mock_key(request: TextModelRequest | VisionModelRequest) -> str:
    body = request.model_dump(mode="json", exclude_none=True)
    return hashlib.sha256(
        json.dumps(
            body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


class Gateway:
    def __init__(
        self,
        mode: str,
        artifacts: ArtifactReader,
        prompt_version: str,
        records: list[InvocationRecord],
        mock_entries: dict | None = None,
    ):
        self.mode, self.artifacts, self.prompt_version = mode, artifacts, prompt_version
        self.records, self.mock_entries = records, (
            mock_entries if mock_entries is not None else {}
        )

    def register_mock(
        self, request: TextModelRequest | VisionModelRequest, output: object
    ) -> None:
        if self.mode != "mock":
            raise ValueError("Only an explicit mock gateway may register responses")
        self.mock_entries[mock_key(request)] = output

    async def complete_text(self, request: TextModelRequest) -> ModelResponse:
        wire = request.model_dump(mode="json", exclude_none=True)
        validate_shape("TextModelRequest", wire)
        system = wire["system"]
        if "outputSchema" in wire:
            system += "\nReturn a JSON object matching this schema:\n" + json.dumps(
                wire["outputSchema"], ensure_ascii=False
            )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": wire["user"]},
        ]
        return await self._complete(request, "TEXT", messages, wire)

    async def describe_image(self, request: VisionModelRequest) -> ModelResponse:
        wire = request.model_dump(mode="json", exclude_none=True)
        validate_shape("VisionModelRequest", wire)
        if self.mode == "mock":
            return await self._complete(request, "VISION", [], wire)
        data = self.artifacts.read(wire["imageStorageKey"])
        return await self.describe_image_bytes(request, data)

    async def describe_image_bytes(
        self, request: VisionModelRequest, data: bytes
    ) -> ModelResponse:
        import base64

        wire = request.model_dump(mode="json", exclude_none=True)
        validate_shape("VisionModelRequest", wire)
        if self.mode == "mock":
            return await self._complete(request, "VISION", [], wire)
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif data.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        else:
            raise ServiceError("VALIDATION_ERROR", "视觉输入必须是 PNG 或 JPEG")
        hint = wire["hint"]
        if "outputSchema" in wire:
            hint += "\nReturn JSON matching: " + json.dumps(
                wire["outputSchema"], ensure_ascii=False
            )
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": hint},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime};base64,{base64.b64encode(data).decode()}"
                        },
                    },
                ],
            }
        ]
        return await self._complete(request, "VISION", messages, wire)

    async def _complete(
        self, request, channel: str, messages: list, wire: dict
    ) -> ModelResponse:
        start = time.monotonic()
        if self.mode == "mock":
            key = mock_key(request)
            if key not in self.mock_entries:
                raise ServiceError(
                    "MODEL_OUTPUT_INVALID", "mock 查表未命中，禁止现编响应"
                )
            parsed = self.mock_entries[key]
            raw = json.dumps(parsed, ensure_ascii=False)
            provider, model, request_id, usage = (
                "mock",
                "mock",
                f"mock-{key[:12]}",
                {"inputTokens": 0, "outputTokens": 0},
            )
        else:
            prefix = f"AIQA_{channel}_"
            provider = os.getenv(prefix + "PROVIDER")
            base, model, key = (
                os.getenv(prefix + name) for name in ("BASE_URL", "MODEL", "API_KEY")
            )
            if provider != "moonshot" or not all([base, model, key]):
                raise ServiceError(
                    "MODEL_NOT_CONFIGURED", f"{channel} Moonshot 通道未配置", 503
                )
            body = {
                "model": model,
                "messages": messages,
                "response_format": {"type": "json_object"},
            }
            if channel == "VISION":
                # Bounded transcription output, shared across images and PDF pages.
                body["max_tokens"] = 4096
            # Structured extraction is bounded by the request's wall time and output
            # budget. Kimi thinking consumes that budget before emitting JSON.
            if model == "kimi-k2.6":
                body["thinking"] = {"type": "disabled"}
            for source, target in [
                ("temperature", "temperature"),
                ("maxOutputTokens", "max_tokens"),
            ]:
                if source in wire:
                    body[target] = wire[source]
            try:
                async with httpx.AsyncClient(
                    timeout=wire["timeoutMs"] / 1000, follow_redirects=False
                ) as client:
                    res = await client.post(
                        base.rstrip("/") + "/chat/completions",
                        json=body,
                        headers={"Authorization": f"Bearer {key}"},
                    )
            except httpx.TimeoutException as exc:
                raise ServiceError("MODEL_TIMEOUT", "模型调用超时", 504) from exc
            except httpx.HTTPError as exc:
                raise ServiceError(
                    "DEPENDENCY_UNAVAILABLE", "模型服务不可用", 503
                ) from exc
            if res.status_code in (401, 403):
                raise ServiceError("MODEL_NOT_CONFIGURED", "模型服务拒绝凭据", 503)
            if not res.is_success:
                raise ServiceError("DEPENDENCY_UNAVAILABLE", "模型服务返回错误", 503)
            try:
                data = res.json()
                if data["choices"][0].get("finish_reason") not in (None, "stop"):
                    raise ValueError("Model output was truncated or interrupted")
                raw = data["choices"][0]["message"]["content"]
                parsed = json.loads(raw)
                request_id = res.headers.get("x-request-id") or data.get("id")
                usage = {
                    "inputTokens": data.get("usage", {}).get("prompt_tokens", 0),
                    "outputTokens": data.get("usage", {}).get("completion_tokens", 0),
                }
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise ServiceError(
                    "MODEL_OUTPUT_INVALID", "模型响应不是合法 JSON"
                ) from exc
        if wire.get("outputSchema") is not None:
            try:
                Draft7Validator.check_schema(wire["outputSchema"])
                Draft7Validator(wire["outputSchema"]).validate(parsed)
            except SchemaValidationError as exc:
                path = ".".join(map(str, exc.absolute_path)) or "root"
                raise ServiceError(
                    "MODEL_OUTPUT_INVALID", f"模型输出不符合 outputSchema：{path} ({exc.validator})"
                ) from exc
            except Exception as exc:
                raise ServiceError("MODEL_OUTPUT_INVALID", "模型输出不符合 outputSchema") from exc
        response = ModelResponse.model_validate(
            {
                "parsedJson": parsed,
                "rawText": raw,
                "repairsApplied": [],
                "provider": provider,
                "model": model,
                "requestId": request_id,
                "usage": usage,
                "latencyMs": int((time.monotonic() - start) * 1000),
                "outcome": "SUCCESS",
            }
        )
        self.records.append(
            InvocationRecord.model_validate(
                {
                    "purpose": wire["purpose"],
                    "promptVersion": self.prompt_version,
                    "response": response.model_dump(mode="json", exclude_unset=True),
                }
            )
        )
        return response
