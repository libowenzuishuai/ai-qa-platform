import json
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from aiqa_intelligence.source_changes import compare_snapshots

_FIX = Path(__file__).resolve().parent / "fixtures/multi_file"


def _load(name):
    return json.loads((_FIX / name).read_text(encoding="utf-8"))


def _fixture():
    return _load("snapshot-v1.json"), _load("snapshot-v2.json"), _load("bundles.json")


def test_synthetic_fixture_covers_all_changes_and_failed_not_removed():
    a, b, bundles = _fixture()
    out = compare_snapshots(a, b, bundles=bundles)
    assert {c["kind"] for c in out["fileChanges"]} == {
        "unchanged",
        "added",
        "removed",
        "modified",
        "renamed",
        "uncertain",
    }
    broken = next(
        c
        for c in out["fileChanges"]
        if c["old"] and c["old"]["path"] == "broken/scan-incomplete.pdf"
    )
    assert broken["kind"] == "uncertain" and broken["reasonCode"] == "PARSE_UNAVAILABLE"
    rename = next(c for c in out["fileChanges"] if c["kind"] == "renamed")
    assert (
        rename["old"]["path"] == "legacy/retired.md"
        and rename["new"]["path"] == "policies/policy.md"
    )
    modified = next(c for c in out["fileChanges"] if c["kind"] == "modified")
    assert any(s["kind"] == "modified" for s in modified["spanReport"]["changes"])
    assert out["complete"] is False and out["requiresHumanReview"] is True


def test_fixture_checksums_are_original_bytes_not_parsed_text():
    a, b, _ = _fixture()
    for side, snapshot in [("old", a), ("new", b)]:
        for e in snapshot["entries"]:
            raw = (_FIX / "raw" / side / e["path"]).read_bytes()
            assert sha256(raw).hexdigest() == e["checksum"]
            assert len(raw) == e["sizeBytes"]


def test_input_order_does_not_change_output_or_mutate_input():
    a, b, bundles = _fixture()
    before = deepcopy((a, b, bundles))
    expected = compare_snapshots(a, b, bundles=bundles)
    assert (a, b, bundles) == before
    a["entries"].reverse()
    b["entries"].reverse()
    assert compare_snapshots(a, b, bundles=bundles) == expected
    expected["fileChanges"][0]["old"]["path"] = "not-the-input"
    assert (a, b, bundles) != before  # order was deliberately reversed
    assert all(e["path"] != "not-the-input" for e in a["entries"])


def test_same_valid_unparsed_image_bundles_never_prove_no_change():
    from io import BytesIO
    from PIL import Image
    from aiqa_intelligence.doc_ingestion.runner import parse_bytes
    from aiqa_intelligence.contracts.validation import validate_bundle

    a, b, bundles = _fixture()
    a["entries"] = []
    b["entries"] = []
    bundles = {}
    for snap, color, id in [(a, "red", "old-image"), (b, "blue", "new-image")]:
        stream = BytesIO()
        Image.new("RGB", (16, 16), color).save(stream, format="PNG")
        raw = stream.getvalue()
        bundle = parse_bytes(raw, id, "PNG")
        validate_bundle(bundle)
        bundles[id] = bundle
        snap["entries"].append(
            dict(
                path="prototype.png",
                checksum=sha256(raw).hexdigest(),
                sizeBytes=len(raw),
                documentVersionId=id,
                format="PNG",
                fetchStatus="OK",
                parseStatus="NEEDS_OCR",
            )
        )
    out = compare_snapshots(a, b, bundles=bundles)
    assert out["fileChanges"][0]["kind"] == "uncertain"
    assert out["fileChanges"][0]["reasonCode"] == "SOURCE_QUALITY_UNCERTAIN"
