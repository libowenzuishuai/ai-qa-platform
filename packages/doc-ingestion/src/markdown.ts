import type { ParsedBlock, SourceSpanRecord } from "@ai-qa/contracts";
/** h2+ 标题 quotedText：去掉「数字. 」前缀（对齐 fixture 手工写法）。 */
function headingQuotedText(text: string): string {
  return text.replace(/^\d+\.\s*/, "").trim() || text;
}

/** 按中英文句号分句，保留可定位片段。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。；;！？!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type MarkdownParseResult = {
  blocks: ParsedBlock[];
  spans: SourceSpanRecord[];
};

/**
 * Markdown/TXT 解析（PRD FR-02）。
 * 行号 1-based，与 source 文件行对齐；span id 在解析时写死进 bundle。
 */
export function parseMarkdownText(
  source: string,
  documentVersionId: string,
): MarkdownParseResult {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ParsedBlock[] = [];
  const spans: SourceSpanRecord[] = [];
  let docTitle = "";
  let blockSeq = 0;
  let spanSeq = 0;

  const nextBlockId = () => `${documentVersionId}-blk-${String(++blockSeq).padStart(2, "0")}`;
  const nextSpanId = () => `${documentVersionId}-span-${String(++spanSeq).padStart(2, "0")}`;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      docTitle = h1[1]!.trim();
      blocks.push({ id: nextBlockId(), kind: "heading", text: docTitle });
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      const text = h2[1]!.trim();
      blocks.push({ id: nextBlockId(), kind: "heading", text });
      if (docTitle) {
        spans.push({
          id: nextSpanId(),
          documentVersionId,
          locator: { kind: "markdown-heading", path: [docTitle, text] },
          quotedText: headingQuotedText(text),
          extractionQuality: "GOOD",
        });
      }
      continue;
    }

    const h3 = trimmed.match(/^#{3,6}\s+(.+)$/);
    if (h3) {
      blocks.push({ id: nextBlockId(), kind: "heading", text: h3[1]!.trim() });
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      blocks.push({ id: nextBlockId(), kind: "listItem", text: trimmed.slice(2).trim() });
      continue;
    }

    blocks.push({ id: nextBlockId(), kind: "paragraph", text: trimmed });
    for (const sentence of splitSentences(trimmed)) {
      spans.push({
        id: nextSpanId(),
        documentVersionId,
        locator: { kind: "markdown-line", startLine: lineNum, endLine: lineNum },
        quotedText: sentence.replace(/[。；;！？!?]+$/, ""),
        extractionQuality: "GOOD",
      });
    }
  }

  return { blocks, spans };
}

export function buildCoverageSummary(blocks: ParsedBlock[], spans: SourceSpanRecord[]) {
  const count = (q: "GOOD" | "LOW" | "UNPARSED") =>
    spans.filter((s) => s.extractionQuality === q).length;
  return {
    totalBlocks: blocks.length,
    goodSpans: count("GOOD"),
    lowSpans: count("LOW"),
    unparsedSpans: count("UNPARSED"),
  };
}
