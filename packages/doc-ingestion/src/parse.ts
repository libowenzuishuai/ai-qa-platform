import {
  ParsedDocumentBundle,
  type DocumentFormat,
  type ParsedDocumentBundle as Bundle,
  type VisionModelAdapter,
} from "@ai-qa/contracts";
import { extractDocxText } from "./docx.js";
import { buildCoverageSummary, parseMarkdownText } from "./markdown.js";
import { PARSER_VERSION } from "./version.js";
import { parsePlainParagraphs } from "./plain-text.js";
import { extractPdfText } from "./pdf.js";

export type ParseDocumentInput = {
  documentVersionId: string;
  format: DocumentFormat;
  data: Buffer;
  /** PNG/JPEG 可选：注入视觉模型生成描述；未注入则 NEEDS_OCR。 */
  vision?: VisionModelAdapter;
  /** 图片写入 artifact-store 后的 storageKey（vision 输入）。 */
  imageStorageKey?: string;
};

export type ParseDocumentResult =
  | { ok: true; bundle: Bundle }
  | { ok: false; parseStatus: "FAILED" | "NEEDS_OCR"; message: string; warnings?: string[] };

function finalizeBundle(partial: Omit<Bundle, "parserVersion" | "coverageSummary" | "warnings"> & {
  warnings?: string[];
}): ParseDocumentResult {
  const coverageSummary = buildCoverageSummary(partial.blocks, partial.spans);
  const candidate = {
    ...partial,
    parserVersion: PARSER_VERSION,
    coverageSummary,
    warnings: partial.warnings ?? [],
  };
  const parsed = ParsedDocumentBundle.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      parseStatus: "FAILED",
      message: parsed.error.issues.map((i) => i.message).join("; "),
      warnings: partial.warnings,
    };
  }
  return { ok: true, bundle: parsed.data };
}

function textToBlocks(documentVersionId: string, text: string, page?: number) {
  const { blocks, spans } = parseMarkdownText(text, documentVersionId);
  if (page !== undefined) {
    for (const block of blocks) {
      block.page = page;
    }
  }
  return { blocks, spans };
}

/** 主入口：按 format 解析并返回通过契约校验的 bundle。 */
export async function parseDocument(input: ParseDocumentInput): Promise<ParseDocumentResult> {
  const { documentVersionId, format, data } = input;

  if (format === "MARKDOWN" || format === "TXT") {
    const text = data.toString("utf8");
    const { blocks, spans } = parseMarkdownText(text, documentVersionId);
    if (blocks.every((b) => !b.text.trim())) {
      return { ok: false, parseStatus: "FAILED", message: "文档无有效文本" };
    }
    return finalizeBundle({
      documentVersionId,
      format,
      parseStatus: "PARSED",
      blocks,
      spans,
    });
  }

  if (format === "DOCX") {
    const text = await extractDocxText(data);
    if (!text.trim()) {
      return { ok: false, parseStatus: "FAILED", message: "DOCX 未提取到文本" };
    }
    const { blocks, spans } = parsePlainParagraphs(text, documentVersionId);
    return finalizeBundle({
      documentVersionId,
      format,
      parseStatus: "PARSED",
      blocks,
      spans,
    });
  }

  if (format === "PDF_TEXT" || format === "PDF_SCANNED") {
    let text = "";
    let nPages = 0;
    try {
      ({ text, nPages } = await extractPdfText(data));
    } catch {
      return { ok: false, parseStatus: "FAILED", message: "PDF 解析失败" };
    }
    if (!text.trim()) {
      return {
        ok: false,
        parseStatus: "NEEDS_OCR",
        message: "扫描 PDF 或无文本层，需要 OCR",
        warnings: [`pages=${nPages}`],
      };
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const blocks = lines.map((line, i) => ({
      id: `${documentVersionId}-blk-${String(i + 1).padStart(2, "0")}`,
      kind: "paragraph" as const,
      text: line.trim(),
      page: Math.min(Math.floor(i / 40) + 1, nPages || 1),
    }));
    const spans = lines.map((line, i) => ({
      id: `${documentVersionId}-span-${String(i + 1).padStart(2, "0")}`,
      documentVersionId,
      locator: { kind: "pdf-page" as const, page: Math.min(Math.floor(i / 40) + 1, nPages || 1) },
      quotedText: line.trim(),
      extractionQuality: "GOOD" as const,
    }));
    return finalizeBundle({
      documentVersionId,
      format: "PDF_TEXT",
      parseStatus: "PARSED",
      blocks,
      spans,
    });
  }

  if (format === "PNG" || format === "JPEG") {
    if (!input.vision || !input.imageStorageKey) {
      return {
        ok: false,
        parseStatus: "NEEDS_OCR",
        message: "图片解析需要视觉模型或未提供 imageStorageKey",
      };
    }
    const response = await input.vision.describeImage({
      purpose: "VISION_DESCRIBE",
      imageStorageKey: input.imageStorageKey,
      hint: "提取图片中的可见文字与结构，用于测试需求分析",
      timeoutMs: 60_000,
    });
    if (response.outcome !== "SUCCESS" || typeof response.parsedJson !== "object") {
      return {
        ok: false,
        parseStatus: "NEEDS_OCR",
        message: "视觉模型未能识别图片文字",
        warnings: [response.outcome],
      };
    }
    const description =
      typeof (response.parsedJson as { text?: unknown }).text === "string"
        ? (response.parsedJson as { text: string }).text
        : response.rawText;
    if (!description.trim()) {
      return { ok: false, parseStatus: "NEEDS_OCR", message: "图片无可识别文字" };
    }
    const { blocks, spans } = textToBlocks(documentVersionId, description);
    return finalizeBundle({
      documentVersionId,
      format,
      parseStatus: "PARSED",
      blocks: [
        {
          id: `${documentVersionId}-blk-01`,
          kind: "image",
          text: description.slice(0, 500),
          imageStorageKey: input.imageStorageKey,
        },
        ...blocks,
      ],
      spans,
      warnings: ["图片文字来自视觉模型描述"],
    });
  }

  return { ok: false, parseStatus: "FAILED", message: `不支持的格式：${format}` };
}
