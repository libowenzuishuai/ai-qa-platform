"""Compare two parse results for the same logical document path (B2).

Pure functions only — no database or HTTP. Output is a proposal shape for A/C;
not yet part of generated contracts.
"""

from __future__ import annotations

import json
from typing import Any, Literal

ChangeKind = Literal["added", "removed", "modified", "uncertain"]


def _locator_key(locator: dict[str, Any]) -> str:
    return json.dumps(locator, sort_keys=True, ensure_ascii=False)


def _span_view(span: dict[str, Any]) -> dict[str, Any]:
    return {
        "spanId": span["id"],
        "documentVersionId": span["documentVersionId"],
        "locator": span["locator"],
        "quotedText": span.get("quotedText"),
        "extractionQuality": span.get("extractionQuality"),
    }


def compare_bundles(
    path: str,
    old_bundle: dict[str, Any],
    new_bundle: dict[str, Any],
) -> dict[str, Any]:
    """Diff span-level sources between two ParsedDocumentBundle dicts."""
    if old_bundle["format"] != new_bundle["format"]:
        raise ValueError("format mismatch between document versions")

    old_spans = old_bundle["spans"]
    new_spans = new_bundle["spans"]
    matched_old: set[int] = set()
    matched_new: set[int] = set()
    changes: list[dict[str, Any]] = []

    def append(kind: ChangeKind, old: dict | None, new: dict | None, reason: str | None):
        changes.append(
            {
                "kind": kind,
                "path": path,
                "old": _span_view(old) if old else None,
                "new": _span_view(new) if new else None,
                "reason": reason,
            }
        )

    # Stable pairs: same locator and same quoted text (including both None).
    for oi, old in enumerate(old_spans):
        for ni, new in enumerate(new_spans):
            if ni in matched_new:
                continue
            if _locator_key(old["locator"]) != _locator_key(new["locator"]):
                continue
            if old.get("quotedText") != new.get("quotedText"):
                continue
            matched_old.add(oi)
            matched_new.add(ni)
            break

    # Same locator, different quoted text → modified.
    for oi, old in enumerate(old_spans):
        if oi in matched_old:
            continue
        for ni, new in enumerate(new_spans):
            if ni in matched_new:
                continue
            if _locator_key(old["locator"]) != _locator_key(new["locator"]):
                continue
            append("modified", old, new, None)
            matched_old.add(oi)
            matched_new.add(ni)
            break

    # Unique quoted text moved to another locator → uncertain (not silent move).
    for oi, old in enumerate(old_spans):
        if oi in matched_old:
            continue
        text = old.get("quotedText")
        if not text:
            continue
        new_candidates = [
            ni
            for ni, new in enumerate(new_spans)
            if ni not in matched_new and new.get("quotedText") == text
        ]
        if len(new_candidates) == 1:
            ni = new_candidates[0]
            new = new_spans[ni]
            if _locator_key(old["locator"]) != _locator_key(new["locator"]):
                append(
                    "uncertain",
                    old,
                    new,
                    "相同原文出现在不同来源坐标，可能为移动或重复，需人工确认",
                )
                matched_old.add(oi)
                matched_new.add(ni)
                continue
        if len(new_candidates) > 1:
            append(
                "uncertain",
                old,
                None,
                "旧版原文在新版中多处重复，无法唯一对应",
            )
            matched_old.add(oi)

    for oi, old in enumerate(old_spans):
        if oi not in matched_old:
            append("removed", old, None, None)

    for ni, new in enumerate(new_spans):
        if ni not in matched_new:
            append("added", None, new, None)

    return {
        "path": path,
        "oldDocumentVersionId": old_bundle["documentVersionId"],
        "newDocumentVersionId": new_bundle["documentVersionId"],
        "format": old_bundle["format"],
        "changes": changes,
    }
