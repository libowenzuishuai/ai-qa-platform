import asyncio
import hmac
import json
import os
from pathlib import Path
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from .agents.service import AgentPipelines
from .doc_ingestion.service import DocumentParser
from .contracts import generated as models
from .contracts.validation import (
    validate_shape,
    validate_bundle,
    validate_rules,
    validate_rule_input,
    validate_cases,
    validate_case_input,
)
from .context import RequestContext
from .errors import ServiceError
from .models import Gateway
from .storage import ArtifactReader

MAX_REQUEST_BYTES = 32 * 1024 * 1024


def create_app(
    *,
    parser=None,
    agents=None,
    token: str | None = None,
    artifact_root: Path | None = None,
    gateway_factory=Gateway,
) -> FastAPI:
    parser = parser or DocumentParser()
    agents = agents or AgentPipelines()
    token = token if token is not None else os.getenv("AIQA_INTELLIGENCE_TOKEN", "")
    artifacts = ArtifactReader(
        artifact_root or Path(os.getenv("AIQA_ARTIFACT_DIR", "data/artifacts"))
    )
    app = FastAPI(
        title="AI QA Intelligence",
        version="1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(ServiceError)
    async def service_error(request: Request, error: ServiceError):
        return JSONResponse(
            status_code=error.status,
            content={
                "code": error.code,
                "message": error.message,
                "requestId": getattr(request.state, "request_id", str(uuid4())),
            },
        )

    @app.exception_handler(Exception)
    async def internal_error(request: Request, error: Exception):
        return JSONResponse(
            status_code=500,
            content={
                "code": "INTERNAL",
                "message": "智能服务内部错误",
                "requestId": getattr(request.state, "request_id", str(uuid4())),
            },
        )

    @app.get("/health")
    async def health():
        return {
            "ok": True,
            "schemaVersion": "1.0",
            "capabilities": {
                "documentParse": parser.ready,
                "ruleExtraction": agents.ready,
                "caseGeneration": agents.ready,
            },
        }

    async def invoke(request: Request, operation: str):
        request.state.request_id = str(uuid4())
        if not token:
            raise ServiceError("DEPENDENCY_UNAVAILABLE", "智能服务认证令牌未配置", 503)
        actual = request.headers.get("authorization", "")
        if not hmac.compare_digest(actual.encode(), f"Bearer {token}".encode()):
            raise ServiceError("UNAUTHENTICATED", "智能服务认证失败", 401)
        chunks, length = [], 0
        async for chunk in request.stream():
            length += len(chunk)
            if length > MAX_REQUEST_BYTES:
                raise ServiceError("VALIDATION_ERROR", "智能服务请求过大", 413)
            chunks.append(chunk)
        try:
            wire = json.loads(b"".join(chunks))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ServiceError("VALIDATION_ERROR", "请求不是合法 JSON") from exc
        names = {
            "document": "DocumentParse",
            "rules": "RuleExtraction",
            "cases": "CaseGeneration",
        }
        name = names[operation]
        validate_shape(name + "Request", wire)
        request.state.request_id = wire["requestId"]
        try:
            typed = getattr(models, name + "Request").model_validate(wire)
        except ValidationError as exc:
            raise ServiceError("VALIDATION_ERROR", "输入不符合契约") from exc
        data = typed.input.model_dump(mode="json", exclude_unset=True)
        if operation == "rules":
            validate_rule_input(data)
            for bundle in data["documentVersions"]:
                validate_bundle(bundle)
                if bundle["parseStatus"] != "PARSED":
                    raise ServiceError(
                        (
                            "NEEDS_OCR"
                            if bundle["parseStatus"] == "NEEDS_OCR"
                            else "VALIDATION_ERROR"
                        ),
                        "规则提取要求已解析文档",
                    )
        if operation == "cases":
            validate_case_input(data)
        records = []
        context = RequestContext(
            wire["requestId"],
            wire["mode"],
            artifacts,
            gateway_factory(
                wire["mode"],
                artifacts,
                data.get("promptVersion", "document-1"),
                records,
            ),
            records,
        )
        methods = {
            "document": parser.parse_document,
            "rules": agents.extract_rules,
            "cases": agents.generate_cases,
        }
        try:
            output = await asyncio.wait_for(
                methods[operation](typed.input, context), wire["timeoutMs"] / 1000
            )
        except TimeoutError as exc:
            raise ServiceError("MODEL_TIMEOUT", "智能服务处理超时", 504) from exc
        try:
            body = output.model_dump(mode="json", exclude_unset=True)
            if operation == "document":
                validate_bundle(body)
                if body["documentVersionId"] != data["documentVersionId"] or body[
                    "parseStatus"
                ] not in {"PARSED", "NEEDS_OCR", "FAILED"}:
                    raise ServiceError("MODEL_OUTPUT_INVALID", "解析产物版本或终态错误")
            elif operation == "rules":
                validate_rules(data, body)
            else:
                validate_cases(data, body)
            response = {
                "schemaVersion": "1.0",
                "requestId": wire["requestId"],
                "mode": wire["mode"],
                "output": body,
                "invocations": [
                    r.model_dump(mode="json", exclude_unset=True) for r in records
                ],
            }
            validate_shape(name + "Response", response)
        except (ValidationError, AttributeError) as exc:
            raise ServiceError(
                "MODEL_OUTPUT_INVALID", "模块返回数据不符合契约"
            ) from exc
        return response

    @app.post("/v1/documents/parse")
    async def documents(request: Request):
        return await invoke(request, "document")

    @app.post("/v1/rules/extract")
    async def rules(request: Request):
        return await invoke(request, "rules")

    @app.post("/v1/cases/generate")
    async def cases(request: Request):
        return await invoke(request, "cases")

    return app


app = create_app()
