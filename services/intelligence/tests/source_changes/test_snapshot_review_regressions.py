"""Independent review regressions for B a908a49; synthetic, no external access."""

from copy import deepcopy
from hashlib import sha256
import pytest
from aiqa_intelligence.source_changes import compare_snapshots
from aiqa_intelligence.doc_ingestion.runner import parse_bytes


def manifest(id, entries):
    return dict(
        snapshotId=id,
        repositoryId="repo-a",
        commitSha=("a" if id == "old" else "b") * 40,
        scope=dict(root="", include=["**/*.md"], exclude=[], policyVersion="scan-v1"),
        enumerationStatus="COMPLETE",
        enumerationReason=None,
        entries=entries,
    )


def entry(path="a.md", id="doc-old", text="Rule\n"):
    return dict(
        path=path,
        checksum=sha256(text.encode()).hexdigest(),
        sizeBytes=len(text.encode()),
        documentVersionId=id,
        format="MARKDOWN",
        fetchStatus="OK",
        parseStatus="PARSED",
    )


def pair():
    return manifest("old", [entry()]), manifest("new", [entry(id="doc-new")])


def test_review_duplicate_path_rejected():
    a, b = pair()
    a["entries"].append(deepcopy(a["entries"][0]))
    with pytest.raises(ValueError):
        compare_snapshots(a, b)


def test_review_cross_repository_rejected():
    a, b = pair()
    b["repositoryId"] = "repo-b"
    with pytest.raises(ValueError):
        compare_snapshots(a, b)


def test_review_partial_enumeration_never_means_deleted():
    a, b = pair()
    b.update(entries=[], enumerationStatus="PARTIAL", enumerationReason="page budget")
    out = compare_snapshots(a, b)
    assert all(x["kind"] != "removed" for x in out["fileChanges"])


def test_review_fetch_failure_same_hash_not_unchanged():
    a, b = pair()
    b["entries"][0].update(
        fetchStatus="FETCH_FAILED", parseStatus=None, documentVersionId=None
    )
    out = compare_snapshots(a, b)
    assert out["fileChanges"][0]["kind"] == "uncertain"


def test_review_new_fetch_failure_not_added():
    a, b = pair()
    a["entries"] = []
    b["entries"][0].update(
        fetchStatus="NOT_FETCHED", parseStatus=None, documentVersionId=None
    )
    assert compare_snapshots(a, b)["fileChanges"][0]["kind"] == "uncertain"


def test_review_missing_bundles_cannot_prove_unchanged_quality():
    a, b = pair()
    assert compare_snapshots(a, b)["fileChanges"][0]["kind"] == "uncertain"


def test_review_traversal_rejected():
    a, b = pair()
    a["entries"][0]["path"] = "../outside.md"
    with pytest.raises(ValueError):
        compare_snapshots(a, b)


def test_review_bundle_identity_mismatch_rejected():
    a, b = pair()
    b["entries"][0]["checksum"] = "f" * 64
    bundles = {
        "doc-old": parse_bytes(b"Rule\n", "wrong-id", "MARKDOWN"),
        "doc-new": parse_bytes(b"Changed\n", "doc-new", "MARKDOWN"),
    }
    with pytest.raises(ValueError):
        compare_snapshots(a, b, bundles=bundles)
