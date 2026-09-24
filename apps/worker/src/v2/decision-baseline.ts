import {
  DecisionRequestInput,
  DecisionResult,
} from "@ai-qa/contracts";

/**
 * W08 确定性决策基线（INT-06 第一基线，不依赖模型）：
 * 关键词重叠选优；无命中/平局 → 回退（fallbackUsed），不猜。
 */
export function deterministicDecide(input: DecisionRequestInput): DecisionResult {
  // 分词：拉丁词 + CJK bigram（与 Python 检索基线同口径，避免整句成单 token）。
  const tokens = (text: string): Set<string> => {
    const lower = text.toLowerCase();
    const result = new Set<string>();
    for (const word of lower.split(/[^\p{L}\p{N}]+/u)) {
      if (!word) continue;
      if (/^[a-z0-9]+$/u.test(word)) { result.add(word); continue; }
      for (let i = 0; i < word.length - 1; i += 1) result.add(word.slice(i, i + 2));
      if (word.length === 1) result.add(word);
    }
    return result;
  };
  const question = tokens(input.question);
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const option of input.options) {
    const optionTokens = tokens(`${option.label} ${option.context}`);
    let overlap = 0;
    for (const token of question) if (optionTokens.has(token)) overlap += 1;
    if (!best || overlap > best.score) {
      best = { id: option.id, score: overlap };
      tie = false;
    } else if (best && overlap === best.score) {
      tie = true;
    }
  }
  if (!best || best.score === 0 || (tie && input.kind === "choose")) {
    return {
      kind: input.kind,
      selectedOptionId: null,
      score: input.kind === "score" ? 0 : null,
      category: null,
      rawConfidence: null,
      fallbackUsed: true,
      fallbackReason: best?.score === 0 ? "无关键词命中" : "平局无法唯一选择",
    };
  }
  return {
    kind: input.kind,
    selectedOptionId: input.kind === "choose" ? best.id : null,
    score: input.kind === "score" ? best.score / question.size : null,
    category: null,
    rawConfidence: null,
    fallbackUsed: false,
    fallbackReason: null,
  };
}
