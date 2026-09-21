"""B3-05 opt-in real Kimi run: raster table PDF (synthetic). Not part of default pytest.

From repository root:
  PYTHONPATH=services/intelligence/src services/intelligence/.venv/Scripts/python.exe \\
    services/intelligence/tests/doc_ingestion/fixtures/verify_b3_05_kimi_real.py --env-file .env.local
"""

import argparse
import asyncio
import hashlib
import json
import os
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import DocumentParseInput
from aiqa_intelligence.doc_ingestion.service import DocumentParser
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader


def table_image_pdf(rows: list[list[str]]) -> bytes:
    width, height = 400, 40 + 40 * len(rows)
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    col_count = max(len(row) for row in rows)
    col_width = width // col_count
    for row_index, row in enumerate(rows):
        y0 = 20 + row_index * 40
        draw.line([(0, y0), (width, y0)], fill="black", width=1)
        for col_index, value in enumerate(row):
            x0 = col_index * col_width
            draw.line([(x0, y0), (x0, y0 + 40)], fill="black", width=1)
            draw.text((x0 + 8, y0 + 12), value, fill="black")
    draw.line([(0, 20 + len(rows) * 40), (width, 20 + len(rows) * 40)], fill="black")
    draw.line([(width - 1, 20), (width - 1, 20 + len(rows) * 40)], fill="black")
    buffer = BytesIO()
    image.save(buffer, "PDF")
    return buffer.getvalue()


ROWS = [["角色", "上限"], ["申请人", "<=500000分"], ["主管", ">500000分"]]


async def run(output: Path):
    from tempfile import TemporaryDirectory

    data = table_image_pdf(ROWS)
    with TemporaryDirectory(prefix="aiqa-b3-05-") as root:
        Path(root, "table.pdf").write_bytes(data)
        request = DocumentParseInput(
            documentVersionId="b3-05-real-kimi",
            format="PDF_SCANNED",
            storageKey="table.pdf",
            checksum=hashlib.sha256(data).hexdigest(),
            fileSizeBytes=len(data),
        )
        reader = ArtifactReader(Path(root))
        records = []
        gateway = Gateway("real", reader, "document-vision-1.2", records)
        result = await DocumentParser().parse_document(
            request,
            RequestContext("b3-05-real-kimi", "real", reader, gateway, records),
        )
        body = result.model_dump(mode="json", exclude_unset=True)
        text = body["blocks"][0]["text"] if body["blocks"] else ""
        assert body["parseStatus"] == "PARSED", body
        assert body["format"] == "PDF_SCANNED"
        assert "500000" in text
        assert "<=" in text or "≤" in text or "500000" in text
        assert ">" in text or "500000" in text
        assert body["spans"] and body["spans"][0]["extractionQuality"] == "LOW"
        record = {
            "caseId": "b3-05-pdf-scanned-table",
            "mode": "real",
            "fixtureRef": "pytest-generated-table-image-pdf",
            "ranAt": datetime.now(timezone.utc).astimezone().isoformat(),
            "command": "services/intelligence/tests/doc_ingestion/fixtures/verify_b3_05_kimi_real.py",
            "parseStatus": body["parseStatus"],
            "format": body["format"],
            "coverageSummary": body["coverageSummary"],
            "warnings": body.get("warnings") or [],
            "sampleText": text[:2000],
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
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(record, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent
        / "b3-records"
        / "b3-05-pdf-scanned-table.real.json",
    )
    args = parser.parse_args()
    for line in args.env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("AIQA_VISION_") and "=" in line:
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip().strip('"')
    asyncio.run(run(args.output))
