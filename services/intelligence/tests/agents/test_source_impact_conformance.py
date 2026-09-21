import json
from pathlib import Path
import pytest
from aiqa_intelligence.errors import ServiceError
from aiqa_intelligence.agents.impact import analyze_report
from aiqa_intelligence.contracts.validation import (
    validate_source_comparison,
    validate_shape,
)

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "packages/contracts/fixtures/source-impact-conformance.json"
    ).read_text(encoding="utf-8")
)


def validate_impact(input, output):
    validate_shape("ImpactAnalysisOutput", output)
    expected = analyze_report(input)
    for field, id_key, keys in [
        ("affectedRules", "ruleVersionId", ("ruleVersionId", "reason", "evidenceRefs")),
        (
            "affectedCases",
            "caseVersionId",
            ("caseVersionId", "reason", "viaRuleVersionIds"),
        ),
    ]:

        def project(rows):
            values = []
            for row in rows:
                entry = {key: row[key] for key in keys}
                for key in keys:
                    if isinstance(entry[key], list):
                        entry[key] = sorted(
                            entry[key], key=lambda x: json.dumps(x, sort_keys=True)
                        )
                values.append(entry)
            return sorted(values, key=lambda r: r[id_key])

        assert project(output[field]) == project(expected[field])
    if expected["unresolved"]:
        assert output["unresolved"]


@pytest.mark.parametrize("v", VECTORS, ids=lambda v: v["name"])
def test_shared_conformance(v):
    try:
        if v["kind"] == "source":
            validate_source_comparison(v["input"], v["output"])
        else:
            validate_impact(v["input"], v["output"])
        ok = True
    except (ValueError, AssertionError, ServiceError):
        ok = False
    assert ok is v["valid"]
