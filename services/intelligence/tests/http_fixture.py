"""TEST ONLY: deterministic handler injection for the TS -> actual Python HTTP smoke test."""

import json
from pathlib import Path
from aiqa_intelligence.app import create_app
from aiqa_intelligence.contracts.generated import (
    RuleExtractionOutput,
    CaseGenerationOutput,
)
from aiqa_intelligence.errors import ServiceError

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads(
    (ROOT / "packages/contracts/fixtures/intelligence-conformance.json").read_text()
)


class FixtureAgents:
    ready = True

    async def extract_rules(self, input, context):
        # Only registered inputs succeed, never silently synthesize a fallback.
        for v in VECTORS:
            if (
                v["valid"]
                and v["kind"] == "rules"
                and input.model_dump(mode="json", exclude_unset=True) == v["input"]
            ):
                return RuleExtractionOutput.model_validate(v["output"])
        raise ServiceError("MODEL_OUTPUT_INVALID", "test fixture miss")

    async def generate_cases(self, input, context):
        for v in VECTORS:
            if (
                v["valid"]
                and v["kind"] == "cases"
                and input.model_dump(mode="json", exclude_unset=True) == v["input"]
            ):
                return CaseGenerationOutput.model_validate(v["output"])
        raise ServiceError("MODEL_OUTPUT_INVALID", "test fixture miss")


app = create_app(token="http-test-token", agents=FixtureAgents())
