from pydantic import ValidationError

from ..context import RequestContext
from ..contracts.generated import (
    RuleExtractionInput,
    RuleExtractionOutput,
    CaseGenerationInput,
    CaseGenerationOutput,
)
from ..contracts.validation import validate_rules
from ..errors import ServiceError
from .prompts import build_rule_extraction_request


class AgentPipelines:
    # handoff §4 验收七条全部通过后才置 True；置 True 前 HTTP 层返回 503。
    ready = False

    async def extract_rules(
        self, input: RuleExtractionInput, context: RequestContext
    ) -> RuleExtractionOutput:
        """规则提取管线：提示词 → 模型网关 → 结构+语义校验。

        ready=False 时显式 503（handoff §1：未完成模块明确「未就绪」，不生成假成功）；
        验收七条通过后置 True 切换正式路径。测试以实例级 ready=True 驱动真实管线。
        语义校验复用公共 validate_rules（与 HTTP 层同一套，评审修正 2），
        不在 agents 内另维护规则；TS 落库前仍会再校验一次。
        返回 draft key 与临时 conflictsWith，不产生任何 DB 实体 ID（入库换 ID 由 A 负责）。
        """
        if not self.ready:
            raise ServiceError(
                "DEPENDENCY_UNAVAILABLE", "Python 规则提取模块待 C 通道验收", 503
            )
        request = build_rule_extraction_request(input)
        response = await context.models.complete_text(request)
        try:
            output = RuleExtractionOutput.model_validate(response.parsedJson)
        except ValidationError as exc:
            raise ServiceError(
                "MODEL_OUTPUT_INVALID", "模型输出不符合规则提取契约"
            ) from exc
        validate_rules(
            # README 约定：exclude_unset 传输——保留显式 null，丢弃未设置字段，
            # 否则 pydantic 默认会把 page:null 等补进 dump 而 JSON Schema 拒收
            input.model_dump(mode="json", exclude_unset=True),
            output.model_dump(mode="json", exclude_unset=True),
        )
        return output

    async def generate_cases(
        self, input: CaseGenerationInput, context: RequestContext
    ) -> CaseGenerationOutput:
        """C implements generation from APPROVED rules; do not invent data/roles/selectors."""
        raise ServiceError(
            "DEPENDENCY_UNAVAILABLE", "Python 用例生成模块待 C 通道实现", 503
        )
