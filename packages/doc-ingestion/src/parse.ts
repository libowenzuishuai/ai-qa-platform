import {
  ParsedDocumentBundle,
  type DocumentFormat,
  type ParsedDocumentBundle as Bundle,
  type VisionModelAdapter,
} from "@ai-qa/contracts";
import { extractDocxText } from "./docx.js";
import { createBundleIds } from "./ids.js";
import { buildCoverageSummary, parseMarkdownText } from "./markdown.js";
import { parsePlainParagraphs } from "./plain-text.js";
import { extractPdfPages } from "./pdf.js";
import { PARSER_VERSION } from "./version.js";
import { extractVisionText, WHOLE_IMAGE_BBOX } from "./vision.js";

/** PRD FR-02 / jobs.ts：单文件上限 20MB（解析入口早拒）。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type ParseDocumentInput = {
  documentVersionId: string;
  format: DocumentFormat;
  data: Buffer;
  /** PNG/JPEG 可选：注入视觉模型；未注入则 NEEDS_OCR bundle。 */
  vision?: VisionModelAdapter;
  /** 图片 storageKey（vision 输入与 image block 引用）。 */
  imageStorageKey?: string;
};

export type ParseDocumentResult =
  | { ok: true; bundle: Bundle }
  | { ok: false; parseStatus: "FAILED"; message: string; warnings?: string[] };

function finalizeBundle(
  partial: Omit<Bundle, "parserVersion" | "coverageSummary" | "warnings"> & {
    warnings?: string[];
  },
): ParseDocumentResult {
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

function needsOcrBundle(
  documentVersionId: string,
  format: Extract<DocumentFormat, "PDF_SCANNED" | "PNG" | "JPEG">,
  warnings: string[],
): ParseDocumentResult {
  return finalizeBundle({
    documentVersionId,
    format,
    parseStatus: "NEEDS_OCR",
    blocks: [],
    spans: [],
    warnings,
  });
}

/** 主入口：按 format 解析并返回通过契约校验的 bundle。 */
export async function parseDocument(input: ParseDocumentInput): Promise<ParseDocumentResult> {
  const { documentVersionId, format, data } = input;

  if (data.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      parseStatus: "FAILED",
      message: `文件大小 ${data.length} 超过上限 ${MAX_FILE_BYTES} 字节`,
    };
  }

  if (format === "MARKDOWN" || format === "TXT") {
    const text = data.toString("utf8");
    const { blocks, spans, warnings } = parseMarkdownText(text, documentVersionId);
    if (blocks.every((b) => !b.text.trim())) {
      return { ok: false, parseStatus: "FAILED", message: "文档无有效文本" };
    }
    return finalizeBundle({
      documentVersionId,
      format,
      parseStatus: "PARSED",
      blocks,
      spans,
      warnings,
    });
  }

  if (format === "DOCX") {
    let text: string;
    try {
      text = await extractDocxText(data);
    } catch {
      return { ok: false, parseStatus: "FAILED", message: "DOCX 解析失败（文件可能已损坏）" };
    }
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
    let pages: Awaited<ReturnType<typeof extractPdfPages>>["pages"];
    let nPages: number;
    try {
      ({ pages, nPages } = await extractPdfPages(data));
    } catch {
      return { ok: false, parseStatus: "FAILED", message: "PDF 解析失败" };
    }

    const ids = createBundleIds(documentVersionId);
    const blocks: Bundle["blocks"] = [];
    const spans: Bundle["spans"] = [];
    const warnings: string[] = [];

    for (const { page, text } of pages) {
      if (!text.trim()) {
        warnings.push(`第 ${page} 页无文本层，可能为扫描页`);
        spans.push({
          id: ids.nextSpanId(),
          documentVersionId,
          locator: { kind: "pdf-page", page },
          quotedText: null,
          extractionQuality: "UNPARSED",
        });
        continue;
      }
      for (const line of text.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
        blocks.push({
          id: ids.nextBlockId(),
          kind: "paragraph",
          text: line,
          page,
        });
        spans.push({
          id: ids.nextSpanId(),
          documentVersionId,
          locator: { kind: "pdf-page", page },
          quotedText: line,
          extractionQuality: "GOOD",
        });
      }
    }

    const hasText = blocks.some((b) => b.text.trim().length > 0);
    if (!hasText) {
      return needsOcrBundle(documentVersionId, "PDF_SCANNED", [
        ...warnings,
        `pages=${nPages}`,
        "扫描 PDF 或无文本层，需要 OCR",
      ]);
    }

    return finalizeBundle({
      documentVersionId,
      format: "PDF_TEXT",
      parseStatus: "PARSED",
      blocks,
      spans,
      warnings,
    });
  }

  if (format === "PNG" || format === "JPEG") {
    if (!input.vision || !input.imageStorageKey) {
      return needsOcrBundle(documentVersionId, format, [
        "图片解析需要视觉模型或未提供 imageStorageKey",
      ]);
    }

    let response;
    try {
      response = await input.vision.describeImage({
        purpose: "VISION_DESCRIBE",
        imageStorageKey: input.imageStorageKey,
        hint: "提取图片中的可见文字，返回 JSON：{ \"text\": \"...\" }",
        outputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        timeoutMs: 60_000,
      });
    } catch {
      return needsOcrBundle(documentVersionId, format, ["视觉模型调用失败"]);
    }

    const description = extractVisionText(response);
    if (!description) {
      return needsOcrBundle(documentVersionId, format, [
        `视觉模型未能返回有效 text（outcome=${response.outcome}）`,
      ]);
    }

    const ids = createBundleIds(documentVersionId);
    const imageBlockId = ids.nextBlockId();
    const spanId = ids.nextSpanId();

    return finalizeBundle({
      documentVersionId,
      format,
      parseStatus: "PARSED",
      blocks: [
        {
          id: imageBlockId,
          kind: "image",
          text: description.slice(0, 500),
          imageStorageKey: input.imageStorageKey,
        },
      ],
      spans: [
        {
          id: spanId,
          documentVersionId,
          locator: { kind: "image-region", bbox: [...WHOLE_IMAGE_BBOX] },
          quotedText: description,
          extractionQuality: "LOW",
        },
      ],
      warnings: ["图片文字来自视觉模型描述，证据质量为 LOW（非逐字 OCR）"],
    });
  }

  return { ok: false, parseStatus: "FAILED", message: `不支持的格式：${format}` };
}
