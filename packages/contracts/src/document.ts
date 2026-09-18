import { z } from "zod";
import { EntityId } from "./common.js";

/**
 * 文档解析契约（阶段 2 第 0 步 · docs/stage2-step0-contracts.md §2.1）。
 * 起草：原泽菲（B）；消费：李琦双（C）的规则提取作业。
 *
 * 枚举逐字 lift 自 apps/api/prisma/schema.prisma 注释，不改名、不增删值。
 */

/** DocumentVersion.format。PDF 在解析后才区分 PDF_TEXT / PDF_SCANNED。 */
export const DocumentFormat = z.enum([
  "MARKDOWN",
  "TXT",
  "DOCX",
  "PDF_TEXT",
  "PDF_SCANNED",
  "PNG",
  "JPEG",
]);
export type DocumentFormat = z.infer<typeof DocumentFormat>;

/** DocumentVersion.parseStatus。注意终态是 FAILED，不是 PARSE_FAILED。 */
export const ParseStatus = z.enum([
  "PENDING",
  "PARSING",
  "PARSED",
  "FAILED",
  "NEEDS_OCR",
]);
export type ParseStatus = z.infer<typeof ParseStatus>;

/** SourceSpan.extractionQuality：质量挂 span，不是 bundle 级。 */
export const SpanExtractionQuality = z.enum(["GOOD", "LOW", "UNPARSED"]);
export type SpanExtractionQuality = z.infer<typeof SpanExtractionQuality>;

/**
 * SourceSpan.locator：六种，闭集 discriminated union。
 * 【v2 已决】locator 是位置的唯一描述——DB 的 imageRegion 列保留但
 * 契约层不镜像它（与 locator.image-region 语义重叠，双写必漂移）。
 */
export const SourceLocator = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("markdown-line"),
    startLine: z.number().int(),
    endLine: z.number().int(),
  }),
  z.object({
    kind: z.literal("markdown-heading"),
    path: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("docx-paragraph"),
    paragraphIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal("docx-cell"),
    tableIndex: z.number().int(),
    row: z.number().int(),
    col: z.number().int(),
  }),
  z.object({
    kind: z.literal("pdf-page"),
    page: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("image-region"),
    bbox: z.array(z.number()).length(4),
  }),
]);
export type SourceLocator = z.infer<typeof SourceLocator>;

/** 与 SourceSpan 表一一对应。id 由解析时生成并写死进 bundle（裁决点 2 已决）。 */
export const SourceSpanRecord = z.object({
  id: EntityId,
  documentVersionId: EntityId,
  locator: SourceLocator,
  /** 原文逐字引用。EXPLICIT 验收 = quotedText 能在所属文档 block 文本中找到。 */
  quotedText: z.string().nullable(),
  extractionQuality: SpanExtractionQuality.default("GOOD"),
});
export type SourceSpanRecord = z.infer<typeof SourceSpanRecord>;

/** 有序内容块：模型读正文靠它。 */
export const ParsedBlock = z.object({
  id: EntityId,
  kind: z.enum(["heading", "paragraph", "table", "listItem", "image"]),
  text: z.string(),
  page: z.number().int().optional(),
  /** kind=image 时指向图片文件。 */
  imageStorageKey: z.string().optional(),
});
export type ParsedBlock = z.infer<typeof ParsedBlock>;

/**
 * 解析产物：解析器输出 → 存 artifact-store（key=documentVersionId）→
 * 规则提取作业输入。提示词 §5.1 输入变量 sourceSpans 即本结构 spans 的
 * 展开物（bundle 自包含，避免两处 id 集合漂移）。
 */
export const ParsedDocumentBundle = z
  .object({
    documentVersionId: EntityId,
    format: DocumentFormat,
    parseStatus: ParseStatus,
    parserVersion: z.string().min(1),
    blocks: z.array(ParsedBlock),
    spans: z.array(SourceSpanRecord),
    /** 与 DocumentVersion.coverageSummary 同构：数字对账，防静默丢内容。 */
    coverageSummary: z.object({
      totalBlocks: z.number().int(),
      goodSpans: z.number().int(),
      lowSpans: z.number().int(),
      unparsedSpans: z.number().int(),
    }),
    warnings: z.array(z.string()).default([]),
  })
  .superRefine((b, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    // 验收红线写成 schema（PRD FR-02）：PARSED 必须有实际文本。
    if (b.parseStatus === "PARSED" && !b.blocks.some((x) => x.text.trim().length > 0)) {
      fail("blocks", "PARSED 必须包含非空文本；扫描 PDF 应为 NEEDS_OCR 或 FAILED，禁止空文本成功");
    }
    if (
      b.parseStatus === "NEEDS_OCR" &&
      !["PDF_SCANNED", "PNG", "JPEG"].includes(b.format)
    ) {
      fail("parseStatus", "NEEDS_OCR 只应出现在 PDF_SCANNED / PNG / JPEG");
    }
    // 数字对账（PRD FR-02：未成功解析的部分必须显式展示）。
    const count = (q: string) => b.spans.filter((s) => s.extractionQuality === q).length;
    if (
      b.coverageSummary.goodSpans !== count("GOOD") ||
      b.coverageSummary.lowSpans !== count("LOW") ||
      b.coverageSummary.unparsedSpans !== count("UNPARSED")
    ) {
      fail("coverageSummary", "coverageSummary 计数与 spans 实际质量分布不一致");
    }
    // 裁决点 2 已决：span 属于本 bundle，documentVersionId 必须一致。
    for (const [i, span] of b.spans.entries()) {
      if (span.documentVersionId !== b.documentVersionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spans", i, "documentVersionId"],
          message: `span ${span.id} 的 documentVersionId 与 bundle 不一致（应自包含）`,
        });
      }
    }
  });
export type ParsedDocumentBundle = z.infer<typeof ParsedDocumentBundle>;
