-- CreateTable
CREATE TABLE "LoginPreparation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "credentialRef" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "successIndicator" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "lastCheckStatus" TEXT NOT NULL DEFAULT 'NEVER_CHECKED',
    "lastCheckDetail" TEXT,
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckEnvRev" INTEGER,
    "validityHours" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginPreparation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataPlugin" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "paramSchema" JSONB NOT NULL,
    "effectTypes" TEXT[],
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataPlugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataResource" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "attemptId" TEXT,
    "namespace" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidenceId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "missionId" TEXT,
    "templateVersion" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "budget" JSONB NOT NULL,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "currentGate" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNode" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outputRef" JSONB,
    "humanTodo" JSONB,
    "error" TEXT,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEvent" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginPreparation_projectId_idx" ON "LoginPreparation"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "LoginPreparation_projectId_environmentId_role_key" ON "LoginPreparation"("projectId", "environmentId", "role");

-- CreateIndex
CREATE INDEX "DataPlugin_projectId_idx" ON "DataPlugin"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "DataPlugin_projectId_kind_version_key" ON "DataPlugin"("projectId", "kind", "version");

-- CreateIndex
CREATE INDEX "DataResource_projectId_runId_idx" ON "DataResource"("projectId", "runId");

-- CreateIndex
CREATE INDEX "DataResource_namespace_idx" ON "DataResource"("namespace");

-- CreateIndex
CREATE UNIQUE INDEX "DataResource_namespace_externalRef_action_actionFingerprint_key" ON "DataResource"("namespace", "externalRef", "action", "actionFingerprint");

-- CreateIndex
CREATE INDEX "WorkflowRun_projectId_idx" ON "WorkflowRun"("projectId");

-- CreateIndex
CREATE INDEX "WorkflowNode_workflowId_status_idx" ON "WorkflowNode"("workflowId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowNode_workflowId_nodeKey_idempotencyKey_key" ON "WorkflowNode"("workflowId", "nodeKey", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkflowEvent_workflowId_seq_idx" ON "WorkflowEvent"("workflowId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEvent_workflowId_seq_key" ON "WorkflowEvent"("workflowId", "seq");

-- AddForeignKey
ALTER TABLE "LoginPreparation" ADD CONSTRAINT "LoginPreparation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginPreparation" ADD CONSTRAINT "LoginPreparation_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataPlugin" ADD CONSTRAINT "DataPlugin_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataResource" ADD CONSTRAINT "DataResource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowNode" ADD CONSTRAINT "WorkflowNode_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

