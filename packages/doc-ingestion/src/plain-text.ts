import type { ParsedBlock, SourceSpanRecord } from "@ai-qa/contracts";
import { createBundleIds, type BundleIds } from "./ids.js";

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。；;！？!?])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripTrailingPunct(text: string): string {
  return text.replace(/[。；;！？!?]+$/, "");
}

/** DOCX/纯文本：段落索引定位（PRD FR-02 docx-paragraph）。 */
export function parsePlainParagraphs(
  text: string,
  documentVersionId: string,
  ids: BundleIds = createBundleIds(documentVersionId),
): { blocks: ParsedBlock[]; spans: SourceSpanRecord[] } {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const blocks: ParsedBlock[] = [];
  const spans: SourceSpanRecord[] = [];

  paragraphs.forEach((paragraph, paragraphIndex) => {
    blocks.push({
      id: ids.nextBlockId(),
      kind: "paragraph",
      text: paragraph,
    });
    const sentences = splitSentences(paragraph);
    const parts = sentences.length > 0 ? sentences : [paragraph];
    for (const part of parts) {
      spans.push({
        id: ids.nextSpanId(),
        documentVersionId,
        locator: { kind: "docx-paragraph", paragraphIndex },
        quotedText: stripTrailingPunct(part),
        extractionQuality: "GOOD",
      });
    }
  });

  return { blocks, spans };
}
