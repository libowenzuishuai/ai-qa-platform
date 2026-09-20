from pydantic import ValidationError

from ..context import RequestContext
from ..contracts.generated import (
    RuleExtractionInput,
    RuleExtractionOutput,
    CaseGenerationInput,
    CaseGenerationOutput,
)
from ..contracts.validation import validate_case_input, validate_cases, validate_rules
from ..errors import ServiceError
from .prompts import (
    build_case_generation_request,
    build_rule_extraction_request,
    ensure_within_limits,
)


class AgentPipelines:
    # T6 验收翻转（2026-09-20）：三条业务样例语义断言、21 共享向量全量
    # 遍历、HTTP 正式入口（含默认实例验收门）全部通过后置 True。
    # 平台默认后端配置保持不变，正式切换由 A 联调后处理（评审修正 5）。
    ready = True

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
        # 入口门 1：只提取 PARSED 的版本。NEEDS_OCR 是合法解析终态，
        # 由下游（这里）明确拒绝；PDF_SCANNED+PARSED（Kimi 整页识别）不因格式被拒。
        for b in input.documentVersions:
            if b.parseStatus == "NEEDS_OCR":
                raise ServiceError(
                    "NEEDS_OCR",
                    f"文档 {b.documentVersionId} 需要 OCR，请先完成识别再提取规则",
                )
            if b.parseStatus != "PARSED":
                raise ServiceError(
                    "VALIDATION_ERROR",
                    f"文档 {b.documentVersionId} 状态为 {b.parseStatus}，只有 PARSED 可提取",
                )
        request = build_rule_extraction_request(input)
        # 入口门 2（评审修正 4）：超限在调用模型之前拒绝，不静默截断。
        ensure_within_limits(request)
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
        """用例生成管线：入口校验 → 提示词 → 模型网关 → 结构+语义校验。

        只接受已批准规则：validate_case_input 在调用模型之前拒绝
        （评审修正 4：无效输入不烧 token，调用次数为零）。
        语义校验复用公共 validate_cases（引用范围/夹具/断言/覆盖完整性），
        TS 落库前仍会再校验。步骤 ID 等实体 ID 由 A 入库时补齐。
        """
        if not self.ready:
            raise ServiceError(
                "DEPENDENCY_UNAVAILABLE", "Python 用例生成模块待 C 通道验收", 503
            )
        input_wire = input.model_dump(mode="json", exclude_unset=True)
        validate_case_input(input_wire)
        request = build_case_generation_request(input)
        # 评审修正 4：超限在调用模型之前拒绝，不静默截断。
        ensure_within_limits(request)
        response = await context.models.complete_text(request)
        try:
            output = CaseGenerationOutput.model_validate(response.parsedJson)
        except ValidationError as exc:
            raise ServiceError(
                "MODEL_OUTPUT_INVALID", "模型输出不符合用例生成契约"
            ) from exc
        validate_cases(input_wire, output.model_dump(mode="json", exclude_unset=True))
        return output
