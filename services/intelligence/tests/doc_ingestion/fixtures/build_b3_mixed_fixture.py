"""Write b3-mixed-prd-sample.pdf and .expected.json for human review.

  PYTHONPATH=services/intelligence/src python services/intelligence/tests/doc_ingestion/fixtures/build_b3_mixed_fixture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
from drawing import MIXED_PRD_SAMPLE_EXPECTED, mixed_prd_sample_pdf  # noqa: E402

OUT = _HERE / "b3-records"
_INTELLIGENCE_SRC = _HERE.parents[2] / "src"
sys.path.insert(0, str(_INTELLIGENCE_SRC))
from aiqa_intelligence.doc_ingestion.runner import parse_bytes  # noqa: E402


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pdf_path = OUT / "b3-mixed-prd-sample.pdf"
    data = mixed_prd_sample_pdf()
    pdf_path.write_bytes(data)
    expected_path = OUT / "b3-mixed-prd-sample.expected.json"
    expected_path.write_text(
        json.dumps(MIXED_PRD_SAMPLE_EXPECTED, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    body = parse_bytes(data, "b3-09-mixed-mock", "PDF_TEXT")
    mock_path = OUT / "b3-mixed-prd-sample.parse-mock.json"
    mock_path.write_text(
        json.dumps(
            {
                "caseId": "b3-09-mixed-prd-sample",
                "mode": "mock",
                "note": "无视觉模型；第 2–3 页应为 UNPARSED/无 quotedText",
                "parseStatus": body["parseStatus"],
                "format": body["format"],
                "coverageSummary": body["coverageSummary"],
                "warnings": body.get("warnings") or [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print("wrote", pdf_path)
    print("wrote", expected_path)
    print("wrote", mock_path)


if __name__ == "__main__":
    main()
