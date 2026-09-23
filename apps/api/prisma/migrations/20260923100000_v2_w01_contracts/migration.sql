-- v2 W01 契约实体（新增表；v1 读写不受影响，v2 模式默认关闭）
CREATE TABLE "V2OracleSpec" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT', "ruleVersionIds" TEXT[] NOT NULL,
    "assertions" JSONB NOT NULL, "semanticCandidates" JSONB NOT NULL DEFAULT '[]',
    "coverageDeclarations" JSONB NOT NULL DEFAULT '[]', "oracleHash" TEXT NOT NULL,
    "supersedesId" TEXT, "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT, "approvedAt" TIMESTAMP(3),
    CONSTRAINT "V2OracleSpec_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2OracleSpec_projectId_version_key" ON "V2OracleSpec"("projectId","version");
CREATE INDEX "V2OracleSpec_projectId_idx" ON "V2OracleSpec"("projectId");
ALTER TABLE "V2OracleSpec" ADD CONSTRAINT "V2OracleSpec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2CapabilityManifest" (
    "id" TEXT NOT NULL, "capabilityId" TEXT NOT NULL, "version" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL, "manifest" JSONB NOT NULL, "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "projectId" TEXT NOT NULL,
    CONSTRAINT "V2CapabilityManifest_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2CapabilityManifest_capabilityId_version_key" ON "V2CapabilityManifest"("capabilityId","version");
ALTER TABLE "V2CapabilityManifest" ADD CONSTRAINT "V2CapabilityManifest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2AdapterInstallation" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "capabilityId" TEXT NOT NULL,
    "capabilityVersion" TEXT NOT NULL, "manifestHash" TEXT NOT NULL, "installedBy" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CHECK', "endpoint" TEXT, "authorization" JSONB,
    CONSTRAINT "V2AdapterInstallation_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2AdapterInstallation_projectId_capabilityId_idx" ON "V2AdapterInstallation"("projectId","capabilityId");
ALTER TABLE "V2AdapterInstallation" ADD CONSTRAINT "V2AdapterInstallation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2HarnessProfile" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "key" TEXT NOT NULL, "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT', "content" JSONB NOT NULL, "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "V2HarnessProfile_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2HarnessProfile_projectId_key_version_key" ON "V2HarnessProfile"("projectId","key","version");
ALTER TABLE "V2HarnessProfile" ADD CONSTRAINT "V2HarnessProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2WorkflowDefinition" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "name" TEXT NOT NULL, "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT', "content" JSONB NOT NULL, "astHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "V2WorkflowDefinition_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2WorkflowDefinition_projectId_name_version_key" ON "V2WorkflowDefinition"("projectId","name","version");
ALTER TABLE "V2WorkflowDefinition" ADD CONSTRAINT "V2WorkflowDefinition_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2ExecutionSession" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "goal" TEXT NOT NULL,
    "oracleSpecId" TEXT NOT NULL, "oracleHash" TEXT NOT NULL, "profileId" TEXT NOT NULL,
    "profileHash" TEXT NOT NULL, "definitionId" TEXT NOT NULL, "definitionVersion" INTEGER NOT NULL,
    "workflowRunId" TEXT, "environmentId" TEXT NOT NULL, "buildId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED', "budget" JSONB NOT NULL, "usage" JSONB NOT NULL DEFAULT '{}',
    "terminationReason" TEXT, "cancelRequestedAt" TIMESTAMP(3), "pauseRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "V2ExecutionSession_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2ExecutionSession_projectId_status_idx" ON "V2ExecutionSession"("projectId","status");
ALTER TABLE "V2ExecutionSession" ADD CONSTRAINT "V2ExecutionSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2StepAttempt" (
    "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "round" INTEGER NOT NULL, "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING', "rationale" TEXT,
    "inputRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "outputRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "progressMarked" BOOLEAN, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2StepAttempt_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2StepAttempt_sessionId_round_phase_key" ON "V2StepAttempt"("sessionId","round","phase");
CREATE INDEX "V2StepAttempt_sessionId_idx" ON "V2StepAttempt"("sessionId");

CREATE TABLE "V2ActionIntent" (
    "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "stepAttemptId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL, "capabilityVersion" TEXT NOT NULL, "inputHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL, "fencingToken" TEXT NOT NULL, "deadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2ActionIntent_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2ActionIntent_sessionId_idempotencyKey_key" ON "V2ActionIntent"("sessionId","idempotencyKey");
CREATE INDEX "V2ActionIntent_sessionId_idx" ON "V2ActionIntent"("sessionId");

CREATE TABLE "V2Invocation" (
    "id" TEXT NOT NULL, "intentId" TEXT NOT NULL, "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING', "businessOutcome" TEXT, "receipt" JSONB,
    "error" JSONB, "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
    CONSTRAINT "V2Invocation_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "V2Invocation_intentId_attemptNo_key" ON "V2Invocation"("intentId","attemptNo");
CREATE INDEX "V2Invocation_intentId_idx" ON "V2Invocation"("intentId");

CREATE TABLE "V2Observation" (
    "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "round" INTEGER NOT NULL, "source" TEXT NOT NULL,
    "observedUrl" TEXT, "evidenceArtifactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "summary" JSONB NOT NULL, "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2Observation_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2Observation_sessionId_round_idx" ON "V2Observation"("sessionId","round");

CREATE TABLE "V2ContextManifest" (
    "id" TEXT NOT NULL, "sessionId" TEXT, "projectId" TEXT NOT NULL,
    "retrievalStrategy" TEXT NOT NULL, "selections" JSONB NOT NULL, "budget" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL, "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2ContextManifest_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2ContextManifest_projectId_idx" ON "V2ContextManifest"("projectId");
ALTER TABLE "V2ContextManifest" ADD CONSTRAINT "V2ContextManifest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2CoverageLedger" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "oracleSpecId" TEXT NOT NULL,
    "entries" JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "V2CoverageLedger_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2CoverageLedger_projectId_oracleSpecId_idx" ON "V2CoverageLedger"("projectId","oracleSpecId");
ALTER TABLE "V2CoverageLedger" ADD CONSTRAINT "V2CoverageLedger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2Finding" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "oracleSpecId" TEXT, "ruleVersionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate', "expected" TEXT NOT NULL, "actual" TEXT NOT NULL,
    "firstFailure" JSONB NOT NULL, "hypotheses" JSONB NOT NULL DEFAULT '[]',
    "minimalReproduction" JSONB, "severity" JSONB, "dedupeKey" TEXT NOT NULL,
    "buildId" TEXT NOT NULL, "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2Finding_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2Finding_projectId_dedupeKey_idx" ON "V2Finding"("projectId","dedupeKey");
ALTER TABLE "V2Finding" ADD CONSTRAINT "V2Finding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2MemoryUsage" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "memoryRecordId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL, "retrieved" BOOLEAN NOT NULL DEFAULT true,
    "decision" TEXT NOT NULL, "reason" TEXT NOT NULL, "outcome" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2MemoryUsage_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2MemoryUsage_projectId_memoryRecordId_idx" ON "V2MemoryUsage"("projectId","memoryRecordId");
ALTER TABLE "V2MemoryUsage" ADD CONSTRAINT "V2MemoryUsage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2TestPatch" (
    "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "origin" JSONB NOT NULL,
    "repositoryUrl" TEXT NOT NULL, "commitSha" TEXT NOT NULL, "files" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft', "execution" JSONB NOT NULL, "validity" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2TestPatch_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2TestPatch_projectId_idx" ON "V2TestPatch"("projectId");
ALTER TABLE "V2TestPatch" ADD CONSTRAINT "V2TestPatch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "V2EvaluationTrial" (
    "id" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL, "sessionId" TEXT, "firstResult" TEXT NOT NULL,
    "finalResult" TEXT NOT NULL, "humanInterventionMinutes" DOUBLE PRECISION,
    "costMicros" INTEGER, "latencyMs" INTEGER NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "V2EvaluationTrial_pkey" PRIMARY KEY ("id"));
CREATE INDEX "V2EvaluationTrial_campaignId_idx" ON "V2EvaluationTrial"("campaignId");
ALTER TABLE "V2EvaluationTrial" ADD CONSTRAINT "V2EvaluationTrial_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
