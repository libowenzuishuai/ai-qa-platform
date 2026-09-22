"""Multi-file repository snapshot diff (proposal shape until A freezes shared contract)."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Literal

from .compare import compare_bundles

FileKind = Literal["unchanged", "added", "removed", "modified", "uncertain"]
ParseOk = frozenset({"PARSED", "NEEDS_OCR"})


def _entry_removable(entry: dict[str, Any]) -> bool:
    if entry.get("fetchStatus", "OK") != "OK":
        return False
    return entry.get("parseStatus") in ParseOk


def _append(
    changes: list[dict[str, Any]],
    kind: FileKind,
    *,
    path: str | None = None,
    old_path: str | None = None,
    new_path: str | None = None,
    old_entry: dict | None = None,
    new_entry: dict | None = None,
    reason: str | None = None,
    span_report: dict | None = None,
):
    row: dict[str, Any] = {"kind": kind}
    if path is not None:
        row["path"] = path
    if old_path is not None:
        row["oldPath"] = old_path
    if new_path is not None:
        row["newPath"] = new_path
    if old_entry is not None:
        row["oldChecksum"] = old_entry.get("checksum")
        row["oldDocumentVersionId"] = old_entry.get("documentVersionId")
        row["oldFetchStatus"] = old_entry.get("fetchStatus", "OK")
        row["oldParseStatus"] = old_entry.get("parseStatus")
    if new_entry is not None:
        row["newChecksum"] = new_entry.get("checksum")
        row["newDocumentVersionId"] = new_entry.get("documentVersionId")
        row["newFetchStatus"] = new_entry.get("fetchStatus", "OK")
        row["newParseStatus"] = new_entry.get("parseStatus")
    if reason:
        row["reason"] = reason
    if span_report is not None:
        row["spanReport"] = span_report
    changes.append(row)


def compare_snapshots(
    old_snapshot: dict[str, Any],
    new_snapshot: dict[str, Any],
    *,
    bundles: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Diff two snapshot manifests. bundles maps documentVersionId -> ParsedDocumentBundle dict."""
    bundles = bundles or {}
    old_entries = {e["path"]: e for e in old_snapshot["entries"]}
    new_entries = {e["path"]: e for e in new_snapshot["entries"]}
    old_paths, new_paths = set(old_entries), set(new_entries)
    matched_old, matched_new = set(), set()
    file_changes: list[dict[str, Any]] = []

    for path in sorted(old_paths & new_paths):
        old_e, new_e = old_entries[path], new_entries[path]
        if old_e["checksum"] == new_e["checksum"]:
            _append(
                file_changes,
                "unchanged",
                path=path,
                old_entry=old_e,
                new_entry=new_e,
            )
            matched_old.add(path)
            matched_new.add(path)
            continue
        matched_old.add(path)
        matched_new.add(path)
        span_report = None
        oid, nid = old_e.get("documentVersionId"), new_e.get("documentVersionId")
        if oid and nid and oid in bundles and nid in bundles:
            if (
                _entry_removable(old_e)
                and new_e.get("fetchStatus", "OK") == "OK"
                and new_e.get("parseStatus") in ParseOk
            ):
                span_report = compare_bundles(path, bundles[oid], bundles[nid])
        _append(
            file_changes,
            "modified",
            path=path,
            old_entry=old_e,
            new_entry=new_e,
            span_report=span_report,
        )

    old_by_sum: dict[str, list[str]] = defaultdict(list)
    new_by_sum: dict[str, list[str]] = defaultdict(list)
    for p in old_paths - matched_old:
        old_by_sum[old_entries[p]["checksum"]].append(p)
    for p in new_paths - matched_new:
        new_by_sum[new_entries[p]["checksum"]].append(p)

    dup_reason = "相同内容在新旧快照中多处出现，无法唯一对应路径"
    for checksum in sorted(set(old_by_sum) & set(new_by_sum)):
        olds, news = old_by_sum[checksum], new_by_sum[checksum]
        if len(olds) == 1 and len(news) == 1:
            op, np = olds[0], news[0]
            _append(
                file_changes,
                "uncertain",
                old_path=op,
                new_path=np,
                old_entry=old_entries[op],
                new_entry=new_entries[np],
                reason="内容校验和唯一匹配，可能为重命名，需人工确认",
            )
            matched_old.add(op)
            matched_new.add(np)
        elif olds and news:
            for op in olds:
                if op in matched_old:
                    continue
                _append(
                    file_changes,
                    "uncertain",
                    old_path=op,
                    old_entry=old_entries[op],
                    reason=dup_reason,
                )
                matched_old.add(op)
            for np in news:
                if np in matched_new:
                    continue
                _append(
                    file_changes,
                    "uncertain",
                    new_path=np,
                    new_entry=new_entries[np],
                    reason=dup_reason,
                )
                matched_new.add(np)

    for path in sorted(old_paths - matched_old):
        old_e = old_entries[path]
        if _entry_removable(old_e):
            _append(file_changes, "removed", path=path, old_entry=old_e)
        else:
            _append(
                file_changes,
                "uncertain",
                old_path=path,
                old_entry=old_e,
                reason="旧版文件未成功获取或解析，不能认定为删除",
            )
        matched_old.add(path)

    for path in sorted(new_paths - matched_new):
        _append(file_changes, "added", path=path, new_entry=new_entries[path])
        matched_new.add(path)

    return {
        "oldSnapshotId": old_snapshot["snapshotId"],
        "newSnapshotId": new_snapshot["snapshotId"],
        "fileChanges": file_changes,
    }
