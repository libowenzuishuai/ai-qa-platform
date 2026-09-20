import { z } from "zod";
import { EntityId } from "./common.js";
import { RuleClassification } from "./enums.js";
import { BusinessField } from "./rule.js";
import { ParsedDocumentBundle } from "./document.js";

/**
 * 需求分析（规则提取）契约（阶段 2 第 0 步 · docs/stage2-step0-contracts.md §2.3）。
 * 起草：李琦双（C）；消费：入库前校验与 worker。
 *
 * 字段名对齐提示词 §5.1（docs/ai-qa/03-GLM开发提示词.md）。
 * 映射说明【已决】：§5.1 输入变量 sourceSpans 在契约中不设独立字段，
 * 它是 documentVersions[].spans 的展开物（bundle 自包含，避免两处
 * id 集合漂移）。组装提示词时按此映射展开。
 */

/** §5.1 输入。 */
export const RuleExtractionInput = z.object({
  projectGlossary: z
    .array(z.object({ term: z.string(), definition: z.string() }))
    .default([]),
  documentVersions: z.array(ParsedDocumentBundle).min(1),
  images: z
    .array(z.object({ storageKey: z.string(), spanId: EntityId }))
    .default([]),
  /** 写 RuleVersion.promptVersion。 */
  promptVersion: z.string().min(1),
});
export type RuleExtractionInput = z.infer<typeof RuleExtractionInput>;

/**
 * 【v2 已决】draft 带稳定 key——conflictsWith / ruleDraftKeys 的引用锚点。
 * 入库时丢弃 key、换成真实规则版本 id。
 */
export const RuleDraft = z.object({
  key: z.string().regex(/^rule-draft-\d{2,}$/, "draft key 形如 rule-draft-01，同批唯一"),
  statement: z.string().min(1),
  classification: RuleClassification,
  role: z.string().optional(),
  precondition: z.string().optional(),
  action: z.string().min(1),
  condition: z.string().optional(),
  expectation: z.string().min(1),
  forbiddenBehaviors: z.array(z.string()).default([]),
  priority: z.enum(["P0", "P1", "P2"]).default("P1"),
  businessFields: z.array(BusinessField).default([]),
  /** 与 RuleSource 同构；spanId 存在性由联合校验保证。 */
  sources: z
    .array(
      z.object({
        documentVersionId: EntityId,
        sourceSpanIds: z.array(EntityId).min(1),
      }),
    )
    .default([]),
  /** 引用同批 draft 的 key（不是未来的实体 id）。 */
  conflictsWith: z.array(z.string()).default([]),
});
export type RuleDraft = z.infer<typeof RuleDraft>;

export const ClarificationDraft = z.object({
  ruleDraftKeys: z.array(z.string()).min(1),
  question: z.string().min(1),
  /** kind 缺失即 PRD 遗漏；CONFLICT 时双方来源已在各 draft 里。 */
  kind: z.enum(["MISSING_INFO", "CONFLICT", "AMBIGUITY"]),
});
export type ClarificationDraft = z.infer<typeof ClarificationDraft>;

/** 无法解析的内容：引用真实 spanId + 原因，供 coverageSummary 对账。 */
export const UnparsedRange = z.object({
  spanId: EntityId,
  reason: z.enum(["TABLE_DEGRADED", "LOW_QUALITY_IMAGE", "IRRELEVANT", "OTHER"]),
});
export type UnparsedRange = z.infer<typeof UnparsedRange>;

/** §5.1 输出：ruleDrafts / clarifications / unparsedRanges。 */
export const RuleExtractionOutput = z.object({
  ruleDrafts: z.array(RuleDraft),
  clarifications: z.array(ClarificationDraft),
  unparsedRanges: z.array(UnparsedRange),
});
export type RuleExtractionOutput = z.infer<typeof RuleExtractionOutput>;

export interface RuleExtractionValidation {
  ok: boolean;
  problems: string[];
}

/**
 * 联合校验（worker 入库前调用；每条都有反例测试）：
 * 1. EXPLICIT draft 必须有来源（镜像 rule.ts 的 refine）；
 * 2. 所有 sourceSpanIds ∈ 输入 spans 的 id 集合（比 RuleVersion 更强——
 *    入库前就拦住编造引用）；source.documentVersionId 必须与 span 归属一致；
 * 3. 引用 span 的 quotedText 逐字出现在同一 documentVersion 的 blocks
 *    文本中（拦跨文档张冠李戴与纯编造）；
 * 4. unparsedRanges.spanId 同样 ∈ 输入 spans；
 * 5. draft key 同批唯一；conflictsWith 与 ruleDraftKeys 的每个值都 ∈
 *    同批 key 集合（引用闭合）；conflictsWith 互相指向（不许单方消解）。
 */
export function validateRuleExtraction(
  input: RuleExtractionInput,
  output: RuleExtractionOutput,
): RuleExtractionValidation {
  const problems: string[] = [];

  // 输入索引：spanId → span；documentVersionId → bundle。
  const spanById = new Map<string, { documentVersionId: string; quotedText: string | null; quality: string }>();
  const bundleById = new Map<string, { blocksText: string[] }>();
  for (const bundle of input.documentVersions) {
    if (bundleById.has(bundle.documentVersionId)) problems.push("文档版本 ID 重复");
    bundleById.set(bundle.documentVersionId, {
      blocksText: bundle.blocks.map((b) => b.text),
    });
    for (const span of bundle.spans) {
      if (spanById.has(span.id)) problems.push("来源片段 ID 重复");
      spanById.set(span.id, {
        documentVersionId: span.documentVersionId,
        quotedText: span.quotedText,
        quality: span.extractionQuality,
      });
    }
  }

  const keys = new Set(output.ruleDrafts.map((d) => d.key));

  // key 唯一性。
  if (keys.size !== output.ruleDrafts.length) {
    problems.push("ruleDrafts 存在重复 key");
  }

  for (const draft of output.ruleDrafts) {
    // 1. EXPLICIT 必须有来源。
    if (draft.classification === "EXPLICIT" && draft.sources.length === 0) {
      problems.push(`EXPLICIT 规则 ${draft.key} 缺少来源（原文没有的信息不得写成 EXPLICIT）`);
    }
    for (const source of draft.sources) {
      const bundle = bundleById.get(source.documentVersionId);
      if (!bundle) {
        problems.push(`规则 ${draft.key} 引用了不存在的 documentVersion ${source.documentVersionId}`);
        continue;
      }
      for (const spanId of source.sourceSpanIds) {
        const span = spanById.get(spanId);
        // 2. spanId 存在性 + 归属一致。
        if (!span) {
          problems.push(`规则 ${draft.key} 引用了不存在的 span ${spanId}（拦编造引用）`);
          continue;
        }
        if (span.documentVersionId !== source.documentVersionId) {
          problems.push(
            `规则 ${draft.key} 的来源声明 ${source.documentVersionId} 与 span ${spanId} 的归属（${span.documentVersionId}）不一致`,
          );
        }
        if (span.quality === "UNPARSED") problems.push(`UNPARSED 片段 ${spanId} 不能作为规则来源`);
        if (draft.classification === "EXPLICIT" && span.quality !== "GOOD") {
          problems.push(`EXPLICIT 规则 ${draft.key} 不能引用低质量或未解析片段 ${spanId}`);
        }
        // 3. quotedText 逐字出现在所属文档 block 文本中。
        if (span.quotedText) {
          const found = (bundleById.get(span.documentVersionId)?.blocksText ?? []).some((text) =>
            text.includes(span.quotedText!),
          );
          if (!found) {
            problems.push(`span ${spanId} 的 quotedText 未逐字出现在所属文档 blocks 中（拦张冠李戴）`);
          }
        }
      }
    }
    // 5. conflictsWith 引用闭合。
    for (const otherKey of draft.conflictsWith) {
      if (otherKey === draft.key) problems.push("规则不能与自身冲突");
      if (!keys.has(otherKey)) {
        problems.push(`规则 ${draft.key} 的 conflictsWith 引用了不存在的 key ${otherKey}`);
        continue;
      }
      const other = output.ruleDrafts.find((d) => d.key === otherKey)!;
      if (!other.conflictsWith.includes(draft.key)) {
        problems.push(`冲突必须互相指向：${draft.key} → ${otherKey}，但 ${otherKey} 未指向 ${draft.key}`);
      }
    }
  }

  // 4. unparsedRanges.spanId 存在性。
  for (const range of output.unparsedRanges) {
    if (!spanById.has(range.spanId)) {
      problems.push(`unparsedRanges 引用了不存在的 span ${range.spanId}`);
    }
  }

  const reportedUnparsed = new Set(output.unparsedRanges.map(r => r.spanId));
  for (const [id, span] of spanById) {
    if (span.quality === "UNPARSED" && !reportedUnparsed.has(id)) {
      problems.push(`UNPARSED 片段 ${id} 必须进入未解析范围，不能隐藏遗漏`);
    }
  }

  // 5. clarification 的 ruleDraftKeys 闭合。
  for (const clarification of output.clarifications) {
    for (const key of clarification.ruleDraftKeys) {
      if (!keys.has(key)) {
        problems.push(`澄清项引用了不存在的 draft key ${key}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
