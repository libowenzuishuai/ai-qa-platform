from ..context import RequestContext
from ..contracts.generated import (
    RuleExtractionInput,
    RuleExtractionOutput,
    CaseGenerationInput,
    CaseGenerationOutput,
)
from ..errors import ServiceError


class AgentPipelines:
    ready = False

    async def extract_rules(
        self, input: RuleExtractionInput, context: RequestContext
    ) -> RuleExtractionOutput:
        """C implements prompt/chunking + context.models; return draft keys, never DB IDs."""
        raise ServiceError(
            "DEPENDENCY_UNAVAILABLE", "Python 规则提取模块待 C 通道实现", 503
        )

    async def generate_cases(
        self, input: CaseGenerationInput, context: RequestContext
    ) -> CaseGenerationOutput:
        """C implements generation from APPROVED rules; do not invent data/roles/selectors."""
        raise ServiceError(
            "DEPENDENCY_UNAVAILABLE", "Python 用例生成模块待 C 通道实现", 503
        )
