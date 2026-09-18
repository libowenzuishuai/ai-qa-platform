import asyncio
import copy
from fastapi.testclient import TestClient
from aiqa_intelligence.app import create_app
from aiqa_intelligence.contracts import generated as m

HEADERS = {"authorization": "Bearer service-test"}


def request(vector, mode="mock"):
    return {
        "schemaVersion": "1.0",
        "requestId": "request-1",
        "mode": mode,
        "timeoutMs": 1000,
        "input": vector["input"],
    }


class Agents:
    ready = True

    def __init__(self, rule, case):
        self.rule, self.case = rule, case

    async def extract_rules(self, input, context):
        return m.RuleExtractionOutput.model_validate(self.rule)

    async def generate_cases(self, input, context):
        return m.CaseGenerationOutput.model_validate(self.case)


def test_explicit_not_ready_and_auth(rule_vector):
    with TestClient(create_app(token="service-test")) as client:
        assert client.get("/health").json()["capabilities"]["ruleExtraction"] is False
        assert (
            client.post("/v1/rules/extract", json=request(rule_vector)).status_code
            == 401
        )
        res = client.post(
            "/v1/rules/extract", headers=HEADERS, json=request(rule_vector)
        )
        assert res.status_code == 503
        assert res.json()["code"] == "DEPENDENCY_UNAVAILABLE"


def test_rules_and_cases(rule_vector, case_vector):
    app = create_app(
        token="service-test",
        agents=Agents(rule_vector["output"], case_vector["output"]),
    )
    with TestClient(app) as client:
        for path, vector in [
            ("rules/extract", rule_vector),
            ("cases/generate", case_vector),
        ]:
            res = client.post("/v1/" + path, headers=HEADERS, json=request(vector))
            assert res.status_code == 200, res.text
            assert res.json()["requestId"] == "request-1"
            assert res.json()["mode"] == "mock"
        wrong = request(rule_vector)
        wrong["schemaVersion"] = "99"
        assert (
            client.post("/v1/rules/extract", headers=HEADERS, json=wrong).status_code
            == 422
        )


def test_invalid_handler_output_rejected(rule_vector, case_vector):
    bad = copy.deepcopy(rule_vector["output"])
    bad["ruleDrafts"][0]["sources"][0]["sourceSpanIds"] = ["invented"]
    with TestClient(
        create_app(token="service-test", agents=Agents(bad, case_vector["output"]))
    ) as client:
        res = client.post(
            "/v1/rules/extract", headers=HEADERS, json=request(rule_vector)
        )
        assert res.status_code == 422
        assert res.json()["code"] == "MODEL_OUTPUT_INVALID"


def test_timeout_no_fallback(rule_vector, case_vector):
    class Slow(Agents):
        async def extract_rules(self, input, context):
            await asyncio.sleep(5)

    with TestClient(
        create_app(
            token="service-test",
            agents=Slow(rule_vector["output"], case_vector["output"]),
        )
    ) as client:
        res = client.post(
            "/v1/rules/extract", headers=HEADERS, json=request(rule_vector)
        )
        assert res.status_code == 504
        assert res.json()["code"] == "MODEL_TIMEOUT"


def test_needs_ocr_is_a_bundle_status(rule_vector):
    class Parser:
        ready = True

        async def parse_document(self, input, context):
            return m.ParsedDocumentBundle.model_validate(
                {
                    "documentVersionId": input.documentVersionId,
                    "format": "PDF_SCANNED",
                    "parseStatus": "NEEDS_OCR",
                    "parserVersion": "test",
                    "blocks": [],
                    "spans": [],
                    "coverageSummary": {
                        "totalBlocks": 0,
                        "goodSpans": 0,
                        "lowSpans": 0,
                        "unparsedSpans": 0,
                    },
                    "warnings": ["needs OCR"],
                }
            )

    payload = {
        "schemaVersion": "1.0",
        "requestId": "parse-1",
        "mode": "mock",
        "timeoutMs": 1000,
        "input": {
            "documentVersionId": "doc-1",
            "format": "PDF_SCANNED",
            "storageKey": "a.pdf",
            "checksum": "0" * 64,
            "fileSizeBytes": 1,
        },
    }
    with TestClient(create_app(token="service-test", parser=Parser())) as client:
        res = client.post("/v1/documents/parse", headers=HEADERS, json=payload)
        assert res.status_code == 200, res.text
        bundle = res.json()["output"]
        assert bundle["parseStatus"] == "NEEDS_OCR"
        downstream = request(rule_vector)
        downstream["input"] = {**downstream["input"], "documentVersions": [bundle]}
        res = client.post("/v1/rules/extract", headers=HEADERS, json=downstream)
        assert res.status_code == 422 and res.json()["code"] == "NEEDS_OCR"


def test_model_invocations_survive_wire_validation(rule_vector, case_vector):
    class CallingAgents(Agents):
        async def extract_rules(self, input, context):
            req = m.TextModelRequest.model_validate(
                {
                    "purpose": "RULE_EXTRACTION",
                    "system": "test",
                    "user": "test",
                    "timeoutMs": 1000,
                    "outputSchema": {
                        "type": "object",
                        "required": ["ruleDrafts", "clarifications", "unparsedRanges"],
                    },
                }
            )
            context.models.register_mock(req, self.rule)
            result = await context.models.complete_text(req)
            return m.RuleExtractionOutput.model_validate(result.parsedJson)

    with TestClient(
        create_app(
            token="service-test",
            agents=CallingAgents(rule_vector["output"], case_vector["output"]),
        )
    ) as client:
        res = client.post(
            "/v1/rules/extract", headers=HEADERS, json=request(rule_vector)
        )
        assert res.status_code == 200, res.text
        record = res.json()["invocations"][0]
        assert record["purpose"] == "RULE_EXTRACTION"
        assert record["response"]["provider"] == "mock"
        assert "estimatedCost" not in record["response"]["usage"]
