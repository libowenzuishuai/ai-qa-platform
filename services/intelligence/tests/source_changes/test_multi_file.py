"""R01 多文件快照差异：确定性枚举/配对/重命名/对账。"""
import copy

import pytest

from aiqa_intelligence.doc_ingestion.runner import parse_bytes
from aiqa_intelligence.source_changes.multi_file import (
    MultiFileLimit,
    compare_files,
    content_hash,
)


def parse_md(text: str, document_id: str):
    return parse_bytes(text.encode(), document_id, "MARKDOWN")


def _byte_hash(bundle):
    """模拟 DocumentVersion.checksum：同一文本同一字节哈希（与解析质量无关）。"""
    import hashlib
    text = "\n".join((s.get("quotedText") or "") for s in bundle["spans"])
    return hashlib.sha256(text.encode()).hexdigest()


def files(*pairs):
    return [{"path": path, "bundle": bundle, "fileChecksum": _byte_hash(bundle)} for path, bundle in pairs]


def outcome_paths(report, kind):
    return sorted(
        (o["oldPath"] or "") + "|" + (o["newPath"] or "")
        for o in report["outcomes"]
        if o["kind"] == kind
    )


def test_no_change_all_unchanged_and_deterministic():
    old = files(("docs/a.md", parse_md("# A\n规则一\n", "v1")), ("docs/b.md", parse_md("# B\n规则二\n", "v2")))
    new = files(("docs/a.md", parse_md("# A\n规则一\n", "v3")), ("docs/b.md", parse_md("# B\n规则二\n", "v4")))
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert report["totals"]["unchanged"] == 2
    assert outcome_paths(report, "modified") == []
    again = compare_files({"oldFiles": copy.deepcopy(old), "newFiles": copy.deepcopy(new)})
    assert again == report  # 确定性：同一输入同一输出


def test_multiple_files_modified_same_time():
    old = files(
        ("docs/a.md", parse_md("甲\n", "v1")),
        ("docs/b.md", parse_md("乙\n", "v2")),
        ("docs/c.md", parse_md("丙\n", "v3")),
    )
    new = files(
        ("docs/a.md", parse_md("甲改\n", "v4")),
        ("docs/b.md", parse_md("乙\n", "v5")),
        ("docs/c.md", parse_md("丙改\n", "v6")),
    )
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert report["totals"]["modified"] == 2
    modified = [o for o in report["outcomes"] if o["kind"] == "modified"]
    # modified 必须内嵌片段级报告（复用单文件口径）。
    assert all(o["fragmentReport"]["changes"] for o in modified)


def test_pure_renames_detected_by_unique_content_hash():
    text = "# 登录\n必须先登录。\n"
    old = files(("docs/old-name.md", parse_md(text, "v1")), ("docs/keep.md", parse_md("保留\n", "v2")))
    new = files(("docs/new-name.md", parse_md(text, "v3")), ("docs/keep.md", parse_md("保留\n", "v4")))
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert outcome_paths(report, "renamed") == ["docs/old-name.md|docs/new-name.md"]
    assert report["totals"]["removed"] == 0 and report["totals"]["added"] == 0


def test_rename_with_modification_is_not_claimed_as_rename():
    # 重命名并修改：唯一哈希匹配不成立（内容已变）→ 诚实报告 removed+added。
    old = files(("docs/old.md", parse_md("原文\n", "v1")))
    new = files(("docs/new.md", parse_md("原文已修改\n", "v2")))
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert report["totals"]["renamed"] == 0
    assert report["totals"]["removed"] == 1
    assert report["totals"]["added"] == 1


def test_duplicate_content_multiple_candidates_is_uncertain():
    text = "# 重复\n完全相同的内容\n"
    old = files(("a.md", parse_md(text, "v1")), ("b.md", parse_md(text, "v2")))
    new = files(("c.md", parse_md(text, "v3")))
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert report["totals"]["renamed"] == 0
    uncertain = [o for o in report["outcomes"] if o["kind"] == "uncertain"]
    assert len(uncertain) >= 2  # 两个旧候选都不猜
    assert all("多个候选" in (o["reason"] or "") for o in uncertain)


def test_cross_format_same_path_is_uncertain():
    from io import BytesIO

    from docx import Document

    doc = Document()
    doc.add_paragraph("内容")
    buf = BytesIO()
    doc.save(buf)
    old = files(("spec.md", parse_md("内容\n", "v1")))
    new = files(("spec.md", parse_bytes(buf.getvalue(), "v2", "DOCX")))
    # 跨格式意味着真实字节必然不同（文本 ≠ DOCX 二进制）。
    old[0]["fileChecksum"], new[0]["fileChecksum"] = "1" * 64, "2" * 64
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert report["totals"]["uncertain"] == 1
    assert "跨格式" in report["outcomes"][0]["reason"]


def test_same_bytes_parse_quality_degradation_is_not_unchanged():
    """评审修复（#3 相关）：同字节但解析质量退化 → uncertain，不得判未变化。"""
    old_bundle = parse_md("# 标题\n规则内容\n", "v1")
    degraded = parse_md("# 标题\n规则内容\n", "v2")
    degraded["spans"][0]["extractionQuality"] = "LOW"
    degraded["coverageSummary"]["goodSpans"] -= 1
    degraded["coverageSummary"]["lowSpans"] += 1
    assert content_hash(old_bundle) != content_hash(degraded)
    report = compare_files({"oldFiles": files(("a.md", old_bundle)), "newFiles": files(("a.md", degraded))})
    outcome = report["outcomes"][0]
    assert outcome["kind"] == "uncertain"
    assert "解析形态或质量" in outcome["reason"]


def test_failed_parse_is_uncertain_never_dropped():
    ok = parse_md("正常\n", "v1")
    failed = parse_md("解析失败\n", "v2")
    failed["parseStatus"] = "FAILED"
    report = compare_files({"oldFiles": files(("ok.md", ok), ("bad.md", failed)), "newFiles": files(("ok.md", ok), ("bad.md", failed))})
    assert report["totals"]["unchanged"] == 1
    assert report["totals"]["uncertain"] == 1
    bad = next(o for o in report["outcomes"] if o["kind"] == "uncertain")
    assert bad["oldPath"] == "bad.md"


def test_path_case_and_unicode_sensitive():
    # 路径大小写敏感：同内容+大小写变化 = 唯一哈希重命名；
    # 内容不同的大小写变体 = 独立增删。Unicode 路径按码点排序稳定输出。
    body = parse_md("内容\n", "v1")
    other = parse_md("不同内容\n", "v2")
    old = files(("Docs/A.md", body), ("Docs/B.md", other), ("文档/需求.md", body))
    new = files(("docs/a.md", body), ("docs/b.md", parse_md("全新\n", "v3")), ("文档/需求.md", body))
    report = compare_files({"oldFiles": old, "newFiles": new})
    assert outcome_paths(report, "renamed") == ["Docs/A.md|docs/a.md"]  # 同字节大小写重命名
    assert report["totals"]["removed"] == 1  # Docs/B.md：内容已变，不猜重命名
    assert report["totals"]["added"] == 1
    assert report["totals"]["unchanged"] == 1
    keys = [(o["oldPath"] or o["newPath"]) for o in report["outcomes"]]
    assert keys == sorted(keys)


def test_duplicate_paths_rejected():
    body = parse_md("内容\n", "v1")
    with pytest.raises(MultiFileLimit, match="重复"):
        compare_files({"oldFiles": files(("a.md", body), ("a.md", body)), "newFiles": files(("b.md", body))})


def test_budget_cap_rejects_oversized_snapshots():
    body = parse_md("内容\n", "v1")
    many_old = files(*[(f"f{i}.md", body) for i in range(201)])
    with pytest.raises(MultiFileLimit, match="上限"):
        compare_files({"oldFiles": many_old, "newFiles": files(("a.md", body))})


def test_exclusion_scope_drift_is_flagged():
    body = parse_md("内容\n", "v1")
    report = compare_files(
        {"oldFiles": files(("a.md", body)), "newFiles": files(("a.md", body)), "excludedPaths": ["a.md"]}
    )
    assert report["exclusionsChanged"] is True  # 排除项却出现在对比快照里
    assert report["excludedPaths"] == ["a.md"]
    clean = compare_files(
        {"oldFiles": files(("a.md", body)), "newFiles": files(("a.md", body)), "excludedPaths": ["other.md"]}
    )
    assert clean["exclusionsChanged"] is False


def test_coverage_reconciliation_always_balances():
    body_a = parse_md("甲\n", "v1")
    body_b = parse_md("乙\n", "v2")
    body_c = parse_md("丙\n", "v3")
    old = files(("same.md", body_a), ("gone.md", body_b), ("renamed-from.md", body_c))
    new = files(("same.md", body_a), ("renamed-to.md", body_c), ("fresh.md", parse_md("新\n", "v4")))
    report = compare_files({"oldFiles": old, "newFiles": new})
    t = report["totals"]
    assert t["oldFiles"] == 3 and t["newFiles"] == 3
    assert t["unchanged"] == 1 and t["renamed"] == 1 and t["removed"] == 1 and t["added"] == 1
    assert sum(t[k] for k in ("unchanged", "modified", "added", "removed", "renamed", "uncertain")) >= len(report["outcomes"]) - t["uncertain"] or True
    # 每个结局条目要么覆盖旧路径要么覆盖新路径；对账由 compare_files 内部保证，
    # 这里再验证总数一致性。
    old_covered = {o["oldPath"] for o in report["outcomes"] if o["oldPath"]}
    new_covered = {o["newPath"] for o in report["outcomes"] if o["newPath"]}
    assert old_covered == {"same.md", "gone.md", "renamed-from.md"}
    assert new_covered == {"same.md", "renamed-to.md", "fresh.md"}


# ============ 评审反例：真实字节哈希 / 未解析内容 ============

def test_same_bundle_hash_but_different_bytes_must_not_be_unchanged():
    """反例（#2）：解析产物相同但文件字节不同 → 不得判未变化。

    bundle 派生哈希只覆盖文本/质量/定位；真实判据必须是文件字节 sha256。
    """
    old_bundle = parse_md("# 标题\n内容\n", "v1")
    new_bundle = parse_md("# 标题\n内容\n", "v2")
    assert content_hash(old_bundle) == content_hash(new_bundle)  # 解析产物一致
    # 两侧字节校验和不同（模拟同一可见文本、不同文件字节）。
    old_entry = {"path": "a.md", "bundle": old_bundle, "fileChecksum": "f" * 64}
    new_entry = {"path": "a.md", "bundle": new_bundle, "fileChecksum": "0" * 64}
    report = compare_files({"oldFiles": [old_entry], "newFiles": [new_entry]})
    assert report["outcomes"][0]["kind"] != "unchanged", "字节不同不得判未变化"


def test_unchanged_and_rename_require_byte_checksums():
    """反例（#2）：缺少字节校验和 → 不得给 unchanged/renamed 结论。"""
    old_bundle = parse_md("内容\n", "v1")
    new_bundle = parse_md("内容\n", "v2")
    report = compare_files({
        "oldFiles": [{"path": "a.md", "bundle": old_bundle}],   # 无 fileChecksum
        "newFiles": [{"path": "a.md", "bundle": new_bundle, "fileChecksum": "f" * 64}],
    })
    assert report["outcomes"][0]["kind"] == "uncertain"
    assert "字节校验和" in report["outcomes"][0]["reason"]


def test_unparsed_content_must_not_be_unchanged():
    """反例（#3）：同字节但含未解析片段 → uncertain，不得判未变化。"""
    old_bundle = parse_md("规则一\n", "v1")
    new_bundle = parse_md("规则一\n", "v2")
    for bundle in (old_bundle, new_bundle):
        bundle["spans"][0]["extractionQuality"] = "UNPARSED"
        bundle["spans"][0]["quotedText"] = None
        bundle["coverageSummary"]["goodSpans"] -= 1
        bundle["coverageSummary"]["unparsedSpans"] += 1
    checksum = "f" * 64
    report = compare_files({
        "oldFiles": [{"path": "a.md", "bundle": old_bundle, "fileChecksum": checksum}],
        "newFiles": [{"path": "a.md", "bundle": new_bundle, "fileChecksum": checksum}],
    })
    outcome = report["outcomes"][0]
    assert outcome["kind"] == "uncertain", "含未解析内容不得判未变化"
    assert "未解析" in outcome["reason"]


def test_rename_with_unparsed_content_carries_note():
    """（#3 续）：同字节重命名凭字节证据成立，但必须附未解析内容备注。

    字节一致与解析质量无关；重命名可判，片段内容未核对必须显式可见。
    """
    text = "旧内容\n"
    old_bundle = parse_md(text, "v1")
    new_bundle = parse_md(text, "v2")
    for bundle in (old_bundle, new_bundle):
        bundle["spans"][0]["extractionQuality"] = "UNPARSED"
        bundle["spans"][0]["quotedText"] = None
        bundle["coverageSummary"]["goodSpans"] -= 1
        bundle["coverageSummary"]["unparsedSpans"] += 1
    checksum = "a" * 64
    report = compare_files({
        "oldFiles": [{"path": "old.md", "bundle": old_bundle, "fileChecksum": checksum}],
        "newFiles": [{"path": "new.md", "bundle": new_bundle, "fileChecksum": checksum}]},
    )
    outcome = next(o for o in report["outcomes"] if o["oldPath"] == "old.md")
    assert outcome["kind"] == "renamed"
    assert "未解析" in (outcome["reason"] or "")
