"""Render the complete visible PDF page; no OCR engine or first-image shortcut."""

import math
from io import BytesIO
import pypdfium2 as pdfium
from .bundle import ParseLimit

MAX_RENDER_EDGE = 2048
MAX_RENDER_PIXELS = 4_194_304
MAX_RENDER_BYTES = 16 * 1024 * 1024


def render_page(data: bytes, page_number: int) -> bytes:
    # Called only in a cancellable child. PDFium is not thread safe.
    with pdfium.PdfDocument(data) as document:
        if not 1 <= page_number <= len(document):
            raise ValueError("PDF 页码越界")
        page = document[page_number - 1]
        try:
            width, height = page.get_size()
            if not all(math.isfinite(v) and 0 < v <= 14400 for v in (width, height)):
                raise ParseLimit("PDF 页面尺寸无效或超限")
            scale = min(2, (MAX_RENDER_EDGE - 1) / max(width, height))
            if math.ceil(width * scale) * math.ceil(height * scale) > MAX_RENDER_PIXELS:
                raise ParseLimit("PDF 页面渲染像素超限")
            bitmap = page.render(scale=scale, draw_annots=True)
            try:
                image = bitmap.to_pil()
                try:
                    output = BytesIO()
                    image.save(output, format="PNG")
                    result = output.getvalue()
                    if len(result) > MAX_RENDER_BYTES:
                        raise ParseLimit("PDF 页面渲染文件超限")
                    return result
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()
