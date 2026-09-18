import type { ModelRepairKind } from "@ai-qa/contracts";

/**
 * 有限格式修复（PRD FR-11：最多两次）。
 * 闭集、按序尝试、每次修复可观察（repairsApplied 记录）；
 * 修不动 → 由调用方抛 MODEL_OUTPUT_INVALID。
 */

export const MAX_REPAIRS = 2;

/** 单次修复动作：返回修复后的文本，或 null 表示不适用。 */
type RepairFn = (raw: string) => string | null;

const REPAIRS: ReadonlyArray<{ kind: ModelRepairKind; apply: RepairFn }> = [
  {
    kind: "bom",
    apply: (raw) => (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : null),
  },
  {
    kind: "code-fence",
    apply: (raw) => {
      const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/m.exec(raw.trim());
      return fence ? fence[1]! : null;
    },
  },
  {
    kind: "trailing-comma",
    apply: (raw) => (/,\s*([}\]])/.test(raw) ? raw.replace(/,\s*([}\]])/g, "$1") : null),
  },
  {
    kind: "truncated-json",
    apply: (raw) => {
      // 启发式：统计未闭合的字符串/括号，补齐闭合符；仅在结果可解析时采用。
      let inString = false;
      let escape = false;
      const stack: string[] = [];
      for (const ch of raw) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          if (inString) escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === "}" || ch === "]") stack.pop();
      }
      let candidate = raw;
      if (inString) candidate += '"';
      if (stack.length === 0) return null;
      candidate += stack.reverse().join("");
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        return null;
      }
    },
  },
];

export interface RepairResult {
  ok: boolean;
  json: unknown;
  repairsApplied: ModelRepairKind[];
}

/**
 * 解析模型原始输出为 JSON，允许至多 MAX_REPAIRS 次闭集修复。
 * 直接 JSON.parse 成功 → 不计修复。
 */
export function parseWithRepairs(rawText: string): RepairResult {
  const attempts: ModelRepairKind[] = [];
  let current = rawText;
  // 第一遍：直接解析。
  try {
    return { ok: true, json: JSON.parse(current), repairsApplied: [] };
  } catch {
    /* 进入修复循环 */
  }
  for (const repair of REPAIRS) {
    if (attempts.length >= MAX_REPAIRS) break;
    const fixed = repair.apply(current);
    if (fixed === null || fixed === current) continue;
    attempts.push(repair.kind);
    current = fixed;
    try {
      return { ok: true, json: JSON.parse(current), repairsApplied: attempts };
    } catch {
      /* 继续下一类修复 */
    }
  }
  return { ok: false, json: undefined, repairsApplied: attempts };
}
