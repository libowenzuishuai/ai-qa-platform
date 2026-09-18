import type { ParsedBlock, SourceSpanRecord, SpanExtractionQuality } from "@ai-qa/contracts";
import { createBundleIds, type BundleIds } from "./ids.js";

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

function stripTrailingPunct(text: string): string {
  return text.replace(/[。；;！？!?]+$/, "");
}

type MarkdownParseResult = {
  blocks: ParsedBlock[];
  spans: SourceSpanRecord[];
  warnings: string[];
};

/**
 * Markdown/TXT 解析（PRD FR-02）。
 * 行号 1-based，与 source 文件行对齐；span id 在解析时写死进 bundle。
 */
export function parseMarkdownText(
  source: string,
  documentVersionId: string,
  ids: BundleIds = createBundleIds(documentVersionId),
): MarkdownParseResult {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ParsedBlock[] = [];
  const spans: SourceSpanRecord[] = [];
  const warnings: string[] = [];
  let docTitle = "";

  const pushSpan = (
    locator: SourceSpanRecord["locator"],
    quotedText: string,
    quality: SpanExtractionQuality = "GOOD",
  ) => {
    spans.push({
      id: ids.nextSpanId(),
      documentVersionId,
      locator,
      quotedText,
      extractionQuality: quality,
    });
  };

  const pushLineSpans = (lineNum: number, text: string) => {
    const sentences = splitSentences(text);
    const parts = sentences.length > 0 ? sentences : [text];
    for (const part of parts) {
      pushSpan(
        { kind: "markdown-line", startLine: lineNum, endLine: lineNum },
        stripTrailingPunct(part),
      );
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```")) {
      warnings.push(`第 ${lineNum} 行：代码围栏暂未结构化解析，已跳过`);
      continue;
    }

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      docTitle = h1[1]!.trim();
      blocks.push({ id: ids.nextBlockId(), kind: "heading", text: docTitle });
      pushSpan({ kind: "markdown-heading", path: [docTitle] }, docTitle);
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      const text = h2[1]!.trim();
      blocks.push({ id: ids.nextBlockId(), kind: "heading", text });
      const path = docTitle ? [docTitle, text] : [text];
      pushSpan({ kind: "markdown-heading", path }, headingQuotedText(text));
      continue;
    }

    const h3 = trimmed.match(/^#{3,6}\s+(.+)$/);
    if (h3) {
      const text = h3[1]!.trim();
      blocks.push({ id: ids.nextBlockId(), kind: "heading", text });
      pushLineSpans(lineNum, text);
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const itemText = trimmed.slice(2).trim();
      blocks.push({ id: ids.nextBlockId(), kind: "listItem", text: itemText });
      pushLineSpans(lineNum, itemText);
      continue;
    }

    if (trimmed.includes("|") && trimmed.split("|").length >= 3) {
      blocks.push({ id: ids.nextBlockId(), kind: "table", text: trimmed });
      pushLineSpans(lineNum, trimmed);
      warnings.push(`第 ${lineNum} 行：Markdown 表格暂未保留行列结构，已按行降级`);
      continue;
    }

    blocks.push({ id: ids.nextBlockId(), kind: "paragraph", text: trimmed });
    pushLineSpans(lineNum, trimmed);
  }

  if (blocks.length > 0 && spans.length === 0) {
    warnings.push("文档有正文但未生成任何来源 span，请检查解析逻辑");
  }

  return { blocks, spans, warnings };
}

export function buildCoverageSummary(blocks: ParsedBlock[], spans: SourceSpanRecord[]) {
  const count = (q: SpanExtractionQuality) =>
    spans.filter((s) => s.extractionQuality === q).length;
  return {
    totalBlocks: blocks.length,
    goodSpans: count("GOOD"),
    lowSpans: count("LOW"),
    unparsedSpans: count("UNPARSED"),
  };
}
