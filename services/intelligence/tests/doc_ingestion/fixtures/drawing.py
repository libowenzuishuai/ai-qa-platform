"""Synthetic raster fixtures with legible CJK (B3 / tests only)."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def load_cjk_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path(r"C:\Windows\Fonts\msyh.ttc"),
        Path(r"C:\Windows\Fonts\simhei.ttf"),
        Path(r"C:\Windows\Fonts\simsun.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    raise OSError(
        "未找到可用的中文字体（已尝试 Windows msyh/simhei 与 Linux Noto）。"
        "请安装任一中文字体后重试 B3 栅格夹具生成。"
    )


def table_image_pdf(rows: list[list[str]]) -> bytes:
    width, height = 420, 40 + 40 * len(rows)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = load_cjk_font(18)
    col_count = max(len(row) for row in rows)
    col_width = width // col_count
    for row_index, row in enumerate(rows):
        y0 = 20 + row_index * 40
        draw.line([(0, y0), (width, y0)], fill="black", width=1)
        for col_index, value in enumerate(row):
            x0 = col_index * col_width
            draw.line([(x0, y0), (x0, y0 + 40)], fill="black", width=1)
            draw.text((x0 + 8, y0 + 10), value, font=font, fill="black")
    draw.line([(0, 20 + len(rows) * 40), (width, 20 + len(rows) * 40)], fill="black")
    draw.line([(width - 1, 20), (width - 1, 20 + len(rows) * 40)], fill="black")
    buffer = BytesIO()
    image.save(buffer, "PDF")
    return buffer.getvalue()


def raster_page_pdf(lines: list[str], *, width: int = 620, height: int = 420) -> bytes:
    """Single-page raster PDF with multiline CJK (simulates scan / screenshot)."""
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = load_cjk_font(22)
    y = 36
    for line in lines:
        draw.text((32, y), line, font=font, fill="black")
        y += 36
    buffer = BytesIO()
    image.save(buffer, "PDF")
    return buffer.getvalue()


def _pdf_text_page(writer: PdfWriter, lines: list[str]) -> None:
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
    )
    page = writer.add_blank_page(620, 420)
    cmds = ["BT", "/F1", "14", "Tf", "50", "380", "Td"]
    for index, line in enumerate(lines):
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        if index:
            cmds.extend(["0", "-28", "Td"])
        cmds.extend([f"({escaped})", "Tj"])
    cmds.append("ET")
    stream = DecodedStreamObject()
    stream.set_data(" ".join(cmds).encode("latin-1", errors="replace"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
    )


def mixed_prd_sample_pdf() -> bytes:
    """Three pages: text layer, CJK scan prose, CJK scan table (mixed PRD-like)."""
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    _pdf_text_page(
        writer,
        [
            "THRESHOLD > 500000 fen",
            "Keep punctuation: ,} ,]",
            "TEXT_LAYER page-1 (selectable)",
        ],
    )
    scan_rules = raster_page_pdf(
        [
            "【扫描页-2】审批规则",
            "申请人单笔 <=500000 分",
            "主管审批  >500000 分",
            "保留标点：,} ,]",
        ]
    )
    scan_table = table_image_pdf(
        [["角色", "上限"], ["申请人", "<=500000分"], ["主管", ">500000分"]]
    )
    for blob in (scan_rules, scan_table):
        writer.add_page(PdfReader(BytesIO(blob)).pages[0])
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


MIXED_PRD_SAMPLE_EXPECTED = {
    "fixtureId": "b3-mixed-prd-sample",
    "description": "混排 PDF：第 1 页可选中文字层 + 第 2–3 页栅格扫描（中文与表格）。人工核对 PDF 与下列 visible 是否一致。",
    "pages": [
        {
            "page": 1,
            "kind": "PDF_TEXT_LAYER",
            "humanCheck": [
                "THRESHOLD > 500000 fen",
                "Keep punctuation: ,} ,]",
                "TEXT_LAYER page-1",
            ],
        },
        {
            "page": 2,
            "kind": "PDF_SCAN_RASTER",
            "humanCheck": [
                "【扫描页-2】",
                "审批规则",
                "<=500000",
                ">500000",
                ",} ,]",
            ],
        },
        {
            "page": 3,
            "kind": "PDF_SCAN_TABLE",
            "humanCheck": ["角色", "上限", "申请人", "主管", "<=500000", ">500000"],
        },
    ],
}
