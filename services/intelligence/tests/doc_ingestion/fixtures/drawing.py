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
