import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as c from '../src/index.js';

// Author fields once in Zod. Generated JSON Schema and Python models must not be edited.
const schemas = {
  SourceClassificationInput:c.SourceClassificationInput,SourceClassificationOutput:c.SourceClassificationOutput,
  SourceClassificationRequest:c.SourceClassificationRequest,SourceClassificationResponse:c.SourceClassificationResponse,
  PlanProposalInput: c.PlanProposalInput, PlanProposalOutput: c.PlanProposalOutput,
  PlanProposalRequest: c.PlanProposalRequest, PlanProposalResponse: c.PlanProposalResponse,
  ParsedDocumentBundle: c.ParsedDocumentBundle,
  RuleExtractionInput: c.RuleExtractionInput, RuleExtractionOutput: c.RuleExtractionOutput,
  CaseGenerationInput: c.CaseGenerationInput, CaseGenerationOutput: c.CaseGenerationOutput,
  ModelResponse: c.ModelResponse, TextModelRequest: c.TextModelRequest, VisionModelRequest: c.VisionModelRequest,
  DocumentParseInput: c.DocumentParseInput,
  DocumentParseRequest: c.DocumentParseRequest, DocumentParseResponse: c.DocumentParseResponse,
  RuleExtractionRequest: c.RuleExtractionRequest, RuleExtractionResponse: c.RuleExtractionResponse,
  CaseGenerationRequest: c.CaseGenerationRequest, CaseGenerationResponse: c.CaseGenerationResponse,
  InvocationRecord: c.InvocationRecord,
};
const schema = zodToJsonSchema(z.object(schemas), {
  name: 'IntelligenceContracts', definitions: schemas, target: 'jsonSchema7', $refStrategy: 'root',
});
const output = JSON.stringify(schema, null, 2) + '\n';
const directory = fileURLToPath(new URL('../../../services/intelligence/src/aiqa_intelligence/contracts/', import.meta.url));
const path = directory + 'schema.v1.json';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw new Error('跨语言 schema 已过期：运行 pnpm contracts:export');
} else {
  mkdirSync(directory, { recursive: true }); writeFileSync(path, output);
}
