import json
from pathlib import Path
import pytest
from aiqa_intelligence.source_changes import (
    compare_snapshots,
    validate_snapshot_input,
    validate_snapshot_diff,
)

ROOT = Path(__file__).resolve().parents[4]
VECTORS = json.loads(
    (ROOT / "packages/contracts/fixtures/snapshot-diff-conformance.json").read_text(
        encoding="utf-8"
    )
)["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_shared_snapshot_conformance(vector):
    i = vector["input"]
    if vector["valid"]:
        validate_snapshot_diff(i, vector["report"])
        assert (
            compare_snapshots(i["oldSnapshot"], i["newSnapshot"], bundles=i["bundles"])
            == vector["report"]
        )
    else:
        with pytest.raises(ValueError):
            if vector["phase"] == "input":
                validate_snapshot_input(i)
            else:
                validate_snapshot_diff(i, vector["report"])
