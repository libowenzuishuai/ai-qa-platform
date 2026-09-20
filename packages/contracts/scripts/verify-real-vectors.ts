/** Revalidate recorded real Python outputs through the exact TS persistence contracts. */
import { readFileSync } from 'node:fs';
import { RuleExtractionInput, RuleExtractionOutput, CaseGenerationInput, CaseGenerationOutput, validateRuleExtraction, validateCaseGeneration } from '../src/index.js';
if (!process.argv[2]) throw new Error('Pass one or more recorded .vectors.json files');
let count = 0;
for (const path of process.argv.slice(2)) {
  const vectors = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(vectors) || !vectors.length) throw new Error(`No vectors in ${path}`);
  for (const v of vectors) {
    const result = v.kind === 'rules'
      ? validateRuleExtraction(RuleExtractionInput.parse(v.input), RuleExtractionOutput.parse(v.output))
      : validateCaseGeneration(CaseGenerationInput.parse(v.input), CaseGenerationOutput.parse(v.output));
    if (!result.ok) throw new Error(`${v.name}: ${result.problems.join('; ')}`);
    count++;
  }
}
console.log(JSON.stringify({ passed: count, validator: 'TypeScript persistence contracts' }));
