import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CaseGenerationInput,
  CaseGenerationOutput,
  DEFAULT_HTTP_STATUS_BY_CODE,
  ModelProvider,
  ParsedDocumentBundle,
  RuleExtractionInput,
  RuleExtractionOutput,
  RuleVersion,
  validateCaseGeneration,
  validateRuleExtraction,
} from "../src/index.js";

/**
 * 阶段 2 第 0 步测试（docs/stage2-step0-contracts.md §4）。
 * 断言归属：原泽菲（解析红线）· 李琦双（联合校验/不补造）· 李博闻（枚举/映射）。
 * 既有 81 项测试是基线，本文件只追加，不放宽任何既有断言。
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, dir, file), "utf8"));
}

const FIXTURES_BY_ID = ["01-explicit-prd", "02-conflict-prd", "03-missing-boundary"];

function loadBundle(dir: string) {
  return ParsedDocumentBundle.parse(loadJson(dir, "parsed-bundle.json"));
}
function loadGolden(dir: string) {
  return RuleExtractionOutput.parse(loadJson(dir, "expected-rule-drafts.json"));
}
function loadInput(dir: string, promptVersion = "prompt-v1") {
  return RuleExtractionInput.parse({
    projectGlossary: [],
    documentVersions: [loadJson(dir, "parsed-bundle.json")],
    images: [],
    promptVersion,
  });
}

describe("fixture round-trip（原泽菲 bundle / 李琦双 golden）", () => {
  it.each(FIXTURES_BY_ID)("%s：bundle 过 ParsedDocumentBundle", (dir) => {
    expect(() => loadBundle(dir)).not.toThrow();
  });
  it.each(FIXTURES_BY_ID)("%s：golden 过 RuleExtractionOutput", (dir) => {
    expect(() => loadGolden(dir)).not.toThrow();
  });
  it.each(FIXTURES_BY_ID)("%s：validateRuleExtraction 通过", (dir) => {
    const result = validateRuleExtraction(loadInput(dir), loadGolden(dir));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("EXPLICIT 出处与引用闭合（李琦双）", () => {
  it("删除 EXPLICIT draft 的 sources → 报错", () => {
    const golden = loadGolden("01-explicit-prd");
    golden.ruleDrafts[0]!.sources = [];
    const result = validateRuleExtraction(loadInput("01-explicit-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("EXPLICIT");
  });

  it("sourceSpanIds 改为不存在 id → 报错（拦编造引用）", () => {
    const golden = loadGolden("01-explicit-prd");
    golden.ruleDrafts[0]!.sources[0]!.sourceSpanIds = ["span-not-exist"];
    const result = validateRuleExtraction(loadInput("01-explicit-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("不存在的 span");
  });

  it("quotedText 改为原文没有的句子 → 报错（拦张冠李戴）", () => {
    const bundleJson = loadJson("01-explicit-prd", "parsed-bundle.json") as {
      spans: Array<{ id: string; quotedText: string }>;
    };
    bundleJson.spans[1]!.quotedText = "这句原文里根本没有";
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [bundleJson],
      images: [],
      promptVersion: "prompt-v1",
    });
    const result = validateRuleExtraction(input, loadGolden("01-explicit-prd"));
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("quotedText");
  });

  it("来源声明与 span 归属不一致 → 报错", () => {
    // 输入同时给两个文档：draft 声明 doc-v-02，但 span-01-2 属于 doc-v-01。
    const input = RuleExtractionInput.parse({
      projectGlossary: [],
      documentVersions: [
        loadJson("01-explicit-prd", "parsed-bundle.json"),
        loadJson("02-conflict-prd", "parsed-bundle.json"),
      ],
      images: [],
      promptVersion: "prompt-v1",
    });
    const golden = loadGolden("01-explicit-prd");
    golden.ruleDrafts[0]!.sources[0]!.documentVersionId = "doc-v-02";
    const result = validateRuleExtraction(input, golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("归属");
  });

  it("冲突删除任一方的 conflictsWith → 报错（不许单方消解）", () => {
    const golden = loadGolden("02-conflict-prd");
    golden.ruleDrafts[1]!.conflictsWith = [];
    const result = validateRuleExtraction(loadInput("02-conflict-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("互相指向");
  });

  it("conflictsWith 指向不存在的 key → 报错（引用闭合）", () => {
    const golden = loadGolden("01-explicit-prd");
    golden.ruleDrafts[0]!.conflictsWith = ["rule-draft-99"];
    const result = validateRuleExtraction(loadInput("01-explicit-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("不存在的 key");
  });

  it("澄清项引用不存在的 key → 报错", () => {
    const golden = loadGolden("02-conflict-prd");
    golden.clarifications[0]!.ruleDraftKeys = ["rule-draft-99"];
    const result = validateRuleExtraction(loadInput("02-conflict-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("draft key");
  });

  it("draft key 重复 → 报错", () => {
    const golden = loadGolden("01-explicit-prd");
    golden.ruleDrafts[1]!.key = golden.ruleDrafts[0]!.key;
    const result = validateRuleExtraction(loadInput("01-explicit-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("重复 key");
  });

  it("unparsedRanges 引用不存在的 span → 报错", () => {
    const golden = loadGolden("01-explicit-prd");
    golden.unparsedRanges.push({ spanId: "span-not-exist", reason: "OTHER" });
    const result = validateRuleExtraction(loadInput("01-explicit-prd"), golden);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("unparsedRanges");
  });
});

describe("不补造（李琦双 · fixture 03 负向断言）", () => {
  it("golden 中所有 businessFields.value 均非数字（无依据不编数）", () => {
    const golden = loadGolden("03-missing-boundary");
    for (const draft of golden.ruleDrafts) {
      for (const field of draft.businessFields) {
        expect(typeof field.value).not.toBe("number");
      }
    }
    // 边界规则为 UNKNOWN 且澄清项询问金额边界。
    expect(golden.ruleDrafts[0]!.classification).toBe("UNKNOWN");
    expect(golden.clarifications[0]!.kind).toBe("MISSING_INFO");
  });
});

describe("解析红线（原泽菲）", () => {
  it("PARSED + 全空 blocks → schema 拒绝", () => {
    const bundle = loadJson("01-explicit-prd", "parsed-bundle.json") as {
      blocks: Array<{ text: string }>;
    };
    bundle.blocks = bundle.blocks.map((b) => ({ ...b, text: "   " }));
    expect(() => ParsedDocumentBundle.parse(bundle)).toThrow(/非空文本/);
  });

  it("coverageSummary 计数手改 → 拒绝", () => {
    const bundle = loadJson("01-explicit-prd", "parsed-bundle.json") as {
      coverageSummary: { goodSpans: number };
    };
    bundle.coverageSummary.goodSpans = 99;
    expect(() => ParsedDocumentBundle.parse(bundle)).toThrow(/不一致/);
  });

  it("NEEDS_OCR + MARKDOWN → 拒绝（只应出现在扫描格式）", () => {
    const bundle = loadJson("01-explicit-prd", "parsed-bundle.json") as {
      parseStatus: string;
    };
    bundle.parseStatus = "NEEDS_OCR";
    expect(() => ParsedDocumentBundle.parse(bundle)).toThrow(/NEEDS_OCR/);
  });

  it("NEEDS_OCR + PDF_SCANNED 合法（真实场景形状）", () => {
    const bundle = loadJson("01-explicit-prd", "parsed-bundle.json") as {
      format: string;
      parseStatus: string;
      blocks: unknown[];
      spans: unknown[];
    };
    bundle.format = "PDF_SCANNED";
    bundle.parseStatus = "NEEDS_OCR";
    bundle.blocks = [];
    bundle.spans = [];
    expect(() =>
      ParsedDocumentBundle.parse({
        ...bundle,
        coverageSummary: { totalBlocks: 0, goodSpans: 0, lowSpans: 0, unparsedSpans: 0 },
      }),
    ).not.toThrow();
  });
});

describe("用例生成联合校验（李琦双）", () => {
  function makeInput() {
    // 用 fixture 01 的 golden 伪造已批准规则。
    const golden = loadGolden("01-explicit-prd");
    const approved = golden.ruleDrafts.map((draft, i) =>
      RuleVersion.parse({
        id: `rule-approved-${i + 1}`,
        ruleId: `rule-${i + 1}`,
        version: 1,
        statement: draft.statement,
        // 伪造实体不带真实来源：用 INFERRED 通过既有 refine（EXPLICIT
        // 无来源会被 rule.ts 拒绝——本测试只关心引用闭合，不测出处）。
        classification: "INFERRED" as const,
        action: draft.action,
        expectation: draft.expectation,
        sources: [],
        origin: "model",
        reviewStatus: "APPROVED",
        createdAt: "2026-09-18T00:00:00Z",
      }),
    );
    return CaseGenerationInput.parse({
      approvedRuleVersions: approved,
      clarificationSources: [],
      roles: ["申请人", "主管"],
      fixtureCapabilities: ["fixture-order-paid"],
      executorCapabilities: ["goto", "fill", "click", "assert"],
      promptVersion: "prompt-v1",
    });
  }
  function makeDraftOutput(overrides: {
    ruleVersionId?: string;
    fixtureId?: string;
    dropCoverageRuleId?: string;
  } = {}) {
    const input = makeInput();
    const ruleId = input.approvedRuleVersions[0]!.id;
    const output = CaseGenerationOutput.parse({
      caseDrafts: [
        {
          title: "超过阈值需审批",
          ruleVersionIds: [ruleId],
          roles: ["申请人", "主管"],
          dataSpec: overrides.fixtureId
            ? { strategy: "fixture", fixtureId: overrides.fixtureId, params: {} }
            : { strategy: "create", note: "页面创建" },
          steps: [{ role: "申请人", action: "创建并提交采购单" }],
          assertions: [
            {
              id: "a1",
              description: "状态为待审批",
              kind: "ui.text",
              required: true,
              ruleVersionId: overrides.ruleVersionId ?? ruleId,
              operator: "equals",
              expected: "待审批",
            },
          ],
          cleanup: { strategy: "namespace" },
          dimensions: ["BOUNDARY"],
        },
      ],
      coverageMap: input.approvedRuleVersions
        .filter((r) => r.id !== overrides.dropCoverageRuleId)
        .map((r) => ({ ruleVersionId: r.id, caseCount: r.id === ruleId ? 1 : 0, dimensionsCovered: r.id === ruleId ? ["BOUNDARY"] : [] })),
      blockedRequirements: input.approvedRuleVersions.filter(r => r.id !== ruleId && r.id !== overrides.dropCoverageRuleId)
        .map(r => ({ ruleVersionId: r.id, reason: "INSUFFICIENT_INFO", detail: "本样例只构造第一条规则的用例" })),
    });
    return { input, output };
  }

  it("合法草稿通过", () => {
    const { input, output } = makeDraftOutput({});
    const result = validateCaseGeneration(input, output);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("断言引用未声明/未批准的规则 → 报错", () => {
    const { input, output } = makeDraftOutput({ ruleVersionId: "rule-not-approved" });
    const result = validateCaseGeneration(input, output);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/未声明|未批准/);
  });

  it("引用不可用 fixture → 报错", () => {
    const { input, output } = makeDraftOutput({ fixtureId: "fixture-not-registered" });
    const result = validateCaseGeneration(input, output);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("不可用 fixture");
  });

  it("coverageMap 漏掉一条规则（且无 blocked）→ 报错（不得隐藏遗漏）", () => {
    const base = makeDraftOutput({});
    const { input, output } = makeDraftOutput({
      dropCoverageRuleId: base.input.approvedRuleVersions[1]!.id,
    });
    const result = validateCaseGeneration(input, output);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("不得隐藏资料遗漏");
  });

  it("步骤角色越界 → 报错", () => {
    const { input, output } = makeDraftOutput({});
    output.caseDrafts[0]!.steps.push({ role: "审计员", action: "查看" });
    const result = validateCaseGeneration(input, output);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("角色");
  });
});

describe("枚举与错误码映射（李博闻）", () => {
  it("ModelProvider = moonshot/mock；glm 被拒（防回退）", () => {
    expect(ModelProvider.options).toEqual(["moonshot", "mock"]);
    expect(ModelProvider.safeParse("glm").success).toBe(false);
    expect(ModelProvider.safeParse("zhipu").success).toBe(false);
    expect(ModelProvider.parse("moonshot")).toBe("moonshot");
  });

  it("新增 5 码都有默认 HTTP 映射", () => {
    expect(DEFAULT_HTTP_STATUS_BY_CODE.MODEL_NOT_CONFIGURED).toBe(503);
    expect(DEFAULT_HTTP_STATUS_BY_CODE.MODEL_OUTPUT_INVALID).toBe(500);
    expect(DEFAULT_HTTP_STATUS_BY_CODE.MODEL_TIMEOUT).toBe(504);
    expect(DEFAULT_HTTP_STATUS_BY_CODE.PARSE_FAILED).toBe(422);
    expect(DEFAULT_HTTP_STATUS_BY_CODE.NEEDS_OCR).toBe(422);
  });

  it("fileSizeBytes 超 20MB → 拒绝（PRD FR-02）", async () => {
    const { DocumentParseJobRequest } = await import("../src/index.js");
    expect(
      DocumentParseJobRequest.safeParse({
        title: "t",
        declaredFormat: "MARKDOWN",
        fileSizeBytes: 21 * 1024 * 1024,
      }).success,
    ).toBe(false);
  });
});
