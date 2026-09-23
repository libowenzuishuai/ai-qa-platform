import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as c from "../src/index.js";

// Author fields once in Zod. Generated JSON Schema and Python models must not be edited.
const schemas = {
  SourceClassificationInput: c.SourceClassificationInput,
  SourceClassificationOutput: c.SourceClassificationOutput,
  SourceClassificationRequest: c.SourceClassificationRequest,
  SourceClassificationResponse: c.SourceClassificationResponse,
  PlanProposalInput: c.PlanProposalInput,
  PlanProposalOutput: c.PlanProposalOutput,
  PlanProposalRequest: c.PlanProposalRequest,
  PlanProposalResponse: c.PlanProposalResponse,
  ParsedDocumentBundle: c.ParsedDocumentBundle,
  RuleExtractionInput: c.RuleExtractionInput,
  RuleExtractionOutput: c.RuleExtractionOutput,
  CaseGenerationInput: c.CaseGenerationInput,
  CaseGenerationOutput: c.CaseGenerationOutput,
  ModelResponse: c.ModelResponse,
  TextModelRequest: c.TextModelRequest,
  VisionModelRequest: c.VisionModelRequest,
  DocumentParseInput: c.DocumentParseInput,
  DocumentParseRequest: c.DocumentParseRequest,
  DocumentParseResponse: c.DocumentParseResponse,
  RuleExtractionRequest: c.RuleExtractionRequest,
  RuleExtractionResponse: c.RuleExtractionResponse,
  CaseGenerationRequest: c.CaseGenerationRequest,
  CaseGenerationResponse: c.CaseGenerationResponse,
  InvocationRecord: c.InvocationRecord,
  SourceChange: c.SourceChange,
  SourceComparisonInput: c.SourceComparisonInput,
  SourceChangeReport: c.SourceChangeReport,
  ImpactAnalysisInput: c.ImpactAnalysisInput,
  ImpactAnalysisOutput: c.ImpactAnalysisOutput,
  ChangeReviewAnalysisInput:c.ChangeReviewAnalysisInput,ChangeReviewAnalysisOutput:c.ChangeReviewAnalysisOutput,
  ChangeReviewAnalysisRequest:c.ChangeReviewAnalysisRequest,ChangeReviewAnalysisResponse:c.ChangeReviewAnalysisResponse,
  // R00/R03：长文档分块（TS/Python 统一码点偏移与对账规则）
  SpanSlice: c.SpanSlice,
  DocumentChunk: c.DocumentChunk,
  ChunkManifest: c.ChunkManifest,
  ChunkCoverageReport: c.ChunkCoverageReport,
  ChunkingRequest: c.ChunkingRequest,
  ChunkingResponse: c.ChunkingResponse,
  // v2（W01 冻结；语义 refine 为 TS 权威层，跨语言一致性以形状向量为准）
  V2OracleSpec: c.OracleSpec,
  V2CapabilityManifest: c.CapabilityManifest,
  V2AdapterInstallation: c.AdapterInstallation,
  V2HarnessProfileVersion: c.HarnessProfileVersion,
  V2WorkflowDefinition: c.WorkflowDefinition,
  V2ExecutionSession: c.ExecutionSession,
  V2SessionBudget: c.SessionBudget,
  V2SessionUsage: c.SessionUsage,
  V2ActionIntent: c.ActionIntent,
  V2EffectReceipt: c.EffectReceipt,
  V2Invocation: c.Invocation,
  V2ObservationSnapshot: c.ObservationSnapshot,
  V2ContextManifest: c.ContextManifest,
  V2CoverageLedger: c.CoverageLedger,
  V2Finding: c.Finding,
  V2MemoryUsage: c.MemoryUsage,
  V2TestPatch: c.TestPatch,
  V2EvaluationTrial: c.EvaluationTrial,
  V2CapabilityRpcEnvelope: c.CapabilityRpcEnvelope,
  V2RemoteExecuteRequest: c.RemoteExecuteRequest,
  V2RemoteCapabilityResult: c.RemoteCapabilityResult,
  ContextRetrievalRequest: c.ContextRetrievalRequest,
  ContextRetrievalResponse: c.ContextRetrievalResponse,
  ContextRetrievalInput: c.ContextRetrievalInput,
  ContextRetrievalOutput: c.ContextRetrievalOutput,
  // R02：快照对比（确定性多文件差异）
  MultiFileComparisonInput: c.MultiFileComparisonInput,
  MultiFileChangeReport: c.MultiFileChangeReport,
  SnapshotCompareRequest: c.SnapshotCompareRequest,
  SnapshotCompareResponse: c.SnapshotCompareResponse,
  // R08：目标规划 agent
  GoalProposalAgentInput: c.GoalProposalAgentInput,
  GoalProposalAgentOutput: c.GoalProposalAgentOutput,
  GoalProposalAgentRequest: c.GoalProposalAgentRequest,
  GoalProposalAgentResponse: c.GoalProposalAgentResponse,
  SnapshotFileEntry:c.SnapshotFileEntry,RepositorySnapshotManifest:c.RepositorySnapshotManifest,SnapshotDiffInput:c.SnapshotDiffInput,SnapshotFileChange:c.SnapshotFileChange,SnapshotDiffReport:c.SnapshotDiffReport,
};
const schema = zodToJsonSchema(z.object(schemas), {
  name: "IntelligenceContracts",
  definitions: schemas,
  target: "jsonSchema7",
  $refStrategy: "root",
});
const output = JSON.stringify(schema, null, 2) + "\n";
const directory = fileURLToPath(
  new URL(
    "../../../services/intelligence/src/aiqa_intelligence/contracts/",
    import.meta.url,
  ),
);
const path = directory + "schema.v1.json";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error("跨语言 schema 已过期：运行 pnpm contracts:export");
} else {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, output);
}
