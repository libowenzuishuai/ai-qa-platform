-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "runtime" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "TestPlanVersion" ADD COLUMN     "environmentId" TEXT,
ADD COLUMN     "environmentRevision" INTEGER;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "buildVerification" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Defect" ADD COLUMN     "assignedTo" TEXT;

-- CreateTable
CREATE TABLE "PlanProposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "caseVersionId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "environmentRevision" INTEGER NOT NULL,
    "plan" JSONB NOT NULL,
    "mode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextSnapshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "subdirectory" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "skipped" JSONB NOT NULL,
    "previousId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContextSource" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "baselineId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "contextSnapshotId" TEXT,
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionRun" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "retestOf" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionRunner" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "capabilities" TEXT[],
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionRunner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeCheck" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "verdict" TEXT NOT NULL DEFAULT 'INCOMPLETE',
    "runnerId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "result" JSONB,
    "evidenceId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanProposal_projectId_idx" ON "PlanProposal"("projectId");

-- CreateIndex
CREATE INDEX "ContextSnapshot_projectId_idx" ON "ContextSnapshot"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ContextSource_snapshotId_path_key" ON "ContextSource"("snapshotId", "path");

-- CreateIndex
CREATE INDEX "Mission_projectId_idx" ON "Mission"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "MissionRun_runId_key" ON "MissionRun"("runId");

-- CreateIndex
CREATE INDEX "MissionRun_missionId_idx" ON "MissionRun"("missionId");

-- CreateIndex
CREATE INDEX "ApiTemplate_projectId_idx" ON "ApiTemplate"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionRunner_tokenHash_key" ON "ExecutionRunner"("tokenHash");

-- CreateIndex
CREATE INDEX "ExecutionRunner_projectId_idx" ON "ExecutionRunner"("projectId");

-- CreateIndex
CREATE INDEX "CodeCheck_projectId_status_idx" ON "CodeCheck"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DefectOccurrence_defectId_runId_attemptId_key" ON "DefectOccurrence"("defectId", "runId", "attemptId");

-- AddForeignKey
ALTER TABLE "PlanProposal" ADD CONSTRAINT "PlanProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanProposal" ADD CONSTRAINT "PlanProposal_caseVersionId_fkey" FOREIGN KEY ("caseVersionId") REFERENCES "TestCaseVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanProposal" ADD CONSTRAINT "PlanProposal_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSnapshot" ADD CONSTRAINT "ContextSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSource" ADD CONSTRAINT "ContextSource_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ContextSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContextSource" ADD CONSTRAINT "ContextSource_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "Baseline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_contextSnapshotId_fkey" FOREIGN KEY ("contextSnapshotId") REFERENCES "ContextSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRun" ADD CONSTRAINT "MissionRun_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionRun" ADD CONSTRAINT "MissionRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiTemplate" ADD CONSTRAINT "ApiTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiTemplate" ADD CONSTRAINT "ApiTemplate_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionRunner" ADD CONSTRAINT "ExecutionRunner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeCheck" ADD CONSTRAINT "CodeCheck_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeCheck" ADD CONSTRAINT "CodeCheck_runnerId_fkey" FOREIGN KEY ("runnerId") REFERENCES "ExecutionRunner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

