import json
from pathlib import Path

from aiqa_intelligence.doc_ingestion.runner import parse_bytes
from aiqa_intelligence.source_changes import compare_bundles, compare_snapshots

_FIX = Path(__file__).resolve().parent / "fixtures" / "multi_file"


def _load(name: str) -> dict:
    return json.loads((_FIX / name).read_text(encoding="utf-8"))


def _md(text: str, doc_id: str) -> dict:
    return parse_bytes(text.encode(), doc_id, "MARKDOWN")


def _bundles_for_synthetic_pair() -> dict[str, dict]:
    return {
        "syn-readme-v1": _md("# Readme v1\n", "syn-readme-v1"),
        "syn-readme-v2": _md("# Readme v1\n", "syn-readme-v2"),
        "syn-prd-v1": _md("Amount > 500000\n", "syn-prd-v1"),
        "syn-prd-v2": _md("Amount > 600000\n", "syn-prd-v2"),
        "syn-retired-v1": _md("Old policy\n", "syn-retired-v1"),
        "syn-policy-v2": _md("Old policy\n", "syn-policy-v2"),
        "syn-new-v2": _md("New file\n", "syn-new-v2"),
        "syn-gone-v1": _md("Gone file\n", "syn-gone-v1"),
    }


def test_synthetic_fixture_covers_add_modify_unchanged_rename_and_failed_not_removed():
    old, new = _load("snapshot-v1.json"), _load("snapshot-v2.json")
    report = compare_snapshots(old, new, bundles=_bundles_for_synthetic_pair())
    kinds = {c["kind"] for c in report["fileChanges"]}
    assert "unchanged" in kinds
    assert "added" in kinds
    assert "modified" in kinds
    removed = next(
        c for c in report["fileChanges"] if c["kind"] == "removed" and c["path"] == "archive/gone.md"
    )
    assert removed["oldDocumentVersionId"] == "syn-gone-v1"
    uncertain = [c for c in report["fileChanges"] if c["kind"] == "uncertain"]
    rename = next(
        c
        for c in uncertain
        if c.get("oldPath") == "legacy/retired.md"
        and c.get("newPath") == "policies/policy.md"
    )
    assert "重命名" in rename["reason"]
    broken = next(
        c for c in uncertain if c.get("oldPath") == "broken/scan-incomplete.pdf"
    )
    assert "不能认定为删除" in broken["reason"]
    assert not any(
        c["kind"] == "removed" and c.get("path") == "broken/scan-incomplete.pdf"
        for c in report["fileChanges"]
    )
    mod = next(
        c for c in report["fileChanges"] if c["kind"] == "modified" and c["path"] == "requirements/prd.md"
    )
    assert mod["spanReport"] is not None
    assert any(s["kind"] == "modified" for s in mod["spanReport"]["changes"])


def test_failed_fetch_old_path_missing_is_not_removed():
    old = {
        "snapshotId": "o",
        "entries": [
            {
                "path": "x.md",
                "checksum": "aa" * 32,
                "documentVersionId": "dv-old",
                "fetchStatus": "FETCH_FAILED",
                "parseStatus": None,
            }
        ],
    }
    new = {"snapshotId": "n", "entries": []}
    report = compare_snapshots(old, new)
    assert report["fileChanges"] == [
        {
            "kind": "uncertain",
            "oldPath": "x.md",
            "oldChecksum": "aa" * 32,
            "oldDocumentVersionId": "dv-old",
            "oldFetchStatus": "FETCH_FAILED",
            "oldParseStatus": None,
            "reason": "旧版文件未成功获取或解析，不能认定为删除",
        }
    ]


def test_duplicate_checksum_blocks_unique_rename():
    checksum = "bb" * 32
    old = {
        "snapshotId": "o",
        "entries": [
            {"path": "a.md", "checksum": checksum, "fetchStatus": "OK", "parseStatus": "PARSED"},
            {"path": "b.md", "checksum": checksum, "fetchStatus": "OK", "parseStatus": "PARSED"},
        ],
    }
    new = {
        "snapshotId": "n",
        "entries": [
            {"path": "c.md", "checksum": checksum, "fetchStatus": "OK", "parseStatus": "PARSED"},
            {"path": "d.md", "checksum": checksum, "fetchStatus": "OK", "parseStatus": "PARSED"},
        ],
    }
    report = compare_snapshots(old, new)
    assert all(c["kind"] == "uncertain" for c in report["fileChanges"])
    assert any("多处出现" in (c.get("reason") or "") for c in report["fileChanges"])


def test_single_file_compare_still_used_for_modified_path():
    old = _md("Line\n", "old")
    new = _md("Line changed\n", "new")
    span = compare_bundles("f.md", old, new)
    assert span["changes"]
    old_snap = {
        "snapshotId": "o",
        "entries": [
            {
                "path": "f.md",
                "checksum": "01" * 32,
                "documentVersionId": "old",
                "fetchStatus": "OK",
                "parseStatus": "PARSED",
            }
        ],
    }
    new_snap = {
        "snapshotId": "n",
        "entries": [
            {
                "path": "f.md",
                "checksum": "02" * 32,
                "documentVersionId": "new",
                "fetchStatus": "OK",
                "parseStatus": "PARSED",
            }
        ],
    }
    report = compare_snapshots(
        old_snap, new_snap, bundles={"old": old, "new": new}
    )
    mod = report["fileChanges"][0]
    assert mod["kind"] == "modified"
    assert mod["spanReport"]["changes"]
