import {ChangeReviewAnalysisInput,ChangeReviewAnalysisOutput} from "./source-changes.js";
import { PlanProposalInput, PlanProposalOutput, SourceClassificationInput, SourceClassificationOutput, GoalProposalAgentInput, GoalProposalAgentOutput } from "./product.js";
import { z } from "zod";
import { EntityId } from "./common.js";
import { DocumentFormat, ParsedDocumentBundle } from "./document.js";
import { ChunkingInput, ChunkingOutput } from "./chunking.js";
import { ContextRetrievalInput, ContextRetrievalOutput } from "./v2/context-retrieval.js";
import { LoopPlannerInput, LoopPlannerOutput } from "./v2/loop-planner.js";
import { DecisionRequestInput, DecisionResult } from "./v2/model-routes.js";
import { SnapshotDiffInput, SnapshotDiffReport } from "./snapshot-diff.js";
import { RuleExtractionInput, RuleExtractionOutput } from "./agent-rule.js";
import { CaseGenerationInput, CaseGenerationOutput } from "./agent-case.js";
import { ModelPurpose, ModelResponse } from "./model-adapter.js";

/** TS/Python wire protocol. Keep Zod as the sole authored schema during migration. */
export const INTELLIGENCE_SCHEMA_VERSION = "1.0" as const;
export const DocumentParseInput = z.object({
  documentVersionId: EntityId,
  format: DocumentFormat,
  storageKey: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  fileSizeBytes: z.number().int().min(1).max(20 * 1024 * 1024),
});
export type DocumentParseInput = z.infer<typeof DocumentParseInput>;
const requestBase = z.object({
  schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
  requestId: EntityId,
  mode: z.enum(["real", "mock"]),
  timeoutMs: z.number().int().min(1000).max(600_000),
});
export const DocumentParseRequest = requestBase.extend({ input: DocumentParseInput });
export const RuleExtractionRequest = requestBase.extend({ input: RuleExtractionInput });
export const CaseGenerationRequest = requestBase.extend({ input: CaseGenerationInput });
export const InvocationRecord = z.object({
  purpose: ModelPurpose,
  promptVersion: z.string().min(1),
  response: ModelResponse,
});
const responseBase = z.object({
  schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
  requestId: EntityId,
  mode: z.enum(["real", "mock"]),
  invocations: z.array(InvocationRecord),
});
export const DocumentParseResponse = responseBase.extend({ output: ParsedDocumentBundle });
export const RuleExtractionResponse = responseBase.extend({ output: RuleExtractionOutput });
export const CaseGenerationResponse = responseBase.extend({ output: CaseGenerationOutput });

export const PlanProposalRequest = requestBase.extend({ input: PlanProposalInput });
export const PlanProposalResponse = responseBase.extend({ output: PlanProposalOutput });

export const SourceClassificationRequest = requestBase.extend({ input: SourceClassificationInput });
export const SourceClassificationResponse = responseBase.extend({ output: SourceClassificationOutput });


export const DecisionRequest = requestBase.extend({ input: DecisionRequestInput });
export const DecisionResponse = responseBase.extend({ output: DecisionResult });

export const LoopPlannerRequest = requestBase.extend({ input: LoopPlannerInput });
export const LoopPlannerResponse = responseBase.extend({ output: LoopPlannerOutput });

export const ContextRetrievalRequest = requestBase.extend({ input: ContextRetrievalInput });
export const ContextRetrievalResponse = responseBase.extend({ output: ContextRetrievalOutput });

export const GoalProposalAgentRequest = requestBase.extend({ input: GoalProposalAgentInput });
export const GoalProposalAgentResponse = responseBase.extend({ output: GoalProposalAgentOutput });

export const ChangeReviewAnalysisRequest=requestBase.extend({input:ChangeReviewAnalysisInput});
export const ChangeReviewAnalysisResponse=responseBase.extend({output:ChangeReviewAnalysisOutput});

export const ChunkingRequest = requestBase.extend({ input: ChunkingInput });
export const ChunkingResponse = responseBase.extend({ output: ChunkingOutput });

/** R02：快照对比（确定性，不调用模型）。 */
export const SnapshotCompareRequest = requestBase.extend({ input: SnapshotDiffInput });
export const SnapshotCompareResponse = responseBase.extend({ output: SnapshotDiffReport });
