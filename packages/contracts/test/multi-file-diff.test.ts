import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MultiFileComparisonInput,
  MultiFileChangeReport,
} from '../src/index.js';

/**
 * R01 多文件差异契约测试：夹具 vector.json 由 Python compare_files 从
 * old/ new/ 目录生成（synthetic，可复现），TS 端校验输入与预期报告
 * 都符合契约，并核对文件字节 sha256。
 */
const vector = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/multi-file-diff/vector.json', import.meta.url)),
    'utf8',
  ),
) as {
  input: unknown;
  expectedReport: unknown;
  fileChecksums: { old: Record<string, string>; new: Record<string, string> };
};

describe('R01 多文件快照差异契约', () => {
  it('输入符合 MultiFileComparisonInput（含排除路径）', () => {
    const input = MultiFileComparisonInput.parse(vector.input);
    expect(input.oldFiles.length).toBeGreaterThan(0);
    expect(input.newFiles.length).toBeGreaterThan(0);
    expect(input.excludedPaths).toContain('requirements/payment.md');
  });

  it('预期报告符合 MultiFileChangeReport（对账/闭集/必填理由）', () => {
    const report = MultiFileChangeReport.parse(vector.expectedReport);
    const t = report.totals;
    expect(t.modified).toBe(1);
    expect(t.renamed).toBe(1);
    expect(t.added).toBe(1);
    expect(t.removed).toBe(1);
    // 覆盖对账：结局覆盖的旧/新路径数与输入一致。
    const coveredOld = new Set(report.outcomes.map(o => o.oldPath).filter(Boolean));
    const coveredNew = new Set(report.outcomes.map(o => o.newPath).filter(Boolean));
    expect(coveredOld.size).toBe(t.oldFiles);
    expect(coveredNew.size).toBe(t.newFiles);
    // modified 内嵌片段级报告（单文件口径）。
    const modified = report.outcomes.find(o => o.kind === 'modified')!;
    expect(modified.fragmentReport).not.toBeNull();
    // renamed 必须是不同路径。
    const renamed = report.outcomes.find(o => o.kind === 'renamed')!;
    expect(renamed.oldPath).not.toBe(renamed.newPath);
  });

  it('排除范围漂移被标记', () => {
    const report = MultiFileChangeReport.parse(vector.expectedReport);
    expect(report.exclusionsChanged).toBe(true);
    expect(report.truncated).toBe(false);
  });

  it('重复路径被契约拒绝', () => {
    const input = MultiFileComparisonInput.parse(vector.input);
    const bad = {
      ...input,
      oldFiles: [...input.oldFiles, input.oldFiles[0]!],
    };
    expect(MultiFileComparisonInput.safeParse(bad).success).toBe(false);
  });

  it('结局计数与明细不一致被契约拒绝', () => {
    const report = MultiFileChangeReport.parse(vector.expectedReport);
    const bad = { ...report, totals: { ...report.totals, modified: 99 } };
    expect(MultiFileChangeReport.safeParse(bad).success).toBe(false);
    const bad2 = {
      ...report,
      outcomes: report.outcomes.slice(0, report.outcomes.length - 1),
    };
    expect(MultiFileChangeReport.safeParse(bad2).success).toBe(false);
  });

  it('文件字节 sha256 与夹具目录一致（可复现性）', () => {
    for (const side of ['old', 'new'] as const) {
      for (const [path, checksum] of Object.entries(vector.fileChecksums[side])) {
        const content = readFileSync(
          fileURLToPath(new URL(`../fixtures/multi-file-diff/${side}/${path}`, import.meta.url)),
        );
        expect(createHash('sha256').update(content).digest('hex')).toBe(checksum);
      }
    }
  });
});
