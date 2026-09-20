from aiqa_intelligence.doc_ingestion.runner import parse_bytes
from aiqa_intelligence.source_changes import compare_bundles


def parse_md(text: str, document_id: str):
    return parse_bytes(text.encode(), document_id, "MARKDOWN")


def test_unchanged_spans_produce_no_changes():
    body = parse_md("# Title\nAmount > 500000\n", "v1")
    other = parse_md("# Title\nAmount > 500000\n", "v2")
    report = compare_bundles("requirements/prd.md", body, other)
    assert report["changes"] == []


def test_modified_text_at_same_markdown_line():
    old = parse_md("Line one\nLine two\n", "old")
    new = parse_md("Line one\nLine two changed\n", "new")
    report = compare_bundles("doc.md", old, new)
    kinds = [c["kind"] for c in report["changes"]]
    assert "modified" in kinds
    mod = next(c for c in report["changes"] if c["kind"] == "modified")
    assert mod["old"]["quotedText"] == "Line two"
    assert mod["new"]["quotedText"] == "Line two changed"
    assert mod["old"]["locator"] == mod["new"]["locator"]


def test_insertion_shifts_lines_as_removed_and_added():
    old = parse_md("A\nB\n", "old")
    new = parse_md("A\nInserted\nB\n", "new")
    report = compare_bundles("doc.md", old, new)
    kinds = {c["kind"] for c in report["changes"]}
    assert "added" in kinds
    assert "removed" in kinds or "modified" in kinds or "uncertain" in kinds


def test_duplicate_text_in_new_version_is_uncertain():
    old = parse_md("Repeat\n", "old")
    new = parse_md("\nRepeat\nRepeat\n", "new")
    report = compare_bundles("doc.md", old, new)
    uncertain = [c for c in report["changes"] if c["kind"] == "uncertain"]
    assert uncertain
    assert any("多处重复" in (c.get("reason") or "") for c in uncertain)


def test_docx_cell_text_change_is_modified():
    from io import BytesIO

    from docx import Document

    def docx_with(cell_text: str, doc_id: str):
        doc = Document()
        table = doc.add_table(rows=1, cols=1)
        table.cell(0, 0).text = cell_text
        buf = BytesIO()
        doc.save(buf)
        return parse_bytes(buf.getvalue(), doc_id, "DOCX")

    old = docx_with("<=500000", "old")
    new = docx_with(">500000", "new")
    report = compare_bundles("rules.docx", old, new)
    assert len(report["changes"]) == 1
    assert report["changes"][0]["kind"] == "modified"
    assert report["changes"][0]["old"]["quotedText"] == "<=500000"
    assert report["changes"][0]["new"]["quotedText"] == ">500000"
    assert report["changes"][0]["old"]["locator"]["kind"] == "docx-cell"


def test_format_mismatch_raises():
    old = parse_md("x", "old")
    from io import BytesIO

    from docx import Document

    doc = Document()
    doc.add_paragraph("x")
    buf = BytesIO()
    doc.save(buf)
    new = parse_bytes(buf.getvalue(), "new", "DOCX")
    try:
        compare_bundles("x", old, new)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "format mismatch" in str(exc)
