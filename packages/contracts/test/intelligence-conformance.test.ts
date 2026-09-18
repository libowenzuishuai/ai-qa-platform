import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuleExtractionInput,RuleExtractionOutput,CaseGenerationInput,CaseGenerationOutput,validateRuleExtraction,validateCaseGeneration } from '../src/index.js';
const vectors=JSON.parse(readFileSync(new URL('../fixtures/intelligence-conformance.json',import.meta.url),'utf8'));
describe('TS/Python shared conformance',()=>{
 for(const v of vectors) it(v.name,()=>{
  let valid=false;
  try {
   if(v.kind==='rules') valid=validateRuleExtraction(RuleExtractionInput.parse(v.input),RuleExtractionOutput.parse(v.output)).ok;
   else {const input=CaseGenerationInput.parse(v.input);valid=input.approvedRuleVersions.every(r=>r.reviewStatus==='APPROVED') && validateCaseGeneration(input,CaseGenerationOutput.parse(v.output)).ok;}
  } catch {valid=false;}
  expect(valid).toBe(v.valid);
 });
});
