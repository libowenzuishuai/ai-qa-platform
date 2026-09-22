"""Regenerate synthetic shared fixtures; never accesses a real repository or model."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from aiqa_intelligence.doc_ingestion.runner import parse_bytes
from aiqa_intelligence.source_changes import compare_snapshots

ROOT = Path(__file__).resolve().parents[4]
LOCAL = Path(__file__).parent / "fixtures/multi_file"


def manifest(id, entries):
    return dict(
        snapshotId=id,
        repositoryId="synthetic-repo",
        commitSha=("a" if id == "old" else "b") * 40,
        scope=dict(root="", include=["**/*"], exclude=[], policyVersion="fixture-v1"),
        enumerationStatus="COMPLETE",
        enumerationReason=None,
        entries=entries,
    )


def entry(path, id, text, format="MARKDOWN"):
    raw = text.encode()
    return dict(
        path=path,
        checksum=sha256(raw).hexdigest(),
        sizeBytes=len(raw),
        documentVersionId=id,
        format=format,
        fetchStatus="OK",
        parseStatus="PARSED",
    )


def input_for(old, new):
    bundles = {}

    def rows(values):
        result = []
        for path, id, text in values:
            result.append(entry(path, id, text))
            bundles[id] = parse_bytes(text.encode(), id, "MARKDOWN")
        return result

    return dict(
        oldSnapshot=manifest("old", rows(old)),
        newSnapshot=manifest("new", rows(new)),
        bundles=bundles,
    )


def report(i):
    return compare_snapshots(i["oldSnapshot"], i["newSnapshot"], bundles=i["bundles"])


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


old = [
    ("docs/readme.md", "syn-readme-v1", "# Readme v1\n"),
    ("requirements/prd.md", "syn-prd-v1", "Amount > 500000\n"),
    ("legacy/retired.md", "syn-retired-v1", "Old policy\n"),
    ("archive/gone.md", "syn-gone-v1", "Gone file\n"),
]
new = [
    ("docs/readme.md", "syn-readme-v2", "# Readme v1\n"),
    ("requirements/prd.md", "syn-prd-v2", "Amount > 600000\n"),
    ("policies/policy.md", "syn-policy-v2", "Old policy\n"),
    ("docs/new.md", "syn-new-v2", "New file\n"),
]
fixture = input_for(old, new)
for side, files in [("old", old), ("new", new)]:
    for path, id, text in files:
        p = LOCAL / "raw" / side / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
broken = b"synthetic invalid PDF, not a customer file"
p = LOCAL / "raw/old/broken/scan-incomplete.pdf"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_bytes(broken)
fixture["oldSnapshot"]["entries"].append(
    dict(
        path="broken/scan-incomplete.pdf",
        checksum=sha256(broken).hexdigest(),
        sizeBytes=len(broken),
        documentVersionId="syn-broken-v1",
        format="PDF_TEXT",
        fetchStatus="OK",
        parseStatus="FAILED",
    )
)
write(LOCAL / "snapshot-v1.json", fixture["oldSnapshot"])
write(LOCAL / "snapshot-v2.json", fixture["newSnapshot"])
write(LOCAL / "bundles.json", fixture["bundles"])

vectors = []


def good(name, i, kinds):
    r = report(i)
    assert sorted(c["kind"] for c in r["fileChanges"]) == sorted(kinds), (name, r)
    vectors.append(dict(name=name, valid=True, input=deepcopy(i), report=r))
    return deepcopy(i), deepcopy(r)


def bad_input(name, i):
    vectors.append(dict(name=name, valid=False, phase="input", input=deepcopy(i)))


def bad_report(name, i, r):
    vectors.append(
        dict(
            name=name,
            valid=False,
            phase="report",
            input=deepcopy(i),
            report=deepcopy(r),
        )
    )


good(
    "mixed-real-bytes-synthetic",
    fixture,
    ["unchanged", "modified", "renamed", "added", "removed", "uncertain"],
)
base = input_for([("a.md", "v-old", "Rule\n")], [("a.md", "v-new", "Rule\n")])
_, base_report = good("unchanged", base, ["unchanged"])
good("empty-complete-scopes", input_for([], []), [])
good("all-files-added", input_for([], [("a.md", "v-new", "Rule\n")]), ["added"])
good("all-files-removed", input_for([("a.md", "v-old", "Rule\n")], []), ["removed"])
good(
    "unique-byte-rename",
    input_for([("a.md", "v-old", "Rule\n")], [("b.md", "v-new", "Rule\n")]),
    ["renamed"],
)
good(
    "text-equal-bytes-different-not-rename",
    input_for([("a.md", "v-old", "Rule\n")], [("b.md", "v-new", "Rule\n\n")]),
    ["removed", "added"],
)
mod, mod_report = good(
    "modified-span-evidence",
    input_for([("a.md", "v-old", "Amount > 1\n")], [("a.md", "v-new", "Amount > 2\n")]),
    ["modified"],
)
i = input_for(
    [("a.md", "a", "Rule\n"), ("b.md", "b", "Rule\n")],
    [("c.md", "c", "Rule\n"), ("d.md", "d", "Rule\n")],
)
good("duplicate-hash-candidates", i, ["uncertain"] * 4)
i = input_for([("a.md", "v-old", "Rule\n")], [])
i["newSnapshot"].update(
    enumerationStatus="PARTIAL", enumerationReason="pagination budget"
)
good("incomplete-scan-no-removal", i, ["uncertain"])
i = input_for([], [("a.md", "v-new", "Rule\n")])
i["oldSnapshot"].update(enumerationStatus="FAILED", enumerationReason="unreachable")
good("failed-scan-no-addition", i, ["uncertain"])
i = deepcopy(base)
i["oldSnapshot"].update(enumerationStatus="PARTIAL", enumerationReason="budget")
good("known-pair-but-partial-report", i, ["unchanged"])
i = deepcopy(base)
i["bundles"] = {}
good("bundle-missing", i, ["uncertain"])
i = deepcopy(base)
i["newSnapshot"]["entries"][0].update(
    fetchStatus="FETCH_FAILED", parseStatus=None, documentVersionId=None
)
del i["bundles"]["v-new"]
good("same-hash-fetch-failed", i, ["uncertain"])
i = input_for([], [("a.md", "v-new", "Rule\n")])
i["newSnapshot"]["entries"][0].update(
    fetchStatus="NOT_FETCHED",
    parseStatus=None,
    documentVersionId=None,
    checksum=None,
    sizeBytes=None,
)
i["bundles"] = {}
good("new-path-not-fetched", i, ["uncertain"])
i = deepcopy(base)
for b in i["bundles"].values():
    b["spans"][0]["extractionQuality"] = "LOW"
    b["coverageSummary"].update(goodSpans=0, lowSpans=1)
good("same-bytes-low-quality", i, ["uncertain"])
i = deepcopy(base)
i["bundles"]["v-new"]["parserVersion"] = "new-parser"
good("same-bytes-parser-changed", i, ["uncertain"])
i = deepcopy(base)
b = parse_bytes(b"Rule\n", "v-new", "TXT")
i["bundles"]["v-new"] = b
i["newSnapshot"]["entries"][0]["format"] = "TXT"
good("format-change", i, ["uncertain"])
good(
    "unicode-codepoint-order",
    input_for(
        [("\ue000.md", "u-old", "One\n"), ("😀.md", "e-old", "Two\n")],
        [("\ue000.md", "u-new", "One\n"), ("😀.md", "e-new", "Two\n")],
    ),
    ["unchanged", "unchanged"],
)
for name, mutation in [
    (
        "same-hash-inconsistent-size",
        lambda i: i["newSnapshot"]["entries"][0].update(sizeBytes=999),
    ),
    (
        "incorrect-block-count",
        lambda i: i["bundles"]["v-old"]["coverageSummary"].update(totalBlocks=999),
    ),
    (
        "partial-empty-reason",
        lambda i: i["newSnapshot"].update(
            enumerationStatus="PARTIAL", enumerationReason=" "
        ),
    ),
    ("cross-repo", lambda i: i["newSnapshot"].update(repositoryId="elsewhere")),
    ("scope-change", lambda i: i["newSnapshot"]["scope"].update(include=["docs/**"])),
    ("same-snapshot", lambda i: i["newSnapshot"].update(snapshotId="old")),
    ("missing-completeness", lambda i: i["newSnapshot"].pop("enumerationStatus")),
    (
        "partial-without-reason",
        lambda i: i["newSnapshot"].update(enumerationStatus="PARTIAL"),
    ),
    (
        "duplicate-path",
        lambda i: i["oldSnapshot"]["entries"].append(
            deepcopy(i["oldSnapshot"]["entries"][0])
        ),
    ),
    ("traversal-path", lambda i: i["oldSnapshot"]["entries"][0].update(path="../a.md")),
    ("absolute-path", lambda i: i["oldSnapshot"]["entries"][0].update(path="/a.md")),
    (
        "backslash-path",
        lambda i: i["oldSnapshot"]["entries"][0].update(path="docs\\a.md"),
    ),
    (
        "bundle-wrong-id",
        lambda i: i["bundles"]["v-old"].update(documentVersionId="forged"),
    ),
    (
        "bundle-wrong-status",
        lambda i: i["newSnapshot"]["entries"][0].update(parseStatus="FAILED"),
    ),
    (
        "bundle-extra",
        lambda i: i["bundles"].update(extra=deepcopy(i["bundles"]["v-old"])),
    ),
    (
        "missing-raw-hash",
        lambda i: i["oldSnapshot"]["entries"][0].update(checksum=None),
    ),
    ("invalid-hash", lambda i: i["oldSnapshot"]["entries"][0].update(checksum="fake")),
    (
        "too-many-files",
        lambda i: i["oldSnapshot"].update(
            entries=[
                {**i["oldSnapshot"]["entries"][0], "path": f"f{n}.md"}
                for n in range(201)
            ]
        ),
    ),
    (
        "version-content-conflict",
        lambda i: i["newSnapshot"]["entries"][0].update(
            documentVersionId="v-old", checksum="f" * 64
        ),
    ),
]:
    i = deepcopy(base)
    mutation(i)
    bad_input(name, i)
for name, mutation in [
    ("invented-path", lambda r: r["fileChanges"][0]["old"].update(path="forged.md")),
    ("wrong-hash", lambda r: r["fileChanges"][0]["new"].update(checksum="f" * 64)),
    (
        "omitted-files-self-balanced",
        lambda r: r.update(
            fileChanges=[],
            coverage=dict(oldFiles=0, newFiles=0, oldCovered=0, newCovered=0),
        ),
    ),
    (
        "duplicate-result",
        lambda r: r["fileChanges"].append(deepcopy(r["fileChanges"][0])),
    ),
    ("wrong-snapshot", lambda r: r.update(newSnapshotId="wrong")),
    ("wrong-kind", lambda r: r["fileChanges"][0].update(kind="renamed")),
    ("wrong-complete", lambda r: r.update(complete=False)),
    ("wrong-count", lambda r: r["coverage"].update(oldCovered=0)),
    ("automatic-approval", lambda r: r.update(requiresHumanReview=False)),
]:
    r = deepcopy(base_report)
    mutation(r)
    bad_report(name, base, r)
r = deepcopy(mod_report)
r["fileChanges"][0]["spanReport"]["changes"][0]["old"]["quotedText"] = "fake source"
bad_report("forged-span", mod, r)
r = deepcopy(mod_report)
r["fileChanges"][0]["spanReport"]["changes"] = []
bad_report("omitted-span-diff", mod, r)
x = next(v for v in vectors if v["name"] == "same-bytes-low-quality")
r = deepcopy(x["report"])
r["fileChanges"][0].update(kind="unchanged", reasonCode=None, reason=None)
r["complete"] = True
bad_report("unreadable-marked-unchanged", x["input"], r)
x = next(v for v in vectors if v["name"] == "incomplete-scan-no-removal")
r = deepcopy(x["report"])
r["fileChanges"][0].update(kind="removed", reasonCode=None, reason=None)
bad_report("partial-marked-removed", x["input"], r)
x = next(v for v in vectors if v["name"] == "unicode-codepoint-order")
r = deepcopy(x["report"])
r["fileChanges"].reverse()
bad_report("unstable-output-order", x["input"], r)
write(
    ROOT / "packages/contracts/fixtures/snapshot-diff-conformance.json",
    dict(version="snapshot-diff-v1", synthetic=True, vectors=vectors),
)
print(f"wrote {len(vectors)} shared vectors")
