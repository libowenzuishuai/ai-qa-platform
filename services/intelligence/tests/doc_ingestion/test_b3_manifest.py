import json
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent / "fixtures" / "b3-eval-manifest.json"
ROOT = Path(__file__).resolve().parents[4]


def test_b3_mock_cases_have_eval_records_on_disk():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for case in manifest["cases"]:
        if case["status"] != "mock-covered":
            continue
        record = case.get("evalRecord")
        assert record, f"{case['id']} missing evalRecord"
        path = ROOT / record
        assert path.exists(), record
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["caseId"] == case["id"]
        assert payload["mode"] == "mock"
        assert "parseStatus" in payload
        assert "coverageSummary" in payload
