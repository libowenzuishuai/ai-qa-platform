import {
  ChangeReviewAnalysisRequest, ChangeReviewAnalysisResponse, DocumentParseRequest, DocumentParseResponse, RuleExtractionRequest, RuleExtractionResponse,
  CaseGenerationRequest, CaseGenerationResponse, PlanProposalRequest, PlanProposalResponse, SourceClassificationRequest, SourceClassificationResponse, ApiErrorBody,
  SnapshotCompareRequest, SnapshotCompareResponse,
  ChunkingRequest, ChunkingResponse, GoalProposalAgentRequest, GoalProposalAgentResponse,
} from '@ai-qa/contracts';
import type { WorkerConfig } from './config.js';

const operations = {
  goal:{path:"/v1/goals/propose",request:GoalProposalAgentRequest,response:GoalProposalAgentResponse},
  changes: {path:"/v1/changes/analyze",request:ChangeReviewAnalysisRequest,response:ChangeReviewAnalysisResponse},
  sources: { path: "/v1/sources/classify", request: SourceClassificationRequest, response: SourceClassificationResponse },
  plan: { path: "/v1/plans/propose", request: PlanProposalRequest, response: PlanProposalResponse },
  document: { path: '/v1/documents/parse', request: DocumentParseRequest, response: DocumentParseResponse },
  rules: { path: '/v1/rules/extract', request: RuleExtractionRequest, response: RuleExtractionResponse },
  cases: { path: '/v1/cases/generate', request: CaseGenerationRequest, response: CaseGenerationResponse },
  snapshot: { path: '/v1/snapshots/compare', request: SnapshotCompareRequest, response: SnapshotCompareResponse },
  chunk: { path: '/v1/documents/chunk', request: ChunkingRequest, response: ChunkingResponse },
} as const;
function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }

/** Python has no DB/queue authority. Validate response again before platform persistence. */
export async function callIntelligence(
  config: WorkerConfig, operation: keyof typeof operations,
  requestId: string, mode: 'real' | 'mock', input: unknown,
) {
  if (!config.intelligenceUrl || !config.intelligenceToken) {
    throw failure('DEPENDENCY_UNAVAILABLE', 'Python 智能服务地址或认证令牌未配置');
  }
  const base = new URL(config.intelligenceUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw failure('VALIDATION_ERROR', '智能服务 URL 不合法');
  }
  const contract = operations[operation];
  const timeoutMs = Math.min(config.intelligenceTimeoutMs ?? 120_000,config.executionBudget?Math.max(1000,config.executionBudget.deadline-Date.now()):600000);
  if(config.executionBudget&&Date.now()>=config.executionBudget.deadline)throw failure('BUDGET_EXCEEDED','工作流预算已到期');
  const request = contract.request.parse({ schemaVersion: '1.0', requestId, mode, timeoutMs, input });
  let response: Response;
  let raw: unknown;
  try {
    response = await fetch(new URL(contract.path, base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs),...(config.executionSignal?[config.executionSignal]:[])]),
      headers: { ...(config.modelInputCharLimit?{'x-aiqa-input-char-limit':String(config.modelInputCharLimit)}:{}), 'content-type': 'application/json', authorization: `Bearer ${config.intelligenceToken}`, ...(config.executionBudget?{'x-aiqa-model-calls':String(config.executionBudget.maxModelCalls),'x-aiqa-model-tokens':String(config.executionBudget.maxTokens)}:{}) },
      body: JSON.stringify(request),
    });
    raw = await response.json();
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw failure('MODEL_TIMEOUT', 'Python 智能服务超时');
    }
    throw failure('DEPENDENCY_UNAVAILABLE', 'Python 智能服务不可用或响应不是 JSON');
  }
  if (!response.ok) {
    const parsed = ApiErrorBody.safeParse(raw);
    if (parsed.success && parsed.data.requestId === requestId) throw failure(parsed.data.code, parsed.data.message);
    throw failure('DEPENDENCY_UNAVAILABLE', 'Python 智能服务返回错误');
  }
  const parsed = contract.response.safeParse(raw);
  if (!parsed.success || parsed.data.requestId !== requestId || parsed.data.mode !== mode) {
    throw failure('MODEL_OUTPUT_INVALID', 'Python 智能服务返回契约、请求编号或运行模式不匹配');
  }
  const result = parsed.data;
  if (result.invocations.some(i => (mode === 'mock') !== (i.response.provider === 'mock'))) {
    throw failure('MODEL_OUTPUT_INVALID', 'Python 模型调用记录与运行模式不匹配');
  }
  return result;
}
