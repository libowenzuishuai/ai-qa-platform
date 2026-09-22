"""Bounded snapshot diff. Wire shapes are authored in Zod; never approves assets.

Manifest checksums describe ORIGINAL BYTES, supplied by a trusted collector.
The collector must verify repository scope/completeness and checksum on loading;
this pure module has no filesystem or database authority and never fetches files.
"""

from __future__ import annotations
from collections import defaultdict
from copy import deepcopy
from typing import Any
from ..contracts.validation import (
    validate_shape,
    validate_bundle,
    validate_source_comparison,
)
from ..errors import ServiceError
from .compare import compare_bundles

MAX_FILES = 200
MAX_SPANS = 40000
MAX_CHARS = 2000000
REASONS = {
    "SNAPSHOT_INCOMPLETE": "对侧枚举不完整，不能据缺失认定新增或删除",
    "FETCH_UNAVAILABLE": "文件未成功获取，不能确认来源变化",
    "PARSE_UNAVAILABLE": "解析未完成或 bundle 缺失，不能确认来源内容",
    "SOURCE_QUALITY_UNCERTAIN": "来源未解析或质量不足，需人工复核",
    "FORMAT_CHANGED": "资料格式变化，不能直接对应来源位置",
    "PARSE_CHANGED": "文件字节相同但解析版本或产物发生变化，需复核",
    "AMBIGUOUS_RENAME": "相同内容存在多个候选路径，无法唯一确认重命名",
}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _path(value):
    return (
        bool(value)
        and len(value.encode("utf-16-le")) // 2 <= 1024
        and not any(ord(c) < 32 or ord(c) == 127 or c in "\\:" for c in value)
        and all(p not in {"", ".", ".."} for p in value.split("/"))
    )


def _scope(s):
    return (
        s["root"],
        tuple(sorted(s["include"])),
        tuple(sorted(s["exclude"])),
        s["policyVersion"],
    )


def validate_snapshot_input(data: dict) -> None:
    try:
        validate_shape("SnapshotDiffInput", data)
        old, new = data["oldSnapshot"], data["newSnapshot"]
        _require(old["repositoryId"] == new["repositoryId"], "快照不属于同一仓库")
        _require(old["snapshotId"] != new["snapshotId"], "对比需要不同快照")
        _require(_scope(old["scope"]) == _scope(new["scope"]), "扫描范围或策略不一致")
        versions = {}
        byte_sizes = {}
        for snap in (old, new):
            scope = snap["scope"]
            _require(scope["root"] == "" or _path(scope["root"]), "根目录非法")
            _require(
                all(_path(p) for p in scope["include"] + scope["exclude"]),
                "范围路径非法",
            )
            _require(
                len(set(scope["include"])) == len(scope["include"])
                and len(set(scope["exclude"])) == len(scope["exclude"]),
                "范围重复",
            )
            _require(
                len({e["path"] for e in snap["entries"]}) == len(snap["entries"]),
                "快照路径重复",
            )
            _require(
                snap["enumerationReason"] is None
                or bool(snap["enumerationReason"].strip()),
                "扫描完整性说明不能为空白",
            )
            _require(
                (snap["enumerationStatus"] == "COMPLETE")
                == (snap["enumerationReason"] is None),
                "扫描完整性说明不一致",
            )
            for e in snap["entries"]:
                _require(_path(e["path"]), "路径必须为规范化仓库相对路径")
                _require(
                    not scope["root"] or e["path"].startswith(scope["root"] + "/"),
                    "文件不在扫描根目录",
                )
                if e["fetchStatus"] == "OK":
                    _require(
                        e["checksum"] is not None
                        and e["sizeBytes"] is not None
                        and e["format"] is not None,
                        "成功取得文件缺字节元数据",
                    )
                else:
                    _require(
                        e["documentVersionId"] is None and e["parseStatus"] is None,
                        "未取得文件不得声称已解析",
                    )
                _require(
                    (e["documentVersionId"] is None) == (e["parseStatus"] is None),
                    "解析状态与版本标识不一致",
                )
                if e["fetchStatus"] == "OK":
                    _require(
                        e["checksum"] not in byte_sizes
                        or byte_sizes[e["checksum"]] == e["sizeBytes"],
                        "相同字节哈希的文件大小矛盾",
                    )
                    byte_sizes[e["checksum"]] = e["sizeBytes"]
                id = e["documentVersionId"]
                if id:
                    meta = (
                        e["checksum"],
                        e["sizeBytes"],
                        e["format"],
                        e["parseStatus"],
                    )
                    _require(
                        id not in versions or versions[id] == meta,
                        "同一解析版本元数据冲突",
                    )
                    versions[id] = meta
                    b = data["bundles"].get(id)
                    if b is not None:
                        _require(
                            b["documentVersionId"] == id
                            and b["format"] == e["format"]
                            and b["parseStatus"] == e["parseStatus"],
                            "bundle 归属/格式/状态不匹配",
                        )
        _require(len(data["bundles"]) <= MAX_FILES * 2, "bundle 数量超限")
        spans = chars = 0
        for id, b in data["bundles"].items():
            _require(id in versions, "bundle 未被快照引用")
            validate_bundle(b)
            _require(
                b["coverageSummary"]["totalBlocks"] == len(b["blocks"]),
                "解析块数与实际内容不一致",
            )
            _require(
                len({s["id"] for s in b["spans"]}) == len(b["spans"])
                and len({s["id"] for s in b["blocks"]}) == len(b["blocks"]),
                "bundle 标识重复",
            )
            spans += len(b["spans"])
            chars += sum(len(x["text"]) for x in b["blocks"]) + sum(
                len(x["quotedText"] or "") for x in b["spans"]
            )
        _require(spans <= MAX_SPANS and chars <= MAX_CHARS, "快照内容超过比较预算")
    except ServiceError as exc:
        raise ValueError(str(exc)) from exc


def _issue(entry, bundles):
    if entry["fetchStatus"] != "OK":
        return "FETCH_UNAVAILABLE"
    bundle = bundles.get(entry["documentVersionId"])
    if bundle is None or entry["parseStatus"] not in {"PARSED", "NEEDS_OCR"}:
        return "PARSE_UNAVAILABLE"
    if (
        bundle["parseStatus"] != "PARSED"
        or not bundle["spans"]
        or any(s.get("extractionQuality", "GOOD") != "GOOD" for s in bundle["spans"])
    ):
        return "SOURCE_QUALITY_UNCERTAIN"
    return None


def _parsed(bundle):
    return dict(
        format=bundle["format"],
        parserVersion=bundle["parserVersion"],
        blocks=[{k: v for k, v in b.items() if k != "id"} for b in bundle["blocks"]],
        spans=[
            {
                **{k: v for k, v in s.items() if k not in {"id", "documentVersionId"}},
                "extractionQuality": s.get("extractionQuality", "GOOD"),
            }
            for s in bundle["spans"]
        ],
    )


def _expected(data):
    """Pair every enumerated input exactly once; byte hashes are never inferred from text."""
    old = {e["path"]: e for e in data["oldSnapshot"]["entries"]}
    new = {e["path"]: e for e in data["newSnapshot"]["entries"]}
    rows = []

    def add(a, b, forced=None):
        code = forced
        if code is None:
            if (
                a is None and data["oldSnapshot"]["enumerationStatus"] != "COMPLETE"
            ) or (b is None and data["newSnapshot"]["enumerationStatus"] != "COMPLETE"):
                code = "SNAPSHOT_INCOMPLETE"
            else:
                code = (_issue(a, data["bundles"]) if a else None) or (
                    _issue(b, data["bundles"]) if b else None
                )
        kind = "uncertain"
        if code is None and a and b:
            if a["format"] != b["format"]:
                code = "FORMAT_CHANGED"
            elif a["checksum"] == b["checksum"]:
                if _parsed(data["bundles"][a["documentVersionId"]]) != _parsed(
                    data["bundles"][b["documentVersionId"]]
                ):
                    code = "PARSE_CHANGED"
                else:
                    kind = "unchanged" if a["path"] == b["path"] else "renamed"
            else:
                kind = "modified"
        elif code is None:
            kind = "removed" if a else "added"
        rows.append(
            dict(
                kind="uncertain" if code else kind,
                old=a,
                new=b,
                reasonCode=code,
                reason=REASONS[code] if code else None,
                spanReport=None,
            )
        )

    for p in sorted(old.keys() & new.keys()):
        add(old.pop(p), new.pop(p))

    def by_hash(entries):
        index = defaultdict(list)
        for entry in entries.values():
            if entry["fetchStatus"] == "OK" and entry["checksum"]:
                index[entry["checksum"]].append(entry)
        return index

    oh, nh = by_hash(old), by_hash(new)
    for h in sorted(oh.keys() & nh.keys()):
        aa, bb = oh[h], nh[h]
        if len(aa) == len(bb) == 1:
            add(aa[0], bb[0])
            old.pop(aa[0]["path"])
            new.pop(bb[0]["path"])
        else:
            for a in aa:
                add(a, None, "AMBIGUOUS_RENAME")
                old.pop(a["path"])
            for b in bb:
                add(None, b, "AMBIGUOUS_RENAME")
                new.pop(b["path"])
    for a in old.values():
        add(a, None)
    for b in new.values():
        add(None, b)
    return sorted(
        rows,
        key=lambda r: (
            (r["old"] or r["new"])["path"],
            r["new"]["path"] if r["new"] else "",
        ),
    )


def _coverage(data):
    old, new = len(data["oldSnapshot"]["entries"]), len(data["newSnapshot"]["entries"])
    return dict(oldFiles=old, newFiles=new, oldCovered=old, newCovered=new)


def _complete(data, rows):
    return all(
        data[s]["enumerationStatus"] == "COMPLETE"
        for s in ("oldSnapshot", "newSnapshot")
    ) and all(r["kind"] != "uncertain" for r in rows)


def validate_snapshot_diff(data: dict, report: dict) -> None:
    """Validate external results against frozen manifests AND actual source bundles."""
    validate_snapshot_input(data)
    try:
        validate_shape("SnapshotDiffReport", report)
        rows = _expected(data)
        _require(len(rows) == len(report["fileChanges"]), "报告遗漏或增加文件")
        _require(
            report["oldSnapshotId"] == data["oldSnapshot"]["snapshotId"]
            and report["newSnapshotId"] == data["newSnapshot"]["snapshotId"],
            "报告快照标识错误",
        )
        _require(report["coverage"] == _coverage(data), "覆盖计数与冻结输入不一致")
        _require(report["complete"] == _complete(data, rows), "报告完整性错误")
        for expected, actual in zip(rows, report["fileChanges"]):
            for field in ("kind", "old", "new", "reasonCode"):
                _require(
                    actual[field] == expected[field],
                    "报告路径/元数据/结论/原因与冻结输入不一致或顺序不稳定",
                )
            _require(
                bool(actual["reason"] and actual["reason"].strip())
                == bool(expected["reasonCode"]),
                "原因缺失或多余",
            )
            if expected["kind"] == "modified":
                _require(actual["spanReport"] is not None, "修改缺少片段报告")
                a, b = expected["old"], expected["new"]
                validate_source_comparison(
                    dict(
                        path=a["path"],
                        oldBundle=data["bundles"][a["documentVersionId"]],
                        newBundle=data["bundles"][b["documentVersionId"]],
                    ),
                    actual["spanReport"],
                )
            else:
                _require(actual["spanReport"] is None, "非修改项不得附无关片段报告")
    except ServiceError as exc:
        raise ValueError(str(exc)) from exc


def compare_snapshots(
    old_snapshot: dict[str, Any],
    new_snapshot: dict[str, Any],
    *,
    bundles: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    data = dict(
        oldSnapshot=old_snapshot, newSnapshot=new_snapshot, bundles=bundles or {}
    )
    validate_snapshot_input(data)
    rows = _expected(data)
    for row in rows:
        if row["kind"] == "modified":
            a, b = row["old"], row["new"]
            row["spanReport"] = compare_bundles(
                a["path"],
                data["bundles"][a["documentVersionId"]],
                data["bundles"][b["documentVersionId"]],
            )
    report = dict(
        oldSnapshotId=old_snapshot["snapshotId"],
        newSnapshotId=new_snapshot["snapshotId"],
        fileChanges=rows,
        complete=_complete(data, rows),
        requiresHumanReview=True,
        coverage=_coverage(data),
    )
    validate_snapshot_diff(data, report)
    return deepcopy(report)
