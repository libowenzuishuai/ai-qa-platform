import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuleExtractionInput, RuleExtractionOutput, CaseGenerationInput, CaseGenerationOutput } from '../src/index.js';
const root = fileURLToPath(new URL('../fixtures/', import.meta.url));
const read = (dir: string, name: string) => JSON.parse(readFileSync(root + dir + '/' + name, 'utf8'));
const vectors: any[] = [];
for (const dir of ['01-explicit-prd','02-conflict-prd','03-missing-boundary']) {
  const input = RuleExtractionInput.parse({documentVersions:[read(dir,'parsed-bundle.json')],promptVersion:'handoff-1'});
  const output = RuleExtractionOutput.parse(read(dir,'expected-rule-drafts.json'));
  vectors.push({name:dir,kind:'rules',input,output,valid:true});
}
function mutate(name: string, index: number, change: (v: any)=>void) {
  const v = structuredClone(vectors[index]); v.name=name;v.valid=false;change(v);vectors.push(v);
}
mutate('invented-span',0,v=>v.output.ruleDrafts[0].sources[0].sourceSpanIds=['missing']);
mutate('cross-document',0,v=>v.output.ruleDrafts[0].sources[0].documentVersionId='elsewhere');
mutate('quote-not-in-document',0,v=>{v.input.documentVersions[0].spans.forEach((s:any)=>s.quotedText='fabricated quote');});
mutate('duplicate-draft-key',0,v=>v.output.ruleDrafts[1].key=v.output.ruleDrafts[0].key);
mutate('explicit-without-source',0,v=>v.output.ruleDrafts[0].sources=[]);
mutate('one-sided-conflict',1,v=>v.output.ruleDrafts[0].conflictsWith=[]);
mutate('unknown-clarification-key',1,v=>v.output.clarifications[0].ruleDraftKeys=['missing']);
mutate('coverage-count-mismatch',0,v=>v.input.documentVersions[0].coverageSummary.goodSpans=999);
mutate('span-document-mismatch',0,v=>v.input.documentVersions[0].spans[0].documentVersionId='other');
const input = CaseGenerationInput.parse({approvedRuleVersions:[{
 id:'rule-v1',ruleId:'rule-1',version:1,statement:'approval',classification:'INFERRED',role:'applicant',
 action:'submit',expectation:'pending',reviewStatus:'APPROVED',origin:'manual',createdAt:'2026-09-18T00:00:00Z',
}],roles:['applicant'],fixtureCapabilities:['fixture-1'],promptVersion:'handoff-1'});
const output = CaseGenerationOutput.parse({caseDrafts:[{title:'approval',ruleVersionIds:['rule-v1'],roles:['applicant'],dataSpec:{strategy:'create',note:'UI'},
 steps:[{role:'applicant',action:'submit'}],assertions:[{id:'a1',description:'status',kind:'ui.text',ruleVersionId:'rule-v1',operator:'equals',expected:'pending'}],
 cleanup:{strategy:'namespace'},dimensions:['HAPPY_PATH']}],coverageMap:[{ruleVersionId:'rule-v1',caseCount:1,dimensionsCovered:['HAPPY_PATH']}],blockedRequirements:[]});
const index=vectors.length;vectors.push({name:'case-valid',kind:'cases',input,output,valid:true});
mutate('case-foreign-rule',index,v=>v.output.caseDrafts[0].ruleVersionIds=['other']);
mutate('case-forged-role',index,v=>v.output.caseDrafts[0].steps[0].role='admin');
mutate('case-invented-fixture',index,v=>v.output.caseDrafts[0].dataSpec={strategy:'fixture',fixtureId:'other',params:{}});
mutate('case-missing-coverage',index,v=>v.output.coverageMap=[]);
mutate('case-numeric-without-unit',index,v=>{v.output.caseDrafts[0].assertions[0].operator='gt';v.output.caseDrafts[0].assertions[0].expected=500000;});
mutate('case-unapproved-rule',index,v=>v.input.approvedRuleVersions[0].reviewStatus='DRAFT');
writeFileSync(root+'intelligence-conformance.json',JSON.stringify(vectors,null,2)+'\n');
