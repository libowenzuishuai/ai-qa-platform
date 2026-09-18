import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { VisionModelAdapter, ModelResponse } from "@ai-qa/contracts";
import { parseDocument, MAX_FILE_BYTES } from "../src/parse.js";

async function twoPagePdf(first: string, second: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([300, 200]);
  page1.drawText(first, { x: 50, y: 150, size: 12, font });
  const page2 = doc.addPage([300, 200]);
  page2.drawText(second, { x: 50, y: 150, size: 12, font });
  return Buffer.from(await doc.save());
}

function mockVision(response: Partial<ModelResponse>): VisionModelAdapter {
  return {
    describeImage: async () =>
      ({
        parsedJson: { text: "金额超过 5000 元必须审批" },
        rawText: "{}",
        repairsApplied: [],
        provider: "mock",
        model: "mock-vision",
        requestId: "req-1",
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        outcome: "SUCCESS",
        ...response,
      }) as ModelResponse,
  };
}

describe("评审 B1–B4 回归", () => {
  it("B1：PDF 第二页文字 locator 为 page 2", async () => {
    const pdf = await twoPagePdf("FirstPage", "SecondPage");
    const result = await parseDocument({
      documentVersionId: "doc-pdf-2p",
      format: "PDF_TEXT",
      data: pdf,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const second = result.bundle.spans.find((s) => s.quotedText === "SecondPage");
    expect(second?.locator).toEqual({ kind: "pdf-page", page: 2 });
  });

  it("B2：无 h1 的列表项必须产生 span", async () => {
    const source = "# 需求\n- 金额超过 5000 元必须审批\n### 审批后禁止修改金额";
    const result = await parseDocument({
      documentVersionId: "doc-list",
      format: "MARKDOWN",
      data: Buffer.from(source, "utf8"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.spans.length).toBeGreaterThan(0);
    expect(result.bundle.spans.some((s) => s.quotedText?.includes("5000"))).toBe(true);
    expect(result.bundle.coverageSummary.unparsedSpans).toBe(0);
  });

  it("B3：图片 bundle 块 ID 唯一且 span 为 image-region", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-img",
      format: "PNG",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      imageStorageKey: "images/demo.png",
      vision: mockVision({}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.bundle.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.bundle.spans[0]?.locator.kind).toBe("image-region");
    expect(result.bundle.spans[0]?.extractionQuality).toBe("LOW");
  });

  it("B4：vision parsedJson 为 null 时返回 NEEDS_OCR bundle，不抛错", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-img-null",
      format: "JPEG",
      data: Buffer.from([0xff, 0xd8, 0xff]),
      imageStorageKey: "images/x.jpeg",
      vision: mockVision({ parsedJson: null, outcome: "SUCCESS" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.parseStatus).toBe("NEEDS_OCR");
  });

  it("B4：vision 返回 error 对象时不当作正文 PARSED", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-img-err",
      format: "PNG",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      imageStorageKey: "images/x.png",
      vision: mockVision({ parsedJson: { error: "无法识别" }, outcome: "SUCCESS" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.parseStatus).toBe("NEEDS_OCR");
  });
});

describe("NEEDS_OCR 与大小限制", () => {
  it("PNG 无 vision 返回 ok:true + NEEDS_OCR bundle（阶段二作业语义）", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-img-no-vision",
      format: "PNG",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.parseStatus).toBe("NEEDS_OCR");
  });

  it("超过 20MB 返回 FAILED", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-big",
      format: "TXT",
      data: Buffer.alloc(MAX_FILE_BYTES + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.parseStatus).toBe("FAILED");
  });
});
