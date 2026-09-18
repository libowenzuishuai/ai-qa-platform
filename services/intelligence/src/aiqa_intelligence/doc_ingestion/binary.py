from io import BytesIO
from zipfile import ZipFile
from defusedxml import ElementTree
from docx import Document
from docx.table import Table, _Cell
from pypdf import PdfReader
from PIL import Image
from .bundle import Bundle, ParseLimit

MAX_PDF_PAGES = 200
MAX_IMAGE_PIXELS = 20_000_000

_CELL_UNSUPPORTED_XPATH = (
    ".//w:drawing | .//w:pict | .//w:del | .//w:ins | .//w:txbxContent"
)


def _cell_has_embedded_unsupported(cell: _Cell) -> bool:
    return bool(cell._tc.xpath(_CELL_UNSUPPORTED_XPATH))


def _parse_docx_table(
    table: Table, table_index_counter: list[int], bundle: Bundle, seen_cells: set
) -> None:
    table_index = table_index_counter[0]
    table_index_counter[0] += 1
    for row_index, row in enumerate(table.rows):
        for col_index, cell in enumerate(row.cells, row.grid_cols_before):
            if cell._tc in seen_cells:
                bundle.warn("DOCX 合并单元格仅记录主单元格，坐标采用原表格网格")
                continue
            seen_cells.add(cell._tc)
            locator = {
                "kind": "docx-cell",
                "tableIndex": table_index,
                "row": row_index,
                "col": col_index,
            }
            nested = cell.tables
            embedded = _cell_has_embedded_unsupported(cell)
            if nested:
                for nested_table in nested:
                    _parse_docx_table(nested_table, table_index_counter, bundle, seen_cells)
                if embedded:
                    bundle.add("", locator, kind="table", quality="UNPARSED")
                    bundle.warn("DOCX 单元格内图片或修订内容与嵌套表格并存，未完整解析")
                continue
            if cell.text.strip():
                bundle.add(
                    cell.text,
                    locator,
                    kind="table",
                    quality="LOW" if embedded else "GOOD",
                )
            if embedded:
                bundle.add("", locator, kind="table", quality="UNPARSED")
                bundle.warn("DOCX 单元格内图片或修订内容未完整解析")


def parse_pdf(data: bytes, bundle: Bundle):
    bundle.warn("PDF 仅提取文字层；页内图示、复杂表格和多栏阅读顺序需人工核对")
    reader = PdfReader(BytesIO(data))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ValueError("加密 PDF 无法读取")
    if len(reader.pages) > MAX_PDF_PAGES:
        raise ParseLimit("PDF 超过 200 页上限")
    for number, page in enumerate(reader.pages, 1):
        locator = {"kind": "pdf-page", "page": number}
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
            bundle.warn(f"PDF 第 {number} 页文字提取失败")
        if text.strip():
            bundle.add(text, locator, page=number)
        else:
            bundle.add("", locator, quality="UNPARSED", page=number)
            bundle.warn(
                f"PDF 第 {number} 页未提取到文字：可能为空白或扫描页，需要模型识别/人工复核"
            )
    has_text = any(b["text"].strip() for b in bundle.blocks)
    bundle.format = "PDF_TEXT" if has_text else "PDF_SCANNED"
    if not has_text:
        bundle.warn("未提取到文字层；将尝试整页视觉大模型识别")
    return "PARSED" if has_text else "NEEDS_OCR"


def parse_docx(data: bytes, bundle: Bundle):
    # Inspect expansion before allowing the XML library to unpack the document.
    with ZipFile(BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > 2000 or sum(m.file_size for m in members) > 64 * 1024 * 1024:
            raise ParseLimit("DOCX 解压体积或条目数超限")
        for member in members:
            if member.filename.endswith((".xml", ".rels")):
                if member.file_size > 16 * 1024 * 1024:
                    raise ParseLimit("DOCX XML 超过 16 MB 上限")
                ElementTree.fromstring(archive.read(member))
        if any(
            m.filename.startswith(
                ("word/header", "word/footer", "word/footnotes", "word/endnotes")
            )
            for m in members
        ):
            bundle.warn("DOCX 页眉、页脚、脚注与尾注未提取；需人工核对")
    document = Document(BytesIO(data))
    paragraph_index = 0
    table_index_counter = [0]
    seen_cells = set()
    for item in document.iter_inner_content():
        if isinstance(item, Table):
            _parse_docx_table(item, table_index_counter, bundle, seen_cells)
        else:
            locator = {"kind": "docx-paragraph", "paragraphIndex": paragraph_index}
            paragraph_index += 1  # Empty paragraphs still occupy their original index.
            unsupported = bool(item._p.xpath(_CELL_UNSUPPORTED_XPATH))
            if item.text.strip():
                bundle.add(item.text, locator, quality="LOW" if unsupported else "GOOD")
            if unsupported:
                bundle.add("", locator, quality="UNPARSED")
                bundle.warn("DOCX 段落图片、文本框或修订内容未完整解析")
    if document.element.body.xpath("./w:ins | ./w:del | ./w:sdt"):
        bundle.warn("DOCX 存在未解析的正文修订或内容控件；需人工核对")
    if not bundle.blocks:
        bundle.warn("DOCX 没有可提取文字")


def verify_image(data: bytes, format: str):
    with Image.open(BytesIO(data)) as image:
        if image.format != format:
            raise ValueError("图片格式与声明不一致")
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ParseLimit("图片超过 2000 万像素上限")
        if getattr(image, "n_frames", 1) != 1:
            raise ValueError("不支持多帧图片")
        image.verify()
    # JPEG verify() alone does not decode and can accept truncated pixel data.
    with Image.open(BytesIO(data)) as image:
        image.load()
