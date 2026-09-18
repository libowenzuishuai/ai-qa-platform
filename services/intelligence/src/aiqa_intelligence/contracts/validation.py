"""Wire shape from generated JSON Schema; business checks cannot be generated from Zod refinements.

TS remains the final authority before persistence. The shared conformance corpus runs
against both implementations; changes to these rules require corresponding shared cases.
"""

import json
from pathlib import Path
from typing import Any
from jsonschema import Draft7Validator, FormatChecker
from ..errors import ServiceError

SCHEMA = json.loads(Path(__file__).with_name("schema.v1.json").read_text())


def validate_shape(name: str, value: Any) -> None:
    schema = {"$ref": f"#/definitions/{name}", "definitions": SCHEMA["definitions"]}
    errors = list(
        Draft7Validator(schema, format_checker=FormatChecker()).iter_errors(value)
    )
    if errors:
        path = ".".join(map(str, errors[0].absolute_path))
        raise ServiceError("VALIDATION_ERROR", f"{name} 格式不合法，字段：{path}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ServiceError("MODEL_OUTPUT_INVALID", message)


def validate_bundle(bundle: dict) -> None:
    validate_shape("ParsedDocumentBundle", bundle)
    if bundle["parseStatus"] == "PARSED":
        require(any(b["text"].strip() for b in bundle["blocks"]), "PARSED 必须有正文")
    if bundle["parseStatus"] == "NEEDS_OCR":
        require(
            bundle["format"] in {"PDF_SCANNED", "PNG", "JPEG"}, "NEEDS_OCR 格式错误"
        )
    for quality, field in [
        ("GOOD", "goodSpans"),
        ("LOW", "lowSpans"),
        ("UNPARSED", "unparsedSpans"),
    ]:
        require(
            bundle["coverageSummary"][field]
            == sum(
                s.get("extractionQuality", "GOOD") == quality for s in bundle["spans"]
            ),
            "覆盖统计不一致",
        )
    require(
        all(
            s["documentVersionId"] == bundle["documentVersionId"]
            for s in bundle["spans"]
        ),
        "片段不属于本文档",
    )


def validate_rules(input: dict, output: dict) -> None:
    validate_shape("RuleExtractionInput", input)
    validate_shape("RuleExtractionOutput", output)
    for bundle in input["documentVersions"]:
        validate_bundle(bundle)
    bundles = {b["documentVersionId"]: b for b in input["documentVersions"]}
    spans = {s["id"]: s for b in bundles.values() for s in b["spans"]}
    drafts = {d["key"]: d for d in output["ruleDrafts"]}
    require(len(drafts) == len(output["ruleDrafts"]), "草稿 key 重复")
    for draft in drafts.values():
        sources = draft.get("sources", [])
        require(
            draft["classification"] != "EXPLICIT" or bool(sources), "EXPLICIT 缺少来源"
        )
        for source in sources:
            doc = source["documentVersionId"]
            require(doc in bundles, "文档不存在")
            for span_id in source["sourceSpanIds"]:
                require(span_id in spans, "来源片段不存在")
                span = spans[span_id]
                require(span["documentVersionId"] == doc, "来源跨文档")
                if span.get("quotedText"):
                    require(
                        any(
                            span["quotedText"] in b["text"]
                            for b in bundles[doc]["blocks"]
                        ),
                        "原文引用不匹配",
                    )
        for key in draft.get("conflictsWith", []):
            require(key in drafts, "冲突 key 不存在")
            require(
                draft["key"] in drafts[key].get("conflictsWith", []), "冲突没有互指"
            )
    require(
        all(r["spanId"] in spans for r in output["unparsedRanges"]),
        "未解析范围引用不存在片段",
    )
    require(
        all(k in drafts for c in output["clarifications"] for k in c["ruleDraftKeys"]),
        "澄清引用不存在规则",
    )


def validate_case_input(input: dict) -> None:
    validate_shape("CaseGenerationInput", input)
    for rule in input["approvedRuleVersions"]:
        require(rule["reviewStatus"] == "APPROVED", "用例生成只接受 APPROVED 规则")
        require(
            rule["classification"] != "EXPLICIT" or bool(rule.get("sources")),
            "EXPLICIT 缺少来源",
        )
        require(rule["id"] not in rule.get("conflictsWith", []), "规则不能与自身冲突")


def validate_cases(input: dict, output: dict) -> None:
    validate_case_input(input)
    validate_shape("CaseGenerationOutput", output)
    approved = {r["id"] for r in input["approvedRuleVersions"]}
    roles, fixtures = set(input["roles"]), set(input.get("fixtureCapabilities", []))
    for draft in output["caseDrafts"]:
        declared = set(draft["ruleVersionIds"])
        require(declared <= approved, "用例引用未批准规则")
        require(set(draft["roles"]) <= roles, "用例角色越界")
        require(
            all(
                s["role"] in roles and s["role"] in draft["roles"]
                for s in draft["steps"]
            ),
            "步骤角色越界",
        )
        data = draft["dataSpec"]
        if data["strategy"] == "fixture":
            require(data["fixtureId"] in fixtures, "引用不可用夹具")
        for assertion in draft["assertions"]:
            require(assertion["ruleVersionId"] in declared, "断言引用未声明规则")
            operator, expected = assertion["operator"], assertion.get("expected")
            if operator not in {"exists", "notExists"}:
                require(expected is not None, "比较断言缺少 expected")
            if operator in {"gt", "gte", "lt", "lte"}:
                require(
                    type(expected) in {int, float} and bool(assertion.get("unit")),
                    "数值断言缺少数字或单位",
                )
    covered = {
        e["ruleVersionId"]
        for e in output["coverageMap"] + output["blockedRequirements"]
    }
    require(covered == approved, "覆盖表存在越界或遗漏")
