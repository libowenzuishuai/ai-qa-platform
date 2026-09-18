from dataclasses import dataclass, field
from typing import Protocol, Literal
from .contracts.generated import (
    TextModelRequest,
    VisionModelRequest,
    ModelResponse,
    InvocationRecord,
)
from .storage import ArtifactReader


class ModelGateway(Protocol):
    async def complete_text(self, request: TextModelRequest) -> ModelResponse: ...
    async def describe_image(self, request: VisionModelRequest) -> ModelResponse: ...


@dataclass
class RequestContext:
    request_id: str
    mode: Literal["real", "mock"]
    artifacts: ArtifactReader
    models: ModelGateway
    # Model gateway appends invocation metadata, platform persists it.
    invocations: list[InvocationRecord] = field(default_factory=list)
