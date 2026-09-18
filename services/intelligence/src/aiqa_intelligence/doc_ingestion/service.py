from ..context import RequestContext
from ..contracts.generated import DocumentParseInput, ParsedDocumentBundle
from ..errors import ServiceError


class DocumentParser:
    ready = False

    async def parse_document(
        self, input: DocumentParseInput, context: RequestContext
    ) -> ParsedDocumentBundle:
        """B implements: verified source bytes -> bundle; NEEDS_OCR is a valid bundle status.

        Read bytes using context.artifacts.read(input.storageKey,
            size=input.fileSizeBytes, checksum=input.checksum).
        Never guess PDF page numbers or return Markdown locators for images.
        """
        raise ServiceError(
            "DEPENDENCY_UNAVAILABLE", "Python 文档解析模块待 B 通道实现", 503
        )
