-- CreateTable
CREATE TABLE "CapabilityCatalog" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB NOT NULL,
    "effects" TEXT[],
    "requiredRoles" TEXT[],
    "requiresEnvironment" BOOLEAN NOT NULL DEFAULT false,
    "budgetCategory" TEXT NOT NULL DEFAULT 'none',
    "idempotencyStrategy" TEXT NOT NULL DEFAULT 'read_only',
    "recoveryStrategy" TEXT NOT NULL DEFAULT 'read_only',
    "cleanupResponsibility" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId" TEXT,

    CONSTRAINT "CapabilityCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "nodes" JSONB NOT NULL,
    "defaultBudget" JSONB NOT NULL,
    "defaultParallelism" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "environmentId" TEXT,

    CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseDecision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runIds" TEXT[],
    "decision" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" TEXT,
    "evidenceSnapshot" JSONB NOT NULL DEFAULT '{}',
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId" TEXT,

    CONSTRAINT "ReleaseDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalProposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "suggestedTools" JSONB NOT NULL DEFAULT '[]',
    "suggestedScope" JSONB NOT NULL DEFAULT '{}',
    "suggestedBudget" JSONB NOT NULL DEFAULT '{}',
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "environmentId" TEXT,

    CONSTRAINT "GoalProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMemory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "validUntil" TIMESTAMP(3),
    "invalidationTriggers" JSONB NOT NULL DEFAULT '[]',
    "invalidated" BOOLEAN NOT NULL DEFAULT false,
    "invalidatedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId" TEXT,

    CONSTRAINT "ProjectMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosisEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "attemptId" TEXT,
    "category" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "hypotheses" JSONB NOT NULL DEFAULT '[]',
    "suggestions" JSONB NOT NULL DEFAULT '[]',
    "confidence" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId" TEXT,

    CONSTRAINT "DiagnosisEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CapabilityCatalog_projectId_idx" ON "CapabilityCatalog"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityCatalog_projectId_key_version_key" ON "CapabilityCatalog"("projectId", "key", "version");

-- CreateIndex
CREATE INDEX "WorkflowTemplate_projectId_idx" ON "WorkflowTemplate"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_projectId_key_version_key" ON "WorkflowTemplate"("projectId", "key", "version");

-- CreateIndex
CREATE INDEX "ReleaseDecision_projectId_idx" ON "ReleaseDecision"("projectId");

-- CreateIndex
CREATE INDEX "GoalProposal_projectId_idx" ON "GoalProposal"("projectId");

-- CreateIndex
CREATE INDEX "ProjectMemory_projectId_idx" ON "ProjectMemory"("projectId");

-- CreateIndex
CREATE INDEX "DiagnosisEntry_projectId_idx" ON "DiagnosisEntry"("projectId");

-- AddForeignKey
ALTER TABLE "CapabilityCatalog" ADD CONSTRAINT "CapabilityCatalog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityCatalog" ADD CONSTRAINT "CapabilityCatalog_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseDecision" ADD CONSTRAINT "ReleaseDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseDecision" ADD CONSTRAINT "ReleaseDecision_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalProposal" ADD CONSTRAINT "GoalProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalProposal" ADD CONSTRAINT "GoalProposal_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemory" ADD CONSTRAINT "ProjectMemory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMemory" ADD CONSTRAINT "ProjectMemory_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisEntry" ADD CONSTRAINT "DiagnosisEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosisEntry" ADD CONSTRAINT "DiagnosisEntry_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

