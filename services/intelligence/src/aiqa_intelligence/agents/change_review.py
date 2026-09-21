"""Pure source comparison + impact closure. No model, DB or authority to approve."""

import asyncio
from ..source_changes import compare_bundles
from .impact import analyze_report
from ..contracts.generated import ChangeReviewAnalysisOutput
from ..errors import ServiceError


def _analyze(data):
    comparison = data["comparison"]
    try:
        report = compare_bundles(
            comparison["path"], comparison["oldBundle"], comparison["newBundle"]
        )
        impact = analyze_report(
            dict(
                sourceReports=[report],
                approvedRuleVersions=data["approvedRuleVersions"],
                approvedCaseVersions=data["approvedCaseVersions"],
            )
        )
        return ChangeReviewAnalysisOutput.model_validate(
            dict(sourceReport=report, impact=impact)
        )
    except ValueError as exc:
        raise ServiceError("VALIDATION_ERROR", str(exc)) from exc


async def analyze(input, context):
    return await asyncio.to_thread(
        _analyze, input.model_dump(mode="json", exclude_unset=True)
    )
