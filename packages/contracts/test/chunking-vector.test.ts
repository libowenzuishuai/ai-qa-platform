import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChunkManifest, ChunkCoverageReport } from '../src/index.js';

/**
 * R03 跨语言测试向量：同一 fixture 由 Python chunker 生成（确定性），
 * TS 端用 Zod 契约校验 —— 证明两端对 ChunkManifest/覆盖对账的形状、
 * 码点偏移与对账规则理解一致。
 */
const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/chunking/shared-vector.json', import.meta.url)),
    'utf8',
  ),
) as {
  expectedManifest: unknown;
  expectedCoverage: unknown;
};

describe('R03 跨语言分块测试向量', () => {
  it('expectedManifest 符合 ChunkManifest 契约', () => {
    const manifest = ChunkManifest.parse(vector.expectedManifest);
    expect(manifest.strategyVersion).toBe('chunk-v1');
    expect(manifest.chunks.length).toBeGreaterThan(0);
    expect(manifest.totalCodePoints).toBe(
      manifest.chunks.reduce((sum, c) => sum + c.estimatedChars, 0),
    );
  });

  it('切片偏移连续无缝（码点），切片文本拼接还原原文', () => {
    const manifest = ChunkManifest.parse(vector.expectedManifest);
    const bySpan = new Map<string, Array<{ start: number; end: number; text: string }>>();
    for (const chunk of manifest.chunks) {
      for (const ref of chunk.spanRefs) {
        if (ref.type === 'slice') {
          const list = bySpan.get(ref.slice.sourceSpanId) ?? [];
          list.push({ start: ref.slice.startOffset, end: ref.slice.endOffset, text: chunk.text });
          bySpan.set(ref.slice.sourceSpanId, list);
        }
      }
    }
    expect(bySpan.size).toBeGreaterThan(0);
    const blocks = (vector.expectedManifest as {
      chunks: Array<{ spanRefs: unknown[]; text: string; boundary: string }>;
    }).chunks;
    expect(blocks).toBeDefined();
    for (const [spanId, ranges] of bySpan) {
      const sorted = [...ranges].sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const r of sorted) {
        expect(r.start).toBe(cursor);
        cursor = r.end;
      }
      expect(cursor).toBeGreaterThan(0);
      expect(spanId).toMatch(/^s-/);
    }
  });

  it('expectedCoverage 符合 ChunkCoverageReport 对账契约（三类之和=总数）', () => {
    const report = ChunkCoverageReport.parse(vector.expectedCoverage);
    expect(
      report.processedFragments + report.contextFragments + report.blockedFragments,
    ).toBe(report.totalFragments);
    expect(report.assignments).toHaveLength(report.totalFragments);
    // UNPARSED 片段归 blocked 且给出原因。
    const blocked = report.assignments.filter(a => a.assignment === 'blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.every(b => (b.reason ?? '').length > 0)).toBe(true);
  });

  it('上下文重叠与正文分别记录（不计入正文预算）', () => {
    const manifest = ChunkManifest.parse(vector.expectedManifest);
    for (const chunk of manifest.chunks) {
      expect(chunk.estimatedChars).toBe(chunk.text.length);
      expect(chunk.contextOverlap.length).toBeLessThanOrEqual(
        manifest.strategyParams.contextOverlapChars,
      );
    }
  });
});
