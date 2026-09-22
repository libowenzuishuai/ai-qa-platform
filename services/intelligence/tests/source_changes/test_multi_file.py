"""The retired unscoped protocol must never turn an omitted file into a deletion.
Algorithm cases (byte hashes, rename ambiguity, failed parsing, Unicode, completeness)
are exercised by the shared snapshot-diff conformance vectors in both runtimes.
"""
import json
from pathlib import Path
import pytest
from aiqa_intelligence.source_changes.multi_file import compare_files, MultiFileLimit
from aiqa_intelligence.source_changes import compare_snapshots

@pytest.mark.parametrize("legacy", [
    {"oldFiles": [], "newFiles": []},
    {"oldFiles": [{"path": "deleted.md"}], "newFiles": []},
    {"oldFiles": [], "newFiles": [], "enumerationStatus": "COMPLETE"},
])
def test_legacy_caller_lists_are_not_complete_snapshots(legacy):
    with pytest.raises(MultiFileLimit, match="完整性"):
        compare_files(legacy)

def test_compatibility_name_delegates_to_canonical_comparator():
    folder = Path(__file__).parent / "fixtures" / "multi_file"
    old=json.loads((folder/"snapshot-v1.json").read_text())
    new=json.loads((folder/"snapshot-v2.json").read_text())
    bundles=json.loads((folder/"bundles.json").read_text())
    assert compare_files({"oldSnapshot":old,"newSnapshot":new,"bundles":bundles}) == compare_snapshots(old,new,bundles=bundles)
