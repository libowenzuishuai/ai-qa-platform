"""Bounded source comparison; shared wire contract authored in packages/contracts."""

from __future__ import annotations

from collections import defaultdict
import json
from typing import Any

from ..contracts.generated import SourceChangeReport
from ..contracts.validation import validate_bundle, validate_source_comparison


def _locator_key(locator: dict[str, Any]) -> str:
    return json.dumps(locator, sort_keys=True, ensure_ascii=False)


def compare_bundles(path: str, old_bundle: dict, new_bundle: dict) -> dict:
    if not isinstance(path, str) or not path.strip():
        raise ValueError("document path is required")
    for bundle in (old_bundle, new_bundle):
        validate_bundle(bundle)
        if bundle["parseStatus"] not in {"PARSED", "NEEDS_OCR"}:
            raise ValueError("document parse is incomplete or failed")
        if len(bundle["spans"]) > 20000 or len(
            {s["id"] for s in bundle["spans"]}
        ) != len(bundle["spans"]):
            raise ValueError("too many or duplicate source spans")
    if old_bundle["documentVersionId"] == new_bundle["documentVersionId"]:
        raise ValueError("comparison requires different document versions")
    if old_bundle["format"] != new_bundle["format"]:
        raise ValueError("format mismatch between document versions")

    old_spans, new_spans = old_bundle["spans"], new_bundle["spans"]
    matched_old, matched_new, changes = set(), set(), []
    old_text, new_text, old_loc, new_loc, old_exact, new_exact = [
        defaultdict(list) for _ in range(6)
    ]
    for spans, texts, locs, exact in (
        (old_spans, old_text, old_loc, old_exact),
        (new_spans, new_text, new_loc, new_exact),
    ):
        for index, span in enumerate(spans):
            loc, text = _locator_key(span["locator"]), span.get("quotedText")
            texts[text].append(index)
            locs[loc].append(index)
            exact[(loc, text)].append(index)

    def append(kind, oi=None, ni=None, reason=None):
        def view(span):
            return {
                k: span.get(k, "GOOD" if k == "extractionQuality" else None)
                for k in (
                    "id",
                    "documentVersionId",
                    "locator",
                    "quotedText",
                    "extractionQuality",
                )
            }

        changes.append(
            dict(
                kind=kind,
                path=path,
                old=view(old_spans[oi]) if oi is not None else None,
                new=view(new_spans[ni]) if ni is not None else None,
                reason=reason,
            )
        )
        if oi is not None:
            matched_old.add(oi)
        if ni is not None:
            matched_new.add(ni)

    # Only uniquely aligned, readable evidence can be called unchanged.
    for pair, olds in old_exact.items():
        news = new_exact.get(pair, [])
        if len(olds) == len(news) == 1:
            oi, ni = olds[0], news[0]
            qualities = [
                old_spans[oi].get("extractionQuality", "GOOD"),
                new_spans[ni].get("extractionQuality", "GOOD"),
            ]
            if qualities != ["GOOD", "GOOD"]:
                append("uncertain", oi, ni, "来源解析质量不足或发生变化，需人工复核")
            else:
                matched_old.add(oi)
                matched_new.add(ni)

    # Resolve exact text moves BEFORE line-number pairing: insertion must not
    # claim the rule at the old line was overwritten by an unrelated new line.
    remaining_text = {
        text: [ni for ni in indices if ni not in matched_new]
        for text, indices in new_text.items()
    }
    for oi, old in enumerate(old_spans):
        if oi in matched_old or not old.get("quotedText"):
            continue
        text = old["quotedText"]
        candidates = remaining_text.get(text, [])
        if len(old_text[text]) == 1 and len(new_text[text]) == 1 and candidates:
            append(
                "uncertain",
                oi,
                candidates[0],
                "相同原文出现在不同来源坐标，可能为移动或重复，需人工确认",
            )
        elif candidates:
            append("uncertain", oi, None, "旧版原文在新旧版本中多处重复，无法唯一对应")

    for loc, olds in old_loc.items():
        olds = [oi for oi in olds if oi not in matched_old]
        news = [ni for ni in new_loc.get(loc, []) if ni not in matched_new]
        if len(olds) == len(news) == 1:
            oi, ni = olds[0], news[0]
            if old_spans[oi].get("quotedText") != new_spans[ni].get("quotedText"):
                append("modified", oi, ni)
        elif olds and news:
            for oi in olds:
                append("uncertain", oi, None, "同一来源坐标存在多个片段，无法唯一对应")

    for oi in range(len(old_spans)):
        if oi not in matched_old:
            append("removed", oi)
    for ni in range(len(new_spans)):
        if ni not in matched_new:
            append("added", ni=ni)
    report = dict(
        path=path,
        oldDocumentVersionId=old_bundle["documentVersionId"],
        newDocumentVersionId=new_bundle["documentVersionId"],
        format=new_bundle["format"],
        changes=changes,
    )
    validate_source_comparison(
        dict(path=path, oldBundle=old_bundle, newBundle=new_bundle), report
    )
    return SourceChangeReport.model_validate(report).model_dump(mode="json")
