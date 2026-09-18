import type { ParsedBlock, SourceSpanRecord } from "@ai-qa/contracts";

/** 按中英文句号分句。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。；;！？!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** DOCX/纯文本：段落索引定位（PRD FR-02 docx-paragraph）。 */
export function parsePlainParagraphs(
  text: string,
  documentVersionId: string,
): { blocks: ParsedBlock[]; spans: SourceSpanRecord[] } {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const blocks: ParsedBlock[] = [];
  const spans: SourceSpanRecord[] = [];
  let blockSeq = 0;
  let spanSeq = 0;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    blocks.push({
      id: `${documentVersionId}-blk-${String(++blockSeq).padStart(2, "0")}`,
      kind: "paragraph",
      text: paragraph,
    });
    for (const sentence of splitSentences(paragraph)) {
      spans.push({
        id: `${documentVersionId}-span-${String(++spanSeq).padStart(2, "0")}`,
        documentVersionId,
        locator: { kind: "docx-paragraph", paragraphIndex },
        quotedText: sentence.replace(/[。；;！？!?]+$/, ""),
        extractionQuality: "GOOD",
      });
    }
  });

  return { blocks, spans };
}
