import json
from pathlib import Path
import pytest

REPO = Path(__file__).resolve().parents[3]
VECTORS = json.loads(
    (REPO / "packages/contracts/fixtures/intelligence-conformance.json").read_text()
)


@pytest.fixture
def rule_vector():
    return next(v for v in VECTORS if v["name"] == "01-explicit-prd")


@pytest.fixture
def case_vector():
    return next(v for v in VECTORS if v["name"] == "case-valid")
