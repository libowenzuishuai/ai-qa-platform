"""R01 multi-file snapshot diff. Deterministic; the model never decides enumeration or deletion.

算法顺序（任务书 R01）：
输入完整性校验 → 同路径配对 → 未匹配文件的唯一哈希重命名 →
增删/不确定分组 → 可解析配对的片段比较 → 覆盖对账 → 确定性稳定排序。

关键约束（含评审修复）：
- 未变化/重命名的唯一判据是真实文件字节 sha256（fileChecksum，来自
  DocumentVersion.checksum）；解析产物派生哈希只作 modified 检测辅助，
  不得作为"字节一致"的证据；
- 缺少字节校验和 → 不得给 unchanged/renamed 结论（uncertain）；
- 含未解析内容（unparsedSpans>0）的文件不得判未变化（uncertain）；
- 重命名判定只认唯一字节哈希，不把名称相似当证据；
  重命名并修改、多处重复内容 → 不确定/增删，不猜测；
- 解析失败/未取到的文件归 uncertain，绝不默默丢弃；
- 每个输入文件在两侧各被覆盖恰好一次（对账失败即抛错）；
- 输出按路径 Unicode 码点序稳定排序，同一输入必然同一输出。
"""
from __future__ import annotations

import hashlib
import json

from .compare import compare_bundles

MAX_FILES_PER_SIDE = 200
MAX_OUTCOMES = 400


class MultiFileLimit(ValueError):
    """多文件输入不完整或超过预算。"""


def content_hash(bundle: dict) -> str:
    """解析产物指纹：覆盖解析版本、格式与全部片段文本+质量（不含版本 ID）。

    仅用于 modified 检测辅助（质量退化可见）；不能证明文件字节一致。
    """
    payload = {
        "parserVersion": bundle.get("parserVersion"),
        "format": bundle.get("format"),
        "parseStatus": bundle.get("parseStatus"),
        "spans": [
            {
                "text": s.get("quotedText"),
                "quality": s.get("extractionQuality", "GOOD"),
                "locator": _canon(s.get("locator")),
            }
            for s in bundle.get("spans") or []
        ],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def _canon(locator: dict | None) -> str:
    return json.dumps(locator, sort_keys=True, ensure_ascii=False)


def _has_unparsed(bundle: dict) -> bool:
    summary = bundle.get("coverageSummary") or {}
    return bool(summary.get("unparsedSpans"))


def _byte_checksum(entry: dict) -> str | None:
    """真实文件字节 sha256（调用方从 DocumentVersion.checksum 提供）。"""
    value = entry.get("fileChecksum")
    if isinstance(value, str) and len(value) == 64:
        return value
    return None


def compare_files(input_data: dict) -> dict:
    old_files: list[dict] = input_data["oldFiles"]
    new_files: list[dict] = input_data["newFiles"]
    excluded: list[str] = input_data.get("excludedPaths") or []

    # 1. 输入完整性校验。
    if not old_files or not new_files:
        raise MultiFileLimit("两侧快照都不能为空")
    if len(old_files) > MAX_FILES_PER_SIDE or len(new_files) > MAX_FILES_PER_SIDE:
        raise MultiFileLimit(f"单侧文件数超过 {MAX_FILES_PER_SIDE} 上限")
    for side, files in (("oldFiles", old_files), ("newFiles", new_files)):
        seen = set()
        for entry in files:
            path = entry.get("path") or ""
            if not path.strip() or len(path) > 1024:
                raise MultiFileLimit(f"{side} 路径为空或过长")
            if path in seen:
                raise MultiFileLimit(f"{side} 路径重复：{path}")
            seen.add(path)

    old_by_path = {e["path"]: e for e in old_files}
    new_by_path = {e["path"]: e for e in new_files}

    outcomes: list[dict] = []
    covered_old: set[str] = set()
    covered_new: set[str] = set()

    def emit(kind, old_path, new_path, hash_, fragment=None, reason=None):
        if old_path is not None:
            if old_path in covered_old:
                raise MultiFileLimit(f"旧路径重复归属：{old_path}")
            covered_old.add(old_path)
        if new_path is not None:
            if new_path in covered_new:
                raise MultiFileLimit(f"新路径重复归属：{new_path}")
            covered_new.add(new_path)
        outcomes.append(
            {
                "kind": kind,
                "oldPath": old_path,
                "newPath": new_path,
                "contentHash": hash_,
                "fragmentReport": fragment,
                "reason": reason,
            }
        )

    # 2. 同路径配对。
    same_paths = sorted(set(old_by_path) & set(new_by_path))
    for path in same_paths:
        old_entry, new_entry = old_by_path[path], new_by_path[path]
        old_bundle, new_bundle = old_entry["bundle"], new_entry["bundle"]
        statuses = {old_bundle.get("parseStatus"), new_bundle.get("parseStatus")}
        if not statuses <= {"PARSED", "NEEDS_OCR"}:
            emit(
                "uncertain", path, path, None,
                reason="一侧或两侧解析失败/未取到，无法比较",
            )
            continue
        old_bytes, new_bytes = _byte_checksum(old_entry), _byte_checksum(new_entry)
        if old_bytes is None or new_bytes is None:
            # 评审修复（#2）：没有真实字节校验和，不得宣称未变化。
            emit(
                "uncertain", path, path, content_hash(new_bundle),
                reason="缺少文件字节校验和，无法判定未变化",
            )
            continue
        if old_bytes == new_bytes:
            if _has_unparsed(old_bundle) or _has_unparsed(new_bundle):
                # 评审修复（#3）：同字节但含未解析片段 → 不能判未变化。
                emit(
                    "uncertain", path, path, old_bytes,
                    reason="文件含未解析内容，不能判定未变化，需人工核对",
                )
                continue
            if content_hash(old_bundle) != content_hash(new_bundle):
                # 同字节但解析形态/质量变化（如重解析降质）→ 不能静默判未变化。
                emit(
                    "uncertain", path, path, old_bytes,
                    reason="文件字节一致但解析形态或质量发生变化，需人工核对",
                )
                continue
            emit("unchanged", path, path, old_bytes)
            continue
        # 字节不同：进入片段比较（跨格式/解析失败在下方处理）。
        # 5. 可解析配对的片段比较（复用单文件口径）。
        if old_bundle.get("format") != new_bundle.get("format"):
            emit(
                "uncertain", path, path, None,
                reason="跨格式变更（旧新格式不同），需人工确认对应关系",
            )
            continue
        try:
            fragment = compare_bundles(path, old_bundle, new_bundle)
        except ValueError as exc:
            emit("uncertain", path, path, None, reason=f"片段比较失败：{exc}")
            continue
        emit("modified", path, path, new_bytes, fragment=fragment)

    # 3. 未匹配文件的唯一字节哈希重命名（只认同字节唯一匹配）。
    unmatched_old = sorted(set(old_by_path) - covered_old)
    unmatched_new = sorted(set(new_by_path) - covered_new)

    def hash_index(paths, by_path):
        """按真实字节哈希索引；缺哈希或解析失败的不参与重命名。"""
        index: dict[str, list[str]] = {}
        for path in paths:
            entry = by_path[path]
            bundle = entry["bundle"]
            if bundle.get("parseStatus") not in {"PARSED", "NEEDS_OCR"}:
                continue  # 解析失败的不参与重命名判定
            checksum = _byte_checksum(entry)
            if checksum is None:
                continue  # 无字节证据：不能作为重命名依据
            index.setdefault(checksum, []).append(path)
        return index

    old_hashes = hash_index(unmatched_old, old_by_path)
    new_hashes = hash_index(unmatched_new, new_by_path)
    renamed_new: set[str] = set()
    for hash_, old_paths in sorted(old_hashes.items()):
        new_paths = new_hashes.get(hash_, [])
        if len(old_paths) == 1 and len(new_paths) == 1:
            # 字节一致即重命名铁证（与解析质量无关）；含未解析内容时附注提示。
            note = None
            if _has_unparsed(old_by_path[old_paths[0]]["bundle"]) or _has_unparsed(
                new_by_path[new_paths[0]]["bundle"]
            ):
                note = "字节一致重命名；文件含未解析内容，片段级内容未核对"
            emit("renamed", old_paths[0], new_paths[0], hash_, reason=note)
            renamed_new.add(new_paths[0])
        elif len(new_paths) > 0:
            # 重复内容多个候选：不确定，不猜测。
            for path in old_paths:
                emit(
                    "uncertain", path, None, hash_,
                    reason="相同内容存在多个候选对应，无法唯一判定重命名",
                )
            for path in new_paths:
                if path not in renamed_new:
                    emit(
                        "uncertain", None, path, hash_,
                        reason="相同内容存在多个候选对应，无法唯一判定重命名",
                    )

    # 4. 增删/不确定分组。
    for path in unmatched_old:
        if path in covered_old:
            continue
        entry = old_by_path[path]
        bundle = entry["bundle"]
        if bundle.get("parseStatus") not in {"PARSED", "NEEDS_OCR"}:
            emit("uncertain", path, None, None, reason="旧版解析失败/未取到")
        else:
            emit("removed", path, None, _byte_checksum(entry) or content_hash(bundle))
    for path in unmatched_new:
        if path in covered_new:
            continue
        entry = new_by_path[path]
        bundle = entry["bundle"]
        if bundle.get("parseStatus") not in {"PARSED", "NEEDS_OCR"}:
            emit("uncertain", None, path, None, reason="新版解析失败/未取到")
        else:
            emit("added", None, path, _byte_checksum(entry) or content_hash(bundle))

    # 6. 覆盖对账：每个输入文件恰好被覆盖一次。
    if covered_old != set(old_by_path) or covered_new != set(new_by_path):
        missing_old = sorted(set(old_by_path) - covered_old)
        missing_new = sorted(set(new_by_path) - covered_new)
        raise MultiFileLimit(
            f"覆盖对账失败：旧缺失 {missing_old}，新缺失 {missing_new}"
        )
    if len(outcomes) > MAX_OUTCOMES:
        raise MultiFileLimit(f"结局数超过 {MAX_OUTCOMES} 上限")

    # 7. 确定性稳定排序（码点序；added 无旧路径按新路径排）。
    outcomes.sort(key=lambda o: (o["oldPath"] or o["newPath"] or "", o["newPath"] or ""))

    def count(kind: str) -> int:
        return sum(1 for o in outcomes if o["kind"] == kind)

    all_paths = set(old_by_path) | set(new_by_path)
    return {
        "outcomes": outcomes,
        "totals": {
            "oldFiles": len(old_by_path),
            "newFiles": len(new_by_path),
            "unchanged": count("unchanged"),
            "modified": count("modified"),
            "added": count("added"),
            "removed": count("removed"),
            "renamed": count("renamed"),
            "uncertain": count("uncertain"),
        },
        "excludedPaths": excluded,
        "exclusionsChanged": any(p in all_paths for p in excluded),
        "truncated": False,
    }
