"""Opt-in paid smoke test. Sends only a synthetic two-page PDF, never user files.

From repository root:
  PYTHONPATH=services/intelligence/src services/intelligence/.venv/bin/python \
    services/intelligence/scripts/verify_kimi_vision.py --env-file .env.local
"""

import argparse
import asyncio
import hashlib
import json
import os
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import DocumentParseInput
from aiqa_intelligence.doc_ingestion.service import DocumentParser
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader


def synthetic_pdf():
    writer = PdfWriter()
    for text in [
        "AMOUNT > 500000 FEN\nAPPROVAL REQUIRED\nKeep punctuation: ,} ,]",
        "ROLE: MANAGER\nLIMIT <= 500000 FEN",
    ]:
        image = Image.new("RGB", (1000, 400), "white")
        ImageDraw.Draw(image).multiline_text(
            (40, 50),
            text,
            font=ImageFont.load_default(size=35),
            fill="black",
            spacing=20,
        )
        output = BytesIO()
        image.save(output, format="PDF", resolution=100)
        writer.add_page(PdfReader(BytesIO(output.getvalue())).pages[0])
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


async def verify():
    with TemporaryDirectory(prefix="aiqa-kimi-vision-") as root:
        data = synthetic_pdf()
        Path(root, "source.pdf").write_bytes(data)
        request = DocumentParseInput(
            documentVersionId="kimi-vision-smoke",
            format="PDF_SCANNED",
            storageKey="source.pdf",
            checksum=hashlib.sha256(data).hexdigest(),
            fileSizeBytes=len(data),
        )
        reader = ArtifactReader(Path(root))
        records = []
        gateway = Gateway("real", reader, "document-vision-1.2", records)
        result = await DocumentParser().parse_document(
            request,
            RequestContext("kimi-vision-smoke", "real", reader, gateway, records),
        )
        texts = [b.text for b in result.blocks]
        assert result.parseStatus == "PARSED" and len(texts) == 2
        assert all(s.extractionQuality == "LOW" for s in result.spans)
        assert (
            "500000" in texts[0]
            and ">" in texts[0]
            and ",}" in texts[0]
            and ",]" in texts[0]
        )
        assert "500000" in texts[1] and "<=" in texts[1] and "MANAGER" in texts[1]
        assert len(records) == 2 and all(
            r.response.model == "kimi-k2.6" for r in records
        )
        print(
            json.dumps(
                {
                    "passed": True,
                    "model": "kimi-k2.6",
                    "pages": 2,
                    "texts": texts,
                    "invocations": [
                        {
                            "provider": r.response.provider,
                            "model": r.response.model,
                            "requestId": r.response.requestId,
                            "usage": r.response.usage.model_dump(),
                            "latencyMs": r.response.latencyMs,
                        }
                        for r in records
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        for line in args.env_file.read_text().splitlines():
            if line.startswith("AIQA_VISION_") and "=" in line:
                key, value = line.split("=", 1)
                os.environ[key] = value
    asyncio.run(verify())
