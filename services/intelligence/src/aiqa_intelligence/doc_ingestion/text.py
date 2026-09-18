import re
from .bundle import Bundle


def parse_text(data: bytes, bundle: Bundle):
    text = data.decode("utf-8-sig")
    if "\x00" in text:
        raise ValueError("文本包含二进制空字符")
    fence = None
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        locator = {"kind": "markdown-line", "startLine": number, "endLine": number}
        kind, quality, body = "paragraph", "GOOD", line
        if bundle.format == "MARKDOWN":
            marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
            if fence:
                if (
                    marker
                    and marker[1][0] == fence[0]
                    and len(marker[1]) >= len(fence)
                    and not marker[2].strip()
                ):
                    fence = None
                    continue
                quality = "LOW"
            elif marker:
                fence = marker[1]
                bundle.warn("代码围栏内正文按原文保留为 LOW，不解释为业务标题或列表")
                continue
            elif match := re.match(r"^ {0,3}#{1,6}\s+(.+)$", line):
                kind, body = "heading", match[1]
            elif match := re.match(r"^\s*(?:[-+*]|\d+[.)])\s+(.+)$", line):
                kind, body = "listItem", match[1]
            elif "|" in line:
                kind, quality = "table", "LOW"
                bundle.warn(
                    "Markdown 表格/含竖线行保留原文；单元格语义尚未解析，质量为 LOW"
                )
            if re.search(r"!\[[^\]]*\]\(", line) or re.search(r"<[^>]+>", line):
                quality = "LOW"
                bundle.warn("Markdown 图片/HTML 仅保留源文本，未加载外部资源")
        if stripped:
            bundle.add(body, locator, kind=kind, quality=quality)
    if fence:
        bundle.warn("存在未闭合代码围栏")
    if not bundle.blocks:
        bundle.warn("文档没有可提取文字")
