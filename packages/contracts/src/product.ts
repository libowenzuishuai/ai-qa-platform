import { z } from 'zod';
import { ObservedLocator, PlanAction, PlanValue, TargetBinding } from './test-plan.js';
import { TestCaseVersion } from './test-case.js';

export const EnvironmentRuntime = z.object({
  secretRefs: z.record(z.string().regex(/^[a-zA-Z][\w-]*$/), z.object({
    usernameEnv: z.string().regex(/^AIQA_TARGET_[A-Z0-9_]+$/).optional(),
    passwordEnv: z.string().regex(/^AIQA_TARGET_[A-Z0-9_]+$/).optional(),
  })).default({}),
  dataRefs: z.record(z.string(), z.string().max(2000)).default({}),
  fixture: z.enum(['none', 'demo']).default('none'),
  buildProbe: z.object({ path: z.string().regex(/^\/(?!\/)[^\\\x00-\x1f]*$/), field: z.string().regex(/^[a-zA-Z][\w.]*$/) }).optional(),
}).strict();

const SetupAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fill'), locator: ObservedLocator, value: PlanValue }),
  z.object({ type: z.literal('click'), locator: ObservedLocator }),
]);
export const ObservationRequest = z.object({
  environmentId: z.string().min(1),
  pages: z.array(z.object({
    role: z.string().min(1), path: z.string().regex(/^\/(?!\/)[^\\\x00-\x1f]*$/),
    setup: z.array(SetupAction).max(30).default([]),
  })).min(1).max(12),
  allowWrites: z.boolean().default(false),
}).strict().refine(x => x.allowWrites || x.pages.every(p => p.setup.length === 0), '准备操作需要明确允许写入');
export const ObservationBundle = z.object({
  environmentId: z.string(), environmentRevision: z.number().int(),
  bindings: z.array(TargetBinding).max(1200),
  pages: z.array(z.object({ role: z.string(), url: z.string().url(), title: z.string(), text: z.string().max(20000) })).max(12),
});
export const PlanProposalInput = z.object({
  testCase: TestCaseVersion,
  observation: ObservationBundle,
  promptVersion: z.literal('planner-v3'),
});
// Business expectations belong in assertions, never prerequisite waits that mask failures.
const PlannerAction = z.union([
  PlanAction.options[0], PlanAction.options[1], PlanAction.options[2], PlanAction.options[3],
  PlanAction.options[4], PlanAction.options[5],
  PlanAction.options[7],
]);
export const PlanProposalOutput = z.object({
  actions: z.array(PlannerAction).max(100),
  targets: z.array(z.object({ assertionId: z.string(), targetRef: z.string() })),
  blockedReasons: z.array(z.string()).default([]),
});
export const GitConnectionRequest = z.object({
  url: z.string().url().refine(v => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(v), '仅支持 GitHub HTTPS 仓库地址'),
  ref: z.string().min(1).max(200).default('HEAD'),
  subdirectory: z.string().max(300).default('').refine(v => !v.startsWith('/') && !v.split('/').includes('..') && !v.includes('\\')),
}).strict();
export const MissionRequest = z.object({
  title: z.string().trim().min(1).max(200), goal: z.string().trim().min(1).max(4000),
  template: z.enum(['RELEASE', 'REGRESSION', 'HEALTH', 'RETEST']),
  baselineId: z.string().min(1), environmentId: z.string().min(1), contextSnapshotId: z.string().optional(),
  exclusions: z.array(z.string().min(1)).max(100).default([]),
}).strict();

export const ApiRequestTemplate = z.object({
  name: z.string().min(1).max(200),
  method: z.enum(['GET','POST','PUT','PATCH','DELETE']),
  path: z.string().regex(/^\/(?!\/)[^\\\x00-\x1f]*$/),
  body: z.record(z.string(), z.union([z.string(),z.number(),z.boolean()])).optional(),
  credentialRef: z.string().regex(/^[a-zA-Z][\w-]*\.(username|password)$/).optional(),
  responseField: z.string().regex(/^(status|body(?:\.[a-zA-Z0-9_-]+)*)$/),
  timeoutMs: z.number().int().min(100).max(30000).default(10000),
}).strict();

export const CodeCheckRequest = z.object({
  repositoryUrl: GitConnectionRequest.shape.url,
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  subdirectory: GitConnectionRequest.shape.subdirectory,
  kind: z.enum(['NODE_TEST','PYTHON_TEST','NODE_BUILD']),
  timeoutSeconds: z.number().int().min(10).max(600).default(120),
  installDependencies: z.boolean().default(false),
}).strict();
export const RunnerResult = z.object({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  exitCode: z.number().int(),
  cases: z.array(z.object({name:z.string().min(1).max(500),status:z.enum(['PASS','FAIL','SKIP']),detail:z.string().max(2000).optional()})).max(10000),
  output: z.string().max(200000),
  platformError: z.string().max(2000).optional(),
}).strict();

export const SourceClassificationInput = z.object({
  files: z.array(z.object({path:z.string().min(1),format:z.string(),excerpt:z.string().max(2000)})).max(50),
  promptVersion:z.literal('sources-v1'),
});
export const SourceClassificationOutput = z.object({
  files:z.array(z.object({path:z.string().min(1),category:z.enum(['BUSINESS_CANDIDATE','API_CONTRACT','RUNTIME_CLUE','TEST_CLUE','UNCLASSIFIED']),reason:z.string().min(1).max(500)})).max(50),
});
