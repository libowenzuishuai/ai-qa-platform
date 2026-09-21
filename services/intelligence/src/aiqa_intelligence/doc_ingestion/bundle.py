"""One allocator and coverage ledger for every parser. Quotes are never truncated."""

import hashlib

MAX_TEXT_CHARS = 2_000_000
MAX_BLOCKS = 20_000
PARSER_VERSION = "python-doc-ingestion-1.3"


class ParseLimit(ValueError):
    pass


class Bundle:
    def __init__(self, document_id: str, format: str):
        self.document_id, self.format = document_id, format
        self.prefix = hashlib.sha256(document_id.encode()).hexdigest()[:24]
        self.blocks: list[dict] = []
        self.spans: list[dict] = []
        self.warnings: list[str] = []
        self.characters = 0

    def warn(self, text: str):
        if text not in self.warnings:
            self.warnings.append(text)

    def add(
        self, text: str, locator: dict, *, kind="paragraph", quality="GOOD", **extra
    ):
        if (
            len(self.blocks) >= MAX_BLOCKS
            or self.characters + len(text) > MAX_TEXT_CHARS
        ):
            raise ParseLimit("提取内容超过 200 万字符或 20000 块上限")
        self.characters += len(text)
        self.blocks.append(
            {
                "id": f"b-{self.prefix}-{len(self.blocks)}",
                "kind": kind,
                "text": text,
                **extra,
            }
        )
        self.spans.append(
            {
                "id": f"s-{self.prefix}-{len(self.spans)}",
                "documentVersionId": self.document_id,
                "locator": locator,
                "quotedText": text if quality != "UNPARSED" else None,
                "extractionQuality": quality,
            }
        )

    def finish(self, status=None):
        status = status or (
            "PARSED" if any(b["text"].strip() for b in self.blocks) else "FAILED"
        )
        return {
            "documentVersionId": self.document_id,
            "format": self.format,
            "parseStatus": status,
            "parserVersion": PARSER_VERSION,
            "blocks": self.blocks,
            "spans": self.spans,
            "warnings": self.warnings,
            "coverageSummary": coverage_summary(self.blocks, self.spans),
        }


def coverage_summary(blocks: list[dict], spans: list[dict]) -> dict:
    return {
        "totalBlocks": len(blocks),
        **{
            field: sum(s["extractionQuality"] == quality for s in spans)
            for quality, field in [
                ("GOOD", "goodSpans"),
                ("LOW", "lowSpans"),
                ("UNPARSED", "unparsedSpans"),
            ]
        },
    }
