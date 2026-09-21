import { z } from 'zod';
import { EntityId, IsoDateTime } from './common.js';

/**
 * R00：长文档处理契约（PRD FR-CTX-04）。
 *
 * ChunkManifest 记录文档 → 分块策略 → 块列表。
 * ChunkCoverageReport 对账：每个片段必须归属处理/上下文/阻塞。
 */

export const ChunkStrategyVersion = z.literal('chunk-v1');

/** 块边界类型（按标题/段落/表格边界优先）。 */
export const ChunkBoundaryKind = z.enum([
  'heading',      // 标题边界
  'paragraph',    // 段落边界
  'table',        // 表格边界（跨页表保留位置）
  'fixed-size',   // 超长段落的强制切分
  'page',         // PDF 页边界
]);

/** 长 span 的切片映射（不改写旧 span）。 */
export const SpanSlice = z.object({
  sourceSpanId: EntityId,
  /** 在原 span 内的 code point 偏移 [start, end)。 */
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  /** 局部引用标识。 */
  sliceId: z.string().min(1),
});

export const DocumentChunk = z.object({
  chunkId: EntityId,
  /** 在 chunk 序列中的顺序（0 起）。 */
  seq: z.number().int().min(0),
  boundary: ChunkBoundaryKind,
  /** 该块包含的文本内容。 */
  text: z.string(),
  /** 与前一块的重叠文本（上下文重叠分别记录）。 */
  contextOverlap: z.string().default(''),
  /** 该块包含的 span 或 span 切片。 */
  spanRefs: z.array(
    z.union([
      z.object({ type: z.literal('span'), spanId: EntityId }),
      z.object({ type: z.literal('slice'), slice: SpanSlice }),
    ]),
  ),
  /** 该块是否为跨页表格的延续部分。 */
  isTableContinuation: z.boolean().default(false),
  /** 估算的字符数（不是精确 token）。 */
  estimatedChars: z.number().int().min(0),
});

export const ChunkManifest = z.object({
  documentVersionId: EntityId,
  strategyVersion: ChunkStrategyVersion,
  /** 文档全文校验和（与 DocumentVersion.checksum 一致）。 */
  documentChecksum: z.string(),
  /** 分块时的模型/预算策略参数。 */
  strategyParams: z.object({
    maxCharsPerChunk: z.number().int().min(500).max(50_000),
    contextOverlapChars: z.number().int().min(0).max(5_000),
    modelBudgetChars: z.number().int().min(1_000).max(200_000),
  }),
  chunks: z.array(DocumentChunk).min(1),
  /** 长度按 Unicode code point 计数（中文/emoji 一致）。 */
  totalCodePoints: z.number().int().min(0),
  createdAt: IsoDateTime,
}).strict().superRefine((m, ctx) => {
  if (m.chunks.some((c, i) => i > 0 && c.seq !== m.chunks[i - 1]!.seq + 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunks'], message: '块序号必须连续' });
  }
});

/** 片段处理状态。 */
export const ChunkProcessingStatus = z.enum([
  'pending',       // 尚未调用模型
  'in_progress',   // 已分配租约，正在处理
  'completed',     // 模型输出通过校验
  'failed',        // 模型输出无效/超时/截断
  'cancelled',     // 取消
]);

/** 覆盖对账报告：每个片段必须有明确归属。 */
export const ChunkCoverageReport = z.object({
  documentVersionId: EntityId,
  chunkManifestChecksum: z.string(),
  totalFragments: z.number().int().min(0),
  processedFragments: z.number().int().min(0),
  contextFragments: z.number().int().min(0),
  blockedFragments: z.number().int().min(0),
  /** 所有片段的归属明细。 */
  assignments: z.array(
    z.object({
      fragmentId: z.string(),
      assignment: z.enum(['processed', 'context', 'blocked']),
      chunkId: EntityId.nullable(),
      reason: z.string().optional(),
    }),
  ),
}).strict().superRefine((r, ctx) => {
  const sum = r.processedFragments + r.contextFragments + r.blockedFragments;
  if (sum !== r.totalFragments) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assignments'],
      message: `覆盖对账失败：${r.processedFragments}+${r.contextFragments}+${r.blockedFragments}≠${r.totalFragments}`,
    });
  }
  if (r.assignments.length !== r.totalFragments) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assignments'],
      message: `归属明细数(${r.assignments.length})与总片段数(${r.totalFragments})不一致`,
    });
  }
});
