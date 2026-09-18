"""Extract embedded page images for scan PDF OCR (pypdf + Pillow only)."""

from io import BytesIO

from PIL import Image
from pypdf import PdfReader


def page_embedded_image(data: bytes, page_number: int) -> bytes | None:
    """Return JPEG bytes for the first embedded image on a page, if any."""
    reader = PdfReader(BytesIO(data))
    if page_number < 1 or page_number > len(reader.pages):
        return None
    page = reader.pages[page_number - 1]
    try:
        images = page.images
        if not images:
            return None
        raw = images[0].data
        with Image.open(BytesIO(raw)) as image:
            output = BytesIO()
            image.convert("RGB").save(output, format="JPEG", quality=85)
            return output.getvalue()
    except Exception:
        return None
