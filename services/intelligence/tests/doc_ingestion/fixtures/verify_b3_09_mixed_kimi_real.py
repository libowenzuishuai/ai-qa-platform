"""B3-09 opt-in real Kimi run: mixed text-layer + scan PDF. Not part of default pytest.

From repository root (Windows example; set NO_PROXY=* if Kimi hangs on proxy):
  PYTHONPATH=services/intelligence/src services/intelligence/.venv/Scripts/python.exe \\
    services/intelligence/tests/doc_ingestion/fixtures/verify_b3_09_mixed_kimi_real.py --env-file .env.local
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import sys

_FIX = Path(__file__).resolve().parent
_RECORDS = _FIX / "b3-records"
_PDF = _RECORDS / "b3-mixed-prd-sample.pdf"
_EXPECTED = _RECORDS / "b3-mixed-prd-sample.expected.json"

from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import DocumentParseInput
from aiqa_intelligence.doc_ingestion.service import DocumentParser
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader


def _load_expected_checks() -> list[str]:
    payload = json.loads(_EXPECTED.read_text(encoding="utf-8"))
    checks: list[str] = []
    for page in payload.get("pages") or []:
        for item in page.get("humanCheck") or []:
            if item and item not in checks:
                checks.append(item)
    return checks


def _combined_text(body: dict) -> str:
    parts = [b.get("text") or "" for b in body.get("blocks") or []]
    parts.extend(s.get("quotedText") or "" for s in body.get("spans") or [])
    return "\n".join(parts)


async def run(output: Path):
    from tempfile import TemporaryDirectory

    if not _PDF.is_file():
        raise SystemExit(f"missing fixture PDF: {_PDF}")
    data = _PDF.read_bytes()
    expected_checks = _load_expected_checks()

    with TemporaryDirectory(prefix="aiqa-b3-09-") as root:
        Path(root, "mixed.pdf").write_bytes(data)
        request = DocumentParseInput(
            documentVersionId="b3-09-real-kimi",
            format="PDF_TEXT",
            storageKey="mixed.pdf",
            checksum=hashlib.sha256(data).hexdigest(),
            fileSizeBytes=len(data),
        )
        reader = ArtifactReader(Path(root))
        records = []
        gateway = Gateway("real", reader, "document-vision-1.2", records)
        result = await DocumentParser().parse_document(
            request,
            RequestContext("b3-09-real-kimi", "real", reader, gateway, records),
        )
        body = result.model_dump(mode="json", exclude_unset=True)
        text = _combined_text(body)

        assert body["parseStatus"] == "PARSED", body
        assert body["format"] in {"PDF_TEXT", "PDF_SCANNED"}, body
        assert "500000" in text, "threshold digits missing from model output"
        assert records, "expected at least one vision invocation"

        check_results = []
        for needle in expected_checks:
            ok = needle in text
            check_results.append({"humanCheck": needle, "found": ok})
        missing = [c["humanCheck"] for c in check_results if not c["found"]]

        record = {
            "caseId": "b3-09-mixed-prd-sample",
            "mode": "real",
            "fixtureRef": "services/intelligence/tests/doc_ingestion/fixtures/b3-records/b3-mixed-prd-sample.pdf",
            "expectedForHuman": "services/intelligence/tests/doc_ingestion/fixtures/b3-records/b3-mixed-prd-sample.expected.json",
            "humanCheckAllFound": not missing,
            "humanCheckMissing": missing,
            "ranAt": datetime.now(timezone.utc).astimezone().isoformat(),
            "command": "services/intelligence/tests/doc_ingestion/fixtures/verify_b3_09_mixed_kimi_real.py",
            "parseStatus": body["parseStatus"],
            "format": body["format"],
            "coverageSummary": body["coverageSummary"],
            "warnings": body.get("warnings") or [],
            "humanCheckResults": check_results,
            "sampleText": text[:500000],
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
        if missing:
            raise AssertionError(
                "wrote real record but expected.json humanCheck missing in output "
                f"(Kimi may paraphrase): {missing}"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=_RECORDS / "b3-mixed-prd-sample.real.json",
    )
    args = parser.parse_args()
    for line in args.env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("AIQA_VISION_") and "=" in line:
            key, value = line.split("=", 1)
            os.environ[key.strip()] = value.strip().strip('"')
    asyncio.run(run(args.output))
