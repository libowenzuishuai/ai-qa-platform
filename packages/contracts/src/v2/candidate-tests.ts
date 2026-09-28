import {z} from 'zod';
const Value=z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()]);
/** Independent approved examples generate tests; source implementation is not an expected-value oracle. */
export const CandidateTestsInput=z.object({
 language:z.enum(['node','python']),
 modulePath:z.string().max(200).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/).refine(p=>!p.split('/').includes('..')),
 functionName:z.string().max(100).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
 rules:z.array(z.object({id:z.string(),reviewStatus:z.literal('APPROVED'),expectation:z.string().min(1).max(4000)}).strict()).min(1).max(100),
 examples:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),ruleVersionId:z.string(),args:z.array(Value).max(20),expected:Value}).strict()).min(1).max(100),
}).strict();
export const CandidateTestsOutput=z.object({
 generatorVersion:z.literal('approved-examples-v1'),
 files:z.array(z.object({path:z.string().regex(/^aiqa_generated_tests\/[a-zA-Z0-9_.-]+$/),content:z.string().max(200000),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(5),
 exampleIds:z.array(z.string()).min(1).max(100),
 limitations:z.array(z.string()).max(20),
}).strict();
export const CandidateTestsRequest=z.object({schemaVersion:z.literal('1.0'),requestId:z.string(),mode:z.enum(['real','mock']),timeoutMs:z.number().int().min(1000).max(600000),input:CandidateTestsInput}).strict();
export const CandidateTestsResponse=z.object({schemaVersion:z.literal('1.0'),requestId:z.string(),mode:z.enum(['real','mock']),output:CandidateTestsOutput,invocations:z.array(z.unknown()).max(0)}).strict();
