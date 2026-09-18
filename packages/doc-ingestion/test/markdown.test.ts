import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ParsedDocumentBundle, validateRuleExtraction, RuleExtractionInput } from "@ai-qa/contracts";
import { parseDocument } from "../src/parse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/fixtures");

function loadFixture(name: string) {
  const dir = join(FIXTURES, name);
  return {
    source: readFileSync(join(dir, "source.md"), "utf8"),
    golden: JSON.parse(readFileSync(join(dir, "parsed-bundle.json"), "utf8")),
  };
}

describe("parseDocument · MARKDOWN fixtures", () => {
  for (const name of ["01-explicit-prd", "02-conflict-prd", "03-missing-boundary"] as const) {
    it(`${name} 产出通过 ParsedDocumentBundle 校验`, async () => {
      const { source, golden } = loadFixture(name);
      const result = await parseDocument({
        documentVersionId: golden.documentVersionId,
        format: "MARKDOWN",
        data: Buffer.from(source, "utf8"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.parseStatus).toBe("PARSED");
      expect(result.bundle.blocks.length).toBeGreaterThanOrEqual(5);
      expect(result.bundle.coverageSummary.goodSpans).toBe(result.bundle.spans.length);
    });
  }

  it("01-explicit-prd 含阈值句 span 且 quotedText 在 blocks 中", async () => {
    const { source, golden } = loadFixture("01-explicit-prd");
    const result = await parseDocument({
      documentVersionId: golden.documentVersionId,
      format: "MARKDOWN",
      data: Buffer.from(source, "utf8"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const needle = "订单金额超过 5000.00 元的采购单必须提交部门主管审批";
    const blockText = result.bundle.blocks.map((b) => b.text).join("\n");
    expect(blockText).toContain(needle);
    expect(result.bundle.spans.some((s) => s.quotedText?.includes("5000.00"))).toBe(true);
  });

  it("02-conflict-prd 两个冲突段落均可定位", async () => {
    const { source, golden } = loadFixture("02-conflict-prd");
    const result = await parseDocument({
      documentVersionId: golden.documentVersionId,
      format: "MARKDOWN",
      data: Buffer.from(source, "utf8"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const texts = result.bundle.spans.map((s) => s.quotedText ?? "");
    expect(texts.some((t) => t.includes("仍可修改报销金额"))).toBe(true);
    expect(texts.some((t) => t.includes("金额锁定"))).toBe(true);
  });

  it("03-missing-boundary 无具体金额数字", async () => {
    const { source, golden } = loadFixture("03-missing-boundary");
    const result = await parseDocument({
      documentVersionId: golden.documentVersionId,
      format: "MARKDOWN",
      data: Buffer.from(source, "utf8"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const joined = result.bundle.blocks.map((b) => b.text).join(" ");
    expect(joined).not.toMatch(/\d{3,}/);
  });
});

describe("parseDocument · 红线", () => {
  it("空 Markdown 返回 FAILED，不是 PARSED", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-empty",
      format: "MARKDOWN",
      data: Buffer.from("   \n\n  ", "utf8"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.parseStatus).toBe("FAILED");
  });

  it("PNG 无 vision 返回 NEEDS_OCR", async () => {
    const result = await parseDocument({
      documentVersionId: "doc-img",
      format: "PNG",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.parseStatus).toBe("NEEDS_OCR");
  });
});

describe("bundle 可被规则提取输入消费", () => {
  it("01 bundle 通过 RuleExtractionInput 形状校验", async () => {
    const { source, golden } = loadFixture("01-explicit-prd");
    const parsed = await parseDocument({
      documentVersionId: golden.documentVersionId,
      format: "MARKDOWN",
      data: Buffer.from(source, "utf8"),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [parsed.bundle],
      images: [],
      promptVersion: "test",
    });
    expect(input.documentVersions[0]?.spans.length).toBeGreaterThan(0);
    // 联合校验需 golden output；此处只验证 bundle 进入 pipeline 输入不报错。
    expect(ParsedDocumentBundle.parse(parsed.bundle)).toBeTruthy();
    void validateRuleExtraction;
  });
});
