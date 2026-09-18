"""TEST ONLY: real document parser + narrowly registered C outputs, never a real model.
The production agents package remains unimplemented; this proves platform integration only.
"""

from aiqa_intelligence.app import create_app
from aiqa_intelligence.contracts.generated import (
    RuleExtractionOutput,
    CaseGenerationOutput,
)
from aiqa_intelligence.errors import ServiceError

TEXT = "金额超过 5000 元须审批"


class RegisteredAgents:
    ready = True

    async def extract_rules(self, input, context):
        if context.mode != "mock" or len(input.documentVersions) != 1:
            raise ServiceError("MODEL_OUTPUT_INVALID", "test registration miss")
        bundle = input.documentVersions[0]
        span = next((s for s in bundle.spans if s.quotedText == TEXT), None)
        if span is None:
            raise ServiceError("MODEL_OUTPUT_INVALID", "test registration miss")
        return RuleExtractionOutput.model_validate(
            {
                "ruleDrafts": [
                    {
                        "key": "rule-draft-01",
                        "statement": TEXT,
                        "classification": "EXPLICIT",
                        "role": "申请人",
                        "action": "提交采购单",
                        "expectation": "待审批",
                        "businessFields": [
                            {
                                "key": "amountCents",
                                "operator": "gt",
                                "value": 500000,
                                "unit": "fen",
                            }
                        ],
                        "sources": [
                            {
                                "documentVersionId": bundle.documentVersionId,
                                "sourceSpanIds": [span.id],
                            }
                        ],
                        "conflictsWith": [],
                    }
                ],
                "clarifications": [
                    {
                        "ruleDraftKeys": ["rule-draft-01"],
                        "question": "由哪个角色审批？",
                        "kind": "MISSING_INFO",
                    }
                ],
                "unparsedRanges": [],
            }
        )

    async def generate_cases(self, input, context):
        if (
            context.mode != "mock"
            or len(input.approvedRuleVersions) != 1
            or len(input.clarificationSources) != 1
        ):
            raise ServiceError("MODEL_OUTPUT_INVALID", "test registration miss")
        rule = input.approvedRuleVersions[0]
        if rule.statement != TEXT or input.clarificationSources[0].answer != "部门主管":
            raise ServiceError("MODEL_OUTPUT_INVALID", "test registration miss")
        return CaseGenerationOutput.model_validate(
            {
                "caseDrafts": [
                    {
                        "title": "超过阈值进入审批",
                        "ruleVersionIds": [rule.id],
                        "roles": ["申请人"],
                        "preconditions": ["存在申请人账号"],
                        "dataSpec": {"strategy": "create", "note": "500001 分采购单"},
                        "steps": [
                            {
                                "role": "申请人",
                                "action": "提交金额为 500001 分的采购单",
                                "expectedResult": "待审批",
                            }
                        ],
                        "assertions": [
                            {
                                "id": "amount-status",
                                "description": "检查审批状态",
                                "kind": "ui.text",
                                "required": True,
                                "ruleVersionId": rule.id,
                                "operator": "equals",
                                "expected": "待审批",
                            }
                        ],
                        "cleanup": {"strategy": "namespace"},
                        "dimensions": ["BOUNDARY"],
                    }
                ],
                "coverageMap": [
                    {
                        "ruleVersionId": rule.id,
                        "caseCount": 1,
                        "dimensionsCovered": ["BOUNDARY"],
                    }
                ],
                "blockedRequirements": [],
            }
        )


app = create_app(token="platform-test-token", agents=RegisteredAgents())
